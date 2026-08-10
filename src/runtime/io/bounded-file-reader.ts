/** IC01: BoundedFileReader —— 有界文件读取器（stat / range / chunk / 流式哈希 /
 *  abort / 二进制检测 / 单文件限制 / 操作级字节预算）。
 *
 *  不变式：
 *    - RANGE_READ_FULL_ALLOCATION = 0 —— range read 只分配请求长度（受预算约束），
 *      绝不分配整个文件（1 GiB sparse 文件也只分配请求字节）。
 *    - UNBOUNDED_RUNTIME_FILE_READ = 0 —— 全量读取受 maxFileBytes 上限，超出即截断；
 *      单次操作累计字节受 operationBudgetBytes 上限。
 *    - 只读普通文件：目录/FIFO/socket/设备在读取前 stat+fstat 校验拒绝。
 *    - 每个 chunk 边界检查 AbortSignal（中止延迟 ≤ 一个 chunk）。
 *    - 二进制嗅探：前 binaryProbeBytes 字节内出现 NUL 字节判定为二进制。
 *    - 流式 sha256：边读边哈希，不重复遍历、不额外分配。
 */

import { createHash } from "node:crypto"
import { open, stat } from "node:fs/promises"
import { closeSync, openSync, readSync, statSync } from "node:fs"

export const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024
export const DEFAULT_OPERATION_BUDGET_BYTES = 64 * 1024 * 1024
export const DEFAULT_BINARY_PROBE_BYTES = 8 * 1024
export const DEFAULT_CHUNK_SIZE = 64 * 1024

/** 结构化读取错误（非普通文件、预算中止等）——与 transport 错误区分。 */
export class FileReadError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_REGULAR_FILE" | "BUDGET_EXHAUSTED" | "ABORTED",
  ) {
    super(message)
    this.name = "FileReadError"
  }
}

export interface BoundedFileReaderOptions {
  /** 单文件全量读取上限（默认 16 MiB）。 */
  maxFileBytes?: number
  /** 单次操作字节预算（默认 64 MiB）。 */
  operationBudgetBytes?: number
  /** 二进制嗅探采样上限（默认 8 KiB）。 */
  binaryProbeBytes?: number
  /** 顺序读 chunk 大小（默认 64 KiB）。 */
  chunkSize?: number
}

export interface BoundedReadOptions {
  signal?: AbortSignal
  /** 覆盖操作级字节预算。 */
  budgetBytes?: number
  /** 诊断/测试钩子：每读完一个 chunk 调用一次（bytesRead > 0）。 */
  onChunk?: (bytesRead: number, chunkIndex: number) => void
}

export interface BoundedReadResult {
  buffer: Buffer
  /** 实际读取字节数。 */
  byteCount: number
  /** 流式 sha256（仅覆盖已读取字节）。 */
  sha256: string
  /** true = 因 maxFileBytes/预算在到达 EOF 前停止。 */
  truncated: boolean
  /** true = 前 binaryProbeBytes 内检测到 NUL 字节。 */
  binary: boolean
  /** stat.size —— 文件总大小。 */
  totalBytes: number
}

export interface BoundedRangeReadResult {
  buffer: Buffer
  byteCount: number
  sha256: string
  binary: boolean
  /** true = 请求长度超过预算/文件余量，实际读取被截断。 */
  truncated: boolean
  /** stat.size —— 文件总大小。 */
  totalBytes: number
}

export interface FileStatInfo {
  size: number
  isRegular: boolean
  mtimeMs: number
}

/** 读取上限（供调用方决定是否需要走流式窗口路径）。 */
export function readCapBytes(options: BoundedFileReaderOptions = {}): number {
  return options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
}

export class BoundedFileReader {
  readonly maxFileBytes: number
  readonly operationBudgetBytes: number
  readonly binaryProbeBytes: number
  readonly chunkSize: number

  constructor(options: BoundedFileReaderOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.operationBudgetBytes = options.operationBudgetBytes ?? DEFAULT_OPERATION_BUDGET_BYTES
    this.binaryProbeBytes = options.binaryProbeBytes ?? DEFAULT_BINARY_PROBE_BYTES
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
  }

  /** stat —— 拒绝非普通文件（目录/FIFO/socket/设备）。 */
  async stat(path: string): Promise<FileStatInfo> {
    const info = await stat(path)
    return { size: info.size, isRegular: info.isFile(), mtimeMs: info.mtimeMs }
  }

  /** 同步 stat（ContextMap 同步管线用）。 */
  statSync(path: string): FileStatInfo {
    const info = statSync(path)
    return { size: info.size, isRegular: info.isFile(), mtimeMs: info.mtimeMs }
  }

  /** 同步有界读取（同步管线用）：只分配 min(limitBytes, maxFileBytes,
   *  operationBudgetBytes) 字节；返回截断前缀。 */
  readSync(path: string, limitBytes: number): Buffer {
    const info = this.statSync(path)
    if (!info.isRegular) {
      throw new FileReadError(`not a regular file: ${path}`, "NOT_REGULAR_FILE")
    }
    const limit = Math.min(info.size, limitBytes, this.maxFileBytes, this.operationBudgetBytes)
    const fd = openSync(path, "r")
    try {
      const chunks: Buffer[] = []
      const hash = createHash("sha256")
      let position = 0
      while (position < limit) {
        const want = Math.min(this.chunkSize, limit - position)
        const buffer = Buffer.allocUnsafe(want)
        const bytesRead = readSync(fd, buffer, 0, want, position)
        if (bytesRead <= 0) break
        const slice = buffer.subarray(0, bytesRead)
        hash.update(slice)
        chunks.push(slice)
        position += bytesRead
      }
      return Buffer.concat(chunks)
    } finally {
      try {
        closeSync(fd)
      } catch {
        // best-effort close
      }
    }
  }

  /**
   * 有界全量读取：读取 min(stat.size, maxFileBytes, budget) 字节。
   * 顺序 chunk 读 + 流式 sha256 + per-chunk abort + NUL 二进制嗅探。
   */
  async readFile(path: string, options: BoundedReadOptions = {}): Promise<BoundedReadResult> {
    const signal = options.signal
    const budget = options.budgetBytes ?? this.operationBudgetBytes
    const info = await this.stat(path)
    if (!info.isRegular) {
      throw new FileReadError(`not a regular file: ${path}`, "NOT_REGULAR_FILE")
    }
    const limit = Math.min(info.size, this.maxFileBytes, budget)

    try {
      signal?.throwIfAborted()
    } catch {
      throw new FileReadError(`read aborted: ${path}`, "ABORTED")
    }
    const handle = await open(path, "r")
    const chunks: Buffer[] = []
    const hash = createHash("sha256")
    let position = 0
    let chunkIndex = 0
    let binary = false
    let probeRemaining = this.binaryProbeBytes
    try {
      while (position < limit) {
        signal?.throwIfAborted()
        const want = Math.min(this.chunkSize, limit - position)
        const buffer = Buffer.allocUnsafe(want)
        const { bytesRead } = await handle.read(buffer, 0, want, position)
        if (bytesRead <= 0) break
        // 二进制嗅探：只在首个 probe 窗口内检查 NUL。
        if (probeRemaining > 0 && !binary) {
          const probeLen = Math.min(bytesRead, probeRemaining)
          binary = buffer.subarray(0, probeLen).includes(0)
          probeRemaining -= probeLen
        }
        const slice = buffer.subarray(0, bytesRead)
        hash.update(slice)
        chunks.push(slice)
        position += bytesRead
        chunkIndex++
        options.onChunk?.(bytesRead, chunkIndex)
      }
      const truncated = position < info.size
      return {
        buffer: Buffer.concat(chunks),
        byteCount: position,
        sha256: hash.digest("hex"),
        truncated,
        binary,
        totalBytes: info.size,
      }
    } catch (error) {
      if (signal?.aborted) throw new FileReadError(`read aborted: ${path}`, "ABORTED")
      throw error
    } finally {
      await handle.close()
    }
  }

  /**
   * 有界 range 读取：只分配 min(length, budget, size-offset) 字节，绝不分配
   * 整个文件。offset 越界返回空 buffer。
   */
  async readRange(
    path: string,
    offset: number,
    length: number,
    options: BoundedReadOptions = {},
  ): Promise<BoundedRangeReadResult> {
    const signal = options.signal
    const budget = options.budgetBytes ?? this.operationBudgetBytes
    const info = await this.stat(path)
    if (!info.isRegular) {
      throw new FileReadError(`not a regular file: ${path}`, "NOT_REGULAR_FILE")
    }
    const start = Math.max(0, Math.floor(offset))
    const requested = Math.max(0, Math.floor(length))
    if (start >= info.size || requested === 0) {
      return {
        buffer: Buffer.alloc(0),
        byteCount: 0,
        sha256: createHash("sha256").digest("hex"),
        binary: false,
        truncated: false,
        totalBytes: info.size,
      }
    }
    const want = Math.min(requested, budget, info.size - start)
    const truncated = want < requested

    try {
      signal?.throwIfAborted()
    } catch {
      throw new FileReadError(`read aborted: ${path}`, "ABORTED")
    }
    const handle = await open(path, "r")
    const chunks: Buffer[] = []
    const hash = createHash("sha256")
    let position = start
    let remaining = want
    let chunkIndex = 0
    let binary = false
    let probeRemaining = this.binaryProbeBytes
    try {
      while (remaining > 0) {
        signal?.throwIfAborted()
        const take = Math.min(this.chunkSize, remaining)
        const buffer = Buffer.allocUnsafe(take)
        const { bytesRead } = await handle.read(buffer, 0, take, position)
        if (bytesRead <= 0) break
        if (probeRemaining > 0 && !binary) {
          const probeLen = Math.min(bytesRead, probeRemaining)
          binary = buffer.subarray(0, probeLen).includes(0)
          probeRemaining -= probeLen
        }
        const slice = buffer.subarray(0, bytesRead)
        hash.update(slice)
        chunks.push(slice)
        position += bytesRead
        remaining -= bytesRead
        chunkIndex++
        options.onChunk?.(bytesRead, chunkIndex)
      }
      return {
        buffer: Buffer.concat(chunks),
        byteCount: position - start,
        sha256: hash.digest("hex"),
        binary,
        truncated,
        totalBytes: info.size,
      }
    } catch (error) {
      if (signal?.aborted) throw new FileReadError(`read aborted: ${path}`, "ABORTED")
      throw error
    } finally {
      await handle.close()
    }
  }
}
