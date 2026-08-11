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
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs"

export const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024
export const DEFAULT_OPERATION_BUDGET_BYTES = 64 * 1024 * 1024
export const DEFAULT_BINARY_PROBE_BYTES = 8 * 1024
export const DEFAULT_CHUNK_SIZE = 64 * 1024

/** IC01-R2: Linux 安全 open —— O_NOFOLLOW 拒绝 final-component symlink 的
 *  open（策略层已放行的 in-root symlink 由中间段别名路径承载；final symlink
 *  一律不打开，避免 check/open race 里 symlink 被换入）。非 Linux 平台无
 *  O_NOFOLLOW 时退回 0（fd canonical 校验仍 fail closed 兜底）。 */
const NOFOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0

/** 结构化读取错误（非普通文件、预算中止、权威拒绝、快照变更等）——与 transport 错误区分。 */
export class FileReadError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_REGULAR_FILE" | "BUDGET_EXHAUSTED" | "ABORTED" | "AUTHORITY_REJECTED" | "SNAPSHOT_CHANGED",
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
  /** 每 chunk 回调：报告生产 handle.read 实际使用的 absolute position（读取前）。
   *  position 单调、连续 —— 测试据此直接断言读取区间恰好覆盖一次，禁止自行
   *  累计 bytesRead 推算。同步读取路径同步调用；流式路径 await。 */
  onChunk?: (position: number, bytesRead: number, chunkIndex: number) => void | Promise<void>
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
  /** IC01-R3: expectedHash 专用 —— 传入全文件哈希预算（>0 启用）。窗口扫描后
   *  从同一 fd 继续流式哈希到 EOF/预算，并对 identity/size/mtime 做结束复核
   *  （增长/截断/替换 → SNAPSHOT_CHANGED fail closed）。绝不二次按路径 open。 */
  wholeFileHashBudgetBytes?: number
  /** 每 chunk 回调：与 BoundedReadOptions.onChunk 语义一致 —— 报告生产
   *  handle.read 实际使用的 absolute position（读取前；扫描与哈希续扫均计数，
   *  同一字节只报告一次）。 */
  onChunk?: (position: number, bytesRead: number, chunkIndex: number) => void | Promise<void>
}

export interface LineWindowResult {
  text: string
  linesCount: number
  totalLines: number | null
  scannedToEof: boolean
  binary: boolean
  /** 已扫描字节的流式 sha256。 */
  sha256: string
  /** 全文件流式哈希（scannedToEof 或 wholeFileHashBudgetBytes 覆盖全文件时可用）。 */
  wholeFileSha256: string | null
  /** IC01-R3: 全文件哈希预算是否覆盖整个文件（false → 调用方必须结构化
   *  拒绝 expectedHash 组合，不得退化为窗口哈希）。 */
  wholeFileHashBudgeted: boolean
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
    const fd = openSync(path, constants.O_RDONLY | NOFOLLOW)
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
    const fd = openSync(path, constants.O_RDONLY | NOFOLLOW)
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
    const handle = await open(path, constants.O_RDONLY | NOFOLLOW)
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
        const readPosition = position
        position += bytesRead
        chunkIndex++
        // IC01-R6: await —— onChunk 可返回 Promise；下一 chunk 必须在 resolve
        // 后开始；rejection 由调用方正常接收（不得 unhandled rejection）。
        await options.onChunk?.(readPosition, bytesRead, chunkIndex)
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
    // IC01-R2: want 同时受 requested、operationBudgetBytes、maxFileBytes 与
    // 文件剩余长度约束（maxFileBytes=16 MiB 时 range 绝不可能读到 64 MiB）。
    const want = Math.min(requested, budget, this.maxFileBytes, info.size - start)
    const truncated = want < requested

    try {
      signal?.throwIfAborted()
    } catch {
      throw new FileReadError(`read aborted: ${path}`, "ABORTED")
    }
    const handle = await open(path, constants.O_RDONLY | NOFOLLOW)
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
        const readPosition = position
        position += bytesRead
        remaining -= bytesRead
        chunkIndex++
        // IC01-R6: await —— 同 readFile（Promise 合约）。
        await options.onChunk?.(readPosition, bytesRead, chunkIndex)
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
   * IC01-R3: 原子快照读取（expectedHash 专用）—— 选区/内容读取与全文件
   *  SHA-256 必须来自同一个已验证 fd（禁止先读、关闭、再按路径二次 open）。
   *
   *    - open 后 fstat（dev/ino/size/mtimeMs）作为权威状态；
   *    - 内容读取受 maxFileBytes / budget / 文件余量约束（同 readRange）；
   *    - 全文件哈希只受 operationBudgetBytes 约束（size > budget →
   *      hashBudgeted=false，调用方必须结构化拒绝该组合）；
   *    - 读取完成后再次 fstat 复核 identity/size/mtime —— 增长、截断、
   *      替换（mtime 变化）→ SNAPSHOT_CHANGED（fail closed）。
   *
   *  range=null → 全量内容（≤ maxFileBytes）；range 给出字节区间。
   */
  async readAtomicSnapshot(
    path: string,
    range: { start: number; length: number } | null,
    options: BoundedReadOptions = {},
  ): Promise<{
    buffer: Buffer
    byteCount: number
    wholeFileSha256: string
    hashBudgeted: boolean
    totalBytes: number
    binary: boolean
    truncated: boolean
  }> {
    const signal = options.signal
    const budget = options.budgetBytes ?? this.operationBudgetBytes
    // open 前 stat 仅用于“不存在/非普通文件”的早期错误映射；权威状态一律以
    // open 后 fstat（bigint）为准。
    const info = await this.stat(path)
    if (!info.isRegular) {
      throw new FileReadError(`not a regular file: ${path}`, "NOT_REGULAR_FILE")
    }
    try {
      signal?.throwIfAborted()
    } catch {
      throw new FileReadError(`read aborted: ${path}`, "ABORTED")
    }
    const handle = await open(path, constants.O_RDONLY | NOFOLLOW)
    try {
      const fstat = await handle.stat({ bigint: true })
      if (!fstat.isFile()) {
        throw new FileReadError(`not a regular file (after open): ${path}`, "NOT_REGULAR_FILE")
      }
      if (options.validateOpen) {
        const violation = await options.validateOpen(handle.fd)
        if (violation) throw new FileReadError(violation, "AUTHORITY_REJECTED")
      }
      // 打开后 fstat 是权威状态（bigint）：dev / ino / size / mtimeNs / ctimeNs。
      const identity = {
        dev: fstat.dev,
        ino: fstat.ino,
        size: fstat.size,
        mtimeNs: fstat.mtimeNs,
        ctimeNs: fstat.ctimeNs,
      }
      const fileSize = Number(identity.size)

      // 全文件哈希预算不足 → 不做无意义读取，直接拒绝该组合。
      // （size === budget 恰好相等时必须正常返回选区 —— 单遍读取只消费 size
      // 字节，同一字节绝不重复读取/重复计费。）
      if (identity.size > BigInt(budget)) {
        return {
          buffer: Buffer.alloc(0),
          byteCount: 0,
          wholeFileSha256: "",
          hashBudgeted: false,
          totalBytes: fileSize,
          binary: false,
          truncated: false,
        }
      }

      // 选区复制边界（分配上限 = min(requested, maxFileBytes)，与 readRange
      // 语义一致；单遍读取下复制不产生额外 I/O）。
      let copyFrom = 0
      let copyLen = 0
      let truncated = false
      if (range) {
        const start = Math.max(0, Math.floor(range.start))
        const requested = Math.max(0, Math.floor(range.length))
        if (start >= fileSize || requested === 0) {
          copyFrom = 0
          copyLen = 0
          truncated = false
        } else {
          const selCap = Math.min(requested, this.maxFileBytes)
          copyFrom = start
          copyLen = Math.min(selCap, fileSize - start)
          truncated = copyLen < requested
        }
      } else {
        copyLen = Math.min(fileSize, this.maxFileBytes)
        truncated = copyLen < fileSize
      }

      // ── IC01-R4：真正单遍读取。从同一已验证 fd 顺序遍历一次；每个 chunk
      // 同时 (a) 更新全文件 SHA-256，(b) 复制与请求选区重叠的有限字节，
      // (c) 前 binaryProbeBytes 二进制嗅探。同一字节只读一次、只计费一次。
      const hash = createHash("sha256")
      const chunk = Buffer.allocUnsafe(this.chunkSize)
      const selection: Buffer[] = []
      let copied = 0
      let binary = false
      let probeRemaining = this.binaryProbeBytes
      let position = 0
      let chunkIndex = 0
      while (position < fileSize) {
        signal?.throwIfAborted()
        const take = Math.min(chunk.length, fileSize - position)
        const { bytesRead } = await handle.read(chunk, 0, take, position)
        if (bytesRead <= 0) {
          // 文件在读取期间缩短：读取少于权威 size → fail closed。
          throw new FileReadError(`file changed while being read: ${path}`, "SNAPSHOT_CHANGED")
        }
        if (probeRemaining > 0 && !binary) {
          const probeLen = Math.min(bytesRead, probeRemaining)
          binary = chunk.subarray(0, probeLen).includes(0)
          probeRemaining -= probeLen
        }
        hash.update(chunk.subarray(0, bytesRead))
        // 选区重叠复制（仅复制有限重叠字节；chunk 复用后视图失效，必须拷贝）。
        const chunkStart = position
        const chunkEnd = position + bytesRead
        const overlapStart = Math.max(chunkStart, copyFrom)
        const overlapEnd = Math.min(chunkEnd, copyFrom + copyLen)
        if (overlapStart < overlapEnd) {
          selection.push(Buffer.from(chunk.subarray(overlapStart - chunkStart, overlapEnd - chunkStart)))
          copied += overlapEnd - overlapStart
        }
        position = chunkEnd
        chunkIndex++
        // IC01-R4: await 钩子 —— 测试可在 chunk 边界确定性同步改写文件。
        await options.onChunk?.(chunkStart, bytesRead, chunkIndex)
      }
      const wholeFileSha256 = hash.digest("hex")

      // ── 最终 fstat（bigint）：dev / ino / size / mtimeNs / ctimeNs 必须与
      // open 时一致（增长、截断、替换、同大小原地改写 → SNAPSHOT_CHANGED）。
      // 最终 fstat 之后不得再从文件读取任何返回内容。
      const end = await handle.stat({ bigint: true })
      if (
        end.dev !== identity.dev ||
        end.ino !== identity.ino ||
        end.size !== identity.size ||
        end.mtimeNs !== identity.mtimeNs ||
        end.ctimeNs !== identity.ctimeNs
      ) {
        throw new FileReadError(`file changed while being read: ${path}`, "SNAPSHOT_CHANGED")
      }
      return {
        buffer: Buffer.concat(selection),
        byteCount: copied,
        wholeFileSha256,
        hashBudgeted: true,
        totalBytes: fileSize,
        binary,
        truncated,
      }
    } catch (error) {
      if (signal?.aborted) throw new FileReadError(`read aborted: ${path}`, "ABORTED")
      throw error
    } finally {
      await handle.close()
    }
  }

  /**
   * IC01-R2: 流式全文件 SHA-256（expectedHash 专用）—— 不保留文件内容，
   * 边读边哈希；文件大小超过预算时返回 budgeted=false（调用方必须结构化
   * 拒绝该组合，绝不静默降级成窗口/range 哈希）。O_NOFOLLOW + fstat +
   * validateOpen（fd canonical 校验）与其余读取路径一致。
   */
  async hashWholeFile(
    path: string,
    options: BoundedReadOptions = {},
  ): Promise<{ sha256: string; totalBytes: number; budgeted: boolean }> {
    const signal = options.signal
    const budget = options.budgetBytes ?? this.operationBudgetBytes
    const info = await this.stat(path)
    if (!info.isRegular) {
      throw new FileReadError(`not a regular file: ${path}`, "NOT_REGULAR_FILE")
    }
    if (info.size > budget) {
      return { sha256: "", totalBytes: info.size, budgeted: false }
    }
    try {
      signal?.throwIfAborted()
    } catch {
      throw new FileReadError(`read aborted: ${path}`, "ABORTED")
    }
    const handle = await open(path, constants.O_RDONLY | NOFOLLOW)
    const hash = createHash("sha256")
    const chunk = Buffer.allocUnsafe(this.chunkSize)
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
      while (position < info.size) {
        signal?.throwIfAborted()
        const take = Math.min(chunk.length, info.size - position)
        const { bytesRead } = await handle.read(chunk, 0, take, position)
        if (bytesRead <= 0) break
        hash.update(chunk.subarray(0, bytesRead))
        position += bytesRead
      }
      return { sha256: hash.digest("hex"), totalBytes: info.size, budgeted: true }
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
    const handle = await open(path, constants.O_RDONLY | NOFOLLOW)
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
      // IC01-R4: 打开后 fstat（bigint）是权威状态 —— isRegular、EOF、文件
      // 大小和边界全部以 fd identity 为准（不能使用 open 前 stat）。
      const fstatBig = await handle.stat({ bigint: true })
      if (!fstatBig.isFile()) {
        throw new FileReadError(`not a regular file (after open): ${path}`, "NOT_REGULAR_FILE")
      }
      if (options.validateOpen) {
        const violation = await options.validateOpen(handle.fd)
        if (violation) throw new FileReadError(violation, "AUTHORITY_REJECTED")
      }
      const identity = {
        dev: fstatBig.dev,
        ino: fstatBig.ino,
        size: fstatBig.size,
        mtimeNs: fstatBig.mtimeNs,
        ctimeNs: fstatBig.ctimeNs,
      }
      const fileSize = Number(identity.size)
      // count=Infinity（offset>0 无 limit）：窗口结束条件永不满足 → 延伸到
      // EOF 或扫描预算耗尽；count 有限时窗口 = 第 startLine..startLine+count-1 行。
      const lastWindowLine = startLine + count - 1
      let chunkIndex = 0
      // IC01-R4 单遍捕获：行定位、窗口字节捕获与哈希消费同一批 chunk
      // （POST_HASH_WINDOW_REREAD=0）。
      //  - 窗口起始行尚未结束（windowStartByte === null）→ 尾部捕获
      //    [lineStartByte, +maxReturn)（当前未终止行，新换行重置）；
      //  - 起始行的 \n 被找到 → 尾部即时晋升为窗口捕获（起始行字节在
      //    窗口起点确定前已扫描，必须来自同一批 chunk）；
      //  - 之后捕获 [windowStartByte, +maxReturn)（受 windowEndByte 约束）；
      //  - EOF 时若窗口起始行即无尾换行的最后一行，尾部就是窗口字节。
      // IC01-R5/R6: 行窗口 tail 不变量 —— tail 捕获「当前未终止行」的字节；
      // 每个换行（含非目标行）结束当前未终止行时，其 tail 立即作废并归零。
      // 因此任何时刻 tailSlices 只可能属于「当前未终止行」；窗口提升发生在
      // startLine 行的换行被处理时，tail（若非空）必然属于 startLine 本身，
      // 绝不包含 startLine 之前的字节（前一行跨 chunk、下一 chunk 同时含
      // 前一行与目标行换行时，前一行 tail 已在处理其换行时作废）。
      const windowSlices: Buffer[] = []
      const tailSlices: Buffer[] = []
      let tailCaptured = 0
      while (true) {
        signal?.throwIfAborted()
        // IC01-R5: 先 EOF、后 scanBudget —— scanBudget === fileSize 时读到
        // EOF 属完整成功（scannedToEof=true、truncated=false），绝不误标
        // scanBudgetExhausted；scanBudget === fileSize - 1 才诚实截断。
        if (position >= fileSize) break
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
        const chunkStart = position
        const absoluteEnd = position + bytesRead
        let cursor = 0
        while (cursor < bytesRead) {
          // IC01-R2: indexOf 只允许命中 [cursor, bytesRead) 内的真实数据 ——
          // chunk 缓冲区复用（allocUnsafe），越界字节是陈旧数据，绝不能当作
          // 换行参与行计数/窗口定位（否则 totalLines 不确定）。
          const newline = chunk.indexOf(0x0a, cursor)
          if (newline < 0 || newline >= bytesRead) break
          const lineEndAbsolute = position + newline + 1
          if (windowStartByte === null && lineNumber === startLine) {
            windowStartByte = lineStartByte
            // tail 只可能属于当前未终止行 = startLine（见不变量注释）。
            if (tailCaptured > 0) {
              windowSlices.push(...tailSlices)
            }
            tailSlices.length = 0
            tailCaptured = 0
          }
          // 窗口结束 = 窗口最后一行行尾（不含换行）—— 与旧 slice/join 语义一致。
          if (windowEndByte === null && lineNumber === lastWindowLine) {
            windowEndByte = position + newline
          }
          // 始终统计行数（scanToEof 时需要精确 totalLines）。
          lineNumber++
          lineStartByte = lineEndAbsolute
          cursor = newline + 1
          // 该换行结束了「当前未终止行」→ 其 tail 立即作废（核心不变量）。
          tailSlices.length = 0
          tailCaptured = 0
        }
        // ── 窗口字节捕获（同一批 chunk；chunk 复用后视图失效 → 必须拷贝）──
        if (windowStartByte !== null) {
          const cap = windowStartByte + maxReturn
          const overlapStart = Math.max(chunkStart, windowStartByte)
          const overlapEnd = Math.min(absoluteEnd, windowEndByte ?? absoluteEnd, cap)
          if (overlapStart < overlapEnd) {
            windowSlices.push(Buffer.from(chunk.subarray(overlapStart - chunkStart, overlapEnd - chunkStart)))
          }
        } else if (tailCaptured < maxReturn) {
          // 尾部捕获：当前未终止行（cap = lineStartByte + maxReturn）。
          const cap = lineStartByte + maxReturn
          const overlapStart = Math.max(chunkStart, lineStartByte)
          const overlapEnd = Math.min(absoluteEnd, cap)
          if (overlapStart < overlapEnd) {
            tailSlices.push(Buffer.from(chunk.subarray(overlapStart - chunkStart, overlapEnd - chunkStart)))
            tailCaptured += overlapEnd - overlapStart
          }
        }
        const readPosition = position
        position = absoluteEnd
        chunkIndex++
        // IC01-R4: await 钩子 —— 测试可在 chunk 边界确定性同步改写文件。
        await options.onChunk?.(readPosition, bytesRead, chunkIndex)
        // 有界文件 → 窗口找到后继续扫描到 EOF（完整哈希 + 精确行数）。
        if (windowEndByte !== null && !options.scanToEof) {
          // IC01-R5: 窗口完整但扫描恰好耗尽预算且未到 EOF → 诚实标记截断
          // （scanBudget === fileSize - 1 必须 truncated=true）。
          if (position >= scanBudget && position < fileSize) scanBudgetExhausted = true
          break
        }
      }
      const hadWindowStartBeforeEofFix = windowStartByte !== null
      scannedToEof = position >= fileSize && !scanBudgetExhausted
      const atEof = position >= fileSize
      // IC01-R2: EOF 无尾换行 —— 窗口起始行即最后一行（无 \n 终止）时，
      // 窗口必须从 lineStartByte 延伸到 EOF（alpha\nomega 第二行 → omega）。
      if (windowStartByte === null && atEof && lineNumber === startLine) {
        windowStartByte = lineStartByte
      }
      if (windowEndByte === null && atEof && windowStartByte !== null) {
        windowEndByte = position
      }
      const scanPosition = position

      // IC01-R3/R4: 全文件 SHA-256（同一已验证 fd）—— 扫描后从同一 fd 继续
      // 流式哈希到 EOF/预算（与扫描消费的 chunk 前后相接，同一字节只读一次）。
      const hashBudget = options.wholeFileHashBudgetBytes ?? 0
      let wholeFileHashBudgeted = true
      if (hashBudget > 0 && identity.size > BigInt(hashBudget)) {
        wholeFileHashBudgeted = false
      } else if (hashBudget > 0) {
        while (position < fileSize) {
          signal?.throwIfAborted()
          const take = Math.min(chunk.length, fileSize - position)
          const readPosition = position
          const { bytesRead } = await handle.read(chunk, 0, take, position)
          if (bytesRead <= 0) break
          hash.update(chunk.subarray(0, bytesRead))
          position += bytesRead
          chunkIndex++
          await options.onChunk?.(readPosition, bytesRead, chunkIndex)
        }
        wholeFileHashBudgeted = position >= fileSize
      }
      const wholeHash = hash.digest("hex")
      const wholeFileSha256 = hashBudget > 0
        ? (wholeFileHashBudgeted ? wholeHash : null)
        : (scannedToEof ? wholeHash : null)

      // ── IC01-R4: 返回前最终 fstat（bigint）：dev / ino / size / mtimeNs /
      // ctimeNs 必须与 open 时一致（增长、截断、替换、同大小原地改写 →
      // SNAPSHOT_CHANGED）。最终 fstat 之后不得再从文件读取任何内容。
      const endStat = await handle.stat({ bigint: true })
      if (
        endStat.dev !== identity.dev ||
        endStat.ino !== identity.ino ||
        endStat.size !== identity.size ||
        endStat.mtimeNs !== identity.mtimeNs ||
        endStat.ctimeNs !== identity.ctimeNs
      ) {
        throw new FileReadError(`file changed while being read: ${path}`, "SNAPSHOT_CHANGED")
      }
      if (windowStartByte === null) {
        return {
          text: "",
          linesCount: 0,
          totalLines: scannedToEof ? lineNumber : null,
          scannedToEof,
          binary: seenBinary,
          sha256: wholeHash,
          wholeFileSha256,
          wholeFileHashBudgeted,
          truncated: scanBudgetExhausted,
        }
      }
      // IC01-R5: 单遍捕获完成后，返回内存只由实际捕获范围、windowEnd 与
      // maxReturnBytes 决定 —— 不再按旧「窗口重读 I/O」逻辑扣减 scanBudget。
      // （捕获本身在扫描期间已受 scanBudget 物理约束：扫描停止处即捕获停止处。）
      const windowEnd = windowEndByte ?? scanPosition
      const end = Math.min(windowEnd, windowStartByte + maxReturn)
      const windowTruncated = end < windowEnd || scanBudgetExhausted
      // IC01-R4: 窗口字节在扫描期间已捕获（与哈希同一批 chunk），此处仅做
      // 内存装配 —— 绝不重新读取文件（POST_HASH_WINDOW_REREAD=0）。
      const captured = hadWindowStartBeforeEofFix ? windowSlices : tailSlices
      const capturedTotal = captured.reduce((n, s) => n + s.length, 0)
      const text = Buffer.concat(captured)
        .subarray(0, Math.min(capturedTotal, Math.max(0, end - windowStartByte)))
        .toString("utf-8")
      const split = text.split("\n")
      // 尾部空行不计（与 slice/join 语义对齐）。
      const linesCount = split.length > 0 && split[split.length - 1] === "" ? split.length - 1 : split.length
      // IC01-R5: totalLines = 扫描换行数 + 1（旧 split 语义，含尾空元素；
      // 空文件为 0）。不得用窗口文本判断（count 有限时窗口无尾换行 ≠ 文件如此）。
      const totalLinesValue = scannedToEof
        ? (fileSize > 0 ? lineNumber + 1 : 0)
        : null
      return {
        text,
        linesCount,
        totalLines: totalLinesValue,
        scannedToEof,
        binary: seenBinary,
        sha256: wholeHash,
        wholeFileSha256,
        wholeFileHashBudgeted,
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
