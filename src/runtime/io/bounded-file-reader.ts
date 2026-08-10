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
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs"

export const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024
export const DEFAULT_OPERATION_BUDGET_BYTES = 64 * 1024 * 1024
export const DEFAULT_BINARY_PROBE_BYTES = 8 * 1024
export const DEFAULT_CHUNK_SIZE = 64 * 1024

/** 结构化读取错误（非普通文件、预算中止、权威拒绝等）——与 transport 错误区分。 */
export class FileReadError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_REGULAR_FILE" | "BUDGET_EXHAUSTED" | "ABORTED" | "AUTHORITY_REJECTED",
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
  /** open 后、读取前校验（fstat isRegular 之后调用）：返回非空描述 →
   *  AUTHORITY_REJECTED；null = 通过。用于关闭 check/open race 的读取侧
   *  （WorkspaceIoAuthority.validateOpenFileCanonical 按 fd 校验 canonical 根）。 */
  validateOpen?: (fd: number) => string | null | Promise<string | null>
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

export interface LineWindowOptions {
  signal?: AbortSignal
  /** 顺序扫描字节上限（定位窗口行；默认 operationBudgetBytes）。
   *  count=Infinity（offset>0 且无 limit）时窗口延伸到 EOF 或本预算耗尽。 */
  scanBudgetBytes?: number
  /** 窗口返回字节上限（默认 maxFileBytes）——range 分配绝不超本值。 */
  maxReturnBytes?: number
  /** 小文件：窗口找到后继续扫描到 EOF（精确 totalLines + 全文件流式哈希）。 */
  scanToEof?: boolean
  /** open 后 fd canonical 校验（同 BoundedReadOptions.validateOpen）。 */
  validateOpen?: (fd: number) => string | null | Promise<string | null>
}

export interface LineWindowResult {
  text: string
  linesCount: number
  totalLines: number | null
  scannedToEof: boolean
  binary: boolean
  /** 已扫描字节的流式 sha256。 */
  sha256: string
  /** 全文件流式哈希（scannedToEof 时可用）。 */
  wholeFileSha256: string | null
  /** true = 扫描预算或返回预算耗尽，结果被截断。 */
  truncated: boolean
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

  /** 同步有界 range 读取（同步管线用）：只分配 min(length, 预算, size-offset)
   *  字节，绝不分配整个文件；offset 越界返回空 buffer。 */
  readSyncRange(
    path: string,
    offset: number,
    length: number,
    options: { validateOpenSync?: (fd: number) => string | null } = {},
  ): Buffer {
    const info = this.statSync(path)
    if (!info.isRegular) {
      throw new FileReadError(`not a regular file: ${path}`, "NOT_REGULAR_FILE")
    }
    const start = Math.max(0, Math.floor(offset))
    const requested = Math.max(0, Math.floor(length))
    if (start >= info.size || requested === 0) return Buffer.alloc(0)
    const want = Math.min(requested, this.maxFileBytes, this.operationBudgetBytes, info.size - start)
    const fd = openSync(path, "r")
    try {
      const fstat = fstatSync(fd)
      if (!fstat.isFile()) {
        throw new FileReadError(`not a regular file (after open): ${path}`, "NOT_REGULAR_FILE")
      }
      if (options.validateOpenSync) {
        const violation = options.validateOpenSync(fd)
        if (violation) throw new FileReadError(violation, "AUTHORITY_REJECTED")
      }
      const buffer = Buffer.allocUnsafe(want)
      const bytesRead = readSync(fd, buffer, 0, want, start)
      return buffer.subarray(0, Math.max(0, bytesRead))
    } finally {
      try {
        closeSync(fd)
      } catch {
        // best-effort close
      }
    }
  }

  /** 同步有界读取（同步管线用）：只分配 min(limitBytes, maxFileBytes,
   *  operationBudgetBytes) 字节；返回截断前缀。 */
  readSync(path: string, limitBytes: number, options: { validateOpenSync?: (fd: number) => string | null } = {}): Buffer {
    const info = this.statSync(path)
    if (!info.isRegular) {
      throw new FileReadError(`not a regular file: ${path}`, "NOT_REGULAR_FILE")
    }
    const limit = Math.min(info.size, limitBytes, this.maxFileBytes, this.operationBudgetBytes)
    const fd = openSync(path, "r")
    try {
      const fstat = fstatSync(fd)
      if (!fstat.isFile()) {
        throw new FileReadError(`not a regular file (after open): ${path}`, "NOT_REGULAR_FILE")
      }
      if (options.validateOpenSync) {
        const violation = options.validateOpenSync(fd)
        if (violation) throw new FileReadError(violation, "AUTHORITY_REJECTED")
      }
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
      // P1-6：open 后 fstat —— 目录/FIFO/socket/设备在 open 后被替换时同样拒绝。
      const fstat = await handle.stat()
      if (!fstat.isFile()) {
        throw new FileReadError(`not a regular file (after open): ${path}`, "NOT_REGULAR_FILE")
      }
      if (options.validateOpen) {
        const violation = await options.validateOpen(handle.fd)
        if (violation) throw new FileReadError(violation, "AUTHORITY_REJECTED")
      }
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
      // P1-6：open 后 fstat + 调用方 fd canonical 校验（check/open race 读取侧闭环）。
      const fstat = await handle.stat()
      if (!fstat.isFile()) {
        throw new FileReadError(`not a regular file (after open): ${path}`, "NOT_REGULAR_FILE")
      }
      if (options.validateOpen) {
        const violation = await options.validateOpen(handle.fd)
        if (violation) throw new FileReadError(violation, "AUTHORITY_REJECTED")
      }
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

  /**
   * 有界行窗口读取（IC01）：顺序扫描计数换行定位窗口，只对窗口字节做
   *  range 分配 —— RANGE_READ_FULL_ALLOCATION = 0 且窗口分配受 maxReturnBytes
   *  上限（极长单行不会导致巨型分配）。
   *
   *  预算：
   *    - 扫描字节受 scanBudgetBytes 上限（count=Infinity 即 offset>0 无 limit
   *      时窗口延伸至 EOF 或预算耗尽，绝不无界扫描）。
   *    - 返回字节受 maxReturnBytes 上限，超出即截断（truncated=true）。
   *    - 扫描预算/返回预算任一耗尽 → truncated=true；scanToEof 语义取消。
   *    - abort 检查每个 chunk 边界。
   *
   *  另有 open 后 fstat（isRegular）+ validateOpen（fd canonical 校验）。
   */
  async readLineWindow(
    path: string,
    startLine: number,
    count: number,
    options: LineWindowOptions = {},
  ): Promise<LineWindowResult> {
    const signal = options.signal
    const scanBudget = options.scanBudgetBytes ?? this.operationBudgetBytes
    const maxReturn = options.maxReturnBytes ?? this.maxFileBytes
    const info = await this.stat(path)
    if (!info.isRegular) {
      throw new FileReadError(`not a regular file: ${path}`, "NOT_REGULAR_FILE")
    }
    try {
      signal?.throwIfAborted()
    } catch {
      throw new FileReadError(`read aborted: ${path}`, "ABORTED")
    }
    const handle = await open(path, "r")
    const hash = createHash("sha256")
    const chunk = Buffer.allocUnsafe(this.chunkSize)
    let lineNumber = 0
    let lineStartByte = 0
    let windowStartByte: number | null = null
    let windowEndByte: number | null = null
    let seenBinary = false
    let probeRemaining = this.binaryProbeBytes
    let scannedToEof = false
    let scanBudgetExhausted = false
    let position = 0
    try {
      const fstat = await handle.stat()
      if (!fstat.isFile()) {
        throw new FileReadError(`not a regular file (after open): ${path}`, "NOT_REGULAR_FILE")
      }
      if (options.validateOpen) {
        const violation = await options.validateOpen(handle.fd)
        if (violation) throw new FileReadError(violation, "AUTHORITY_REJECTED")
      }
      // count=Infinity（offset>0 无 limit）：窗口结束条件永不满足 → 延伸到
      // EOF 或扫描预算耗尽；count 有限时窗口 = 第 startLine..startLine+count-1 行。
      const lastWindowLine = startLine + count - 1
      while (true) {
        signal?.throwIfAborted()
        if (position >= scanBudget) {
          scanBudgetExhausted = true
          break
        }
        const want = Math.min(chunk.length, scanBudget - position)
        const { bytesRead } = await handle.read(chunk, 0, want, position)
        if (bytesRead <= 0) break
        // 二进制嗅探（首个 probe 窗口内的 NUL）。
        if (probeRemaining > 0 && !seenBinary) {
          const probeLen = Math.min(bytesRead, probeRemaining)
          if (chunk.subarray(0, probeLen).includes(0)) seenBinary = true
          probeRemaining -= probeLen
        }
        hash.update(chunk.subarray(0, bytesRead))
        const absoluteEnd = position + bytesRead
        let cursor = 0
        while (cursor < bytesRead) {
          const newline = chunk.indexOf(0x0a, cursor)
          if (newline < 0) break
          const lineEndAbsolute = position + newline + 1
          if (windowStartByte === null && lineNumber === startLine) windowStartByte = lineStartByte
          // 窗口结束 = 窗口最后一行行尾（不含换行）—— 与旧 slice/join 语义一致。
          if (windowEndByte === null && lineNumber === lastWindowLine) {
            windowEndByte = position + newline
          }
          // 始终统计行数（scanToEof 时需要精确 totalLines）。
          lineNumber++
          lineStartByte = lineEndAbsolute
          cursor = newline + 1
        }
        position = absoluteEnd
        // 有界文件 → 窗口找到后继续扫描到 EOF（完整哈希 + 精确行数）。
        if (windowEndByte !== null && !options.scanToEof) break
      }
      scannedToEof = position >= info.size && !scanBudgetExhausted
      const wholeHash = hash.digest("hex")
      if (windowStartByte === null) {
        return {
          text: "",
          linesCount: 0,
          totalLines: scannedToEof ? lineNumber : null,
          scannedToEof,
          binary: seenBinary,
          sha256: wholeHash,
          wholeFileSha256: scannedToEof ? wholeHash : null,
          truncated: scanBudgetExhausted,
        }
      }
      const end = Math.min(windowEndByte ?? position, windowStartByte + maxReturn)
      const windowTruncated = end < (windowEndByte ?? position) || scanBudgetExhausted
      const rangeBuffer = Buffer.allocUnsafe(Math.max(0, end - windowStartByte))
      let readPos = windowStartByte
      let offset = 0
      while (readPos < end) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(rangeBuffer, offset, end - readPos, readPos)
        if (bytesRead <= 0) break
        offset += bytesRead
        readPos += bytesRead
      }
      const text = rangeBuffer.subarray(0, offset).toString("utf-8")
      const split = text.split("\n")
      // 尾部空行不计（与 slice/join 语义对齐）。
      const linesCount = split.length > 0 && split[split.length - 1] === "" ? split.length - 1 : split.length
      return {
        text,
        linesCount,
        totalLines: scannedToEof ? lineNumber + (text.length > 0 && !text.endsWith("\n") ? 1 : 0) : null,
        scannedToEof,
        binary: seenBinary,
        sha256: wholeHash,
        wholeFileSha256: scannedToEof ? wholeHash : null,
        truncated: windowTruncated,
      }
    } catch (error) {
      if (signal?.aborted) throw new FileReadError(`read aborted: ${path}`, "ABORTED")
      throw error
    } finally {
      await handle.close()
    }
  }
}
