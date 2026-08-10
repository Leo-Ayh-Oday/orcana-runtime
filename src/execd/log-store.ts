/** LR2-1v2（L2-B）：LogStore —— 大对象落盘 + AttachLogs 完整回放。
 *
 *  在线 watch 仍走截断 16KB 索引事件（内存有界语义）；AttachLogs 需要
 *  完整 stdout/stderr（ATTACH_LOGS_TRUNCATED = 0）—— 大对象按 cell 落盘：
 *  $XDG_RUNTIME_DIR/orcana/logs/{cellId}/{kind}.log（0600），SQLite 只存
 *  索引（cell_id/kind/length/updated_at）。
 *
 *  - 追加写：append(cellId, kind, chunk) → 文件追加 + 索引 upsert；
 *  - 回放：attach(cellId, kind, offset?) → 从 offset 读到 EOF + 当前长度；
 *  - 清理：remove(cellId) → 删文件 + 删索引（LOG_LEAK_AFTER_CLEANUP = 0）。
 *  fs 注入（测试用内存 fs / 真实 node:fs）。
 */

export interface LogFileFs {
  append(path: string, data: string): void
  /** M2：按字节 offset 读取尾部（不整文件读入内存 —— 大日志流式）。 */
  readTail(path: string, byteOffset: number): string
  stat(path: string): { size: number } | undefined
  exists(path: string): boolean
  remove(path: string): void
}

export const REAL_LOG_FS: LogFileFs = {
  append(path: string, data: string): void {
    const { appendFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs")
    const { dirname } = require("node:path") as typeof import("node:path")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    appendFileSync(path, data, { mode: 0o600 })
  },
  // M2：fd 定位到字节 offset 后只读尾部（`position` 是字节语义）。
  // 返回前把尾随截断的多字节字符丢弃（UTF-8 边界安全）：buffer 按
  // utf8 解码后，若末尾是无效序列（\uFFFD），剥掉最后一个字符重试。
  readTail(path: string, byteOffset: number): string {
    const { openSync, readSync, fstatSync, closeSync } = require("node:fs") as typeof import("node:fs")
    const fd = openSync(path, "r")
    try {
      const size = fstatSync(fd).size
      if (byteOffset >= size) return ""
      const len = size - byteOffset
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, byteOffset)
      let text = buf.toString("utf8")
      // 尾随截断字符（CJK 等多字节被切开 → 解码出 \uFFFD）→ 剥掉重试
      while (text.length > 0 && text.charCodeAt(text.length - 1) === 0xfffd) {
        text = text.slice(0, -1)
      }
      return text
    } finally {
      closeSync(fd)
    }
  },
  stat(path: string): { size: number } | undefined {
    try {
      const { statSync } = require("node:fs") as typeof import("node:fs")
      const s = statSync(path)
      return { size: s.size }
    } catch {
      return undefined
    }
  },
  exists(path: string): boolean {
    try {
      const { accessSync, constants } = require("node:fs") as typeof import("node:fs")
      accessSync(path, constants.F_OK)
      return true
    } catch {
      return false
    }
  },
  remove(path: string): void {
    const { rmSync } = require("node:fs") as typeof import("node:fs")
    try { rmSync(path, { force: true }) } catch { /* 幂等 */ }
  },
}

export interface LogIndexRow {
  cellId: string
  kind: "stdout" | "stderr"
  lengthBytes: number
  updatedAt: number
}

export interface LogStoreDeps {
  /** 日志根目录（logs/{cellId}/{kind}.log）。 */
  logRoot: string
  fs?: LogFileFs
  /** 索引 CRUD（SQLite 注入 —— 测试用内存 Map）。 */
  index: {
    upsert(row: LogIndexRow): void
    get(cellId: string, kind: "stdout" | "stderr"): LogIndexRow | undefined
    remove(cellId: string): void
  }
  now?: () => number
}

export interface AttachChunk {
  cellId: string
  kind: "stdout" | "stderr"
  /** 返回的字节段（可能为空 = EOF）。 */
  data: string
  /** 当前完整长度（附件调用方跟踪 offset）。 */
  totalBytes: number
  eof: boolean
}

export class LogStore {
  private readonly fs: LogFileFs
  private readonly logRoot: string
  private readonly index: LogStoreDeps["index"]

  constructor(private readonly deps: LogStoreDeps) {
    this.fs = deps.fs ?? REAL_LOG_FS
    this.logRoot = deps.logRoot
    this.index = deps.index
  }

  private pathOf(cellId: string, kind: "stdout" | "stderr"): string {
    return `${this.logRoot}/${cellId}/${kind}.log`
  }

  /** 追加写：文件追加 + 索引更新（大对象不进 DB；lengthBytes 用字节数
   *  —— Buffer.byteLength，与文件 stat.size 一致，避免 UTF-16 错位）。 */
  append(cellId: string, kind: "stdout" | "stderr", data: string): void {
    if (data.length === 0) return
    this.fs.append(this.pathOf(cellId, kind), data)
    const existing = this.index.get(cellId, kind)
    this.index.upsert({
      cellId,
      kind,
      lengthBytes: (existing?.lengthBytes ?? 0) + Buffer.byteLength(data, "utf8"),
      updatedAt: this.deps.now?.() ?? Date.now(),
    })
  }

  /** AttachLogs 回放：从字节 offset 读到 EOF（M2：不整文件读入内存）。 */
  attach(cellId: string, kind: "stdout" | "stderr", offset: number): AttachChunk {
    const path = this.pathOf(cellId, kind)
    const stat = this.fs.stat(path)
    const totalBytes = stat?.size ?? 0
    if (!stat || offset >= totalBytes) {
      return { cellId, kind, data: "", totalBytes, eof: true }
    }
    const data = this.fs.readTail(path, offset)
    return { cellId, kind, data, totalBytes, eof: offset + Buffer.byteLength(data, "utf8") >= totalBytes }
  }

  /** 当前已落盘长度（断点续读基准）。 */
  sizeOf(cellId: string, kind: "stdout" | "stderr"): number {
    return this.fs.stat(this.pathOf(cellId, kind))?.size ?? 0
  }

  /** 清理：删文件 + 删索引（LOG_LEAK_AFTER_CLEANUP = 0）。 */
  remove(cellId: string): void {
    this.fs.remove(this.pathOf(cellId, "stdout"))
    this.fs.remove(this.pathOf(cellId, "stderr"))
    this.index.remove(cellId)
  }
}

/** 测试用内存日志 fs。 */
export function memLogFs(): { fs: LogFileFs; files: Map<string, string> } {
  const files = new Map<string, string>()
  const fs: LogFileFs = {
    append(path, data) { files.set(path, (files.get(path) ?? "") + data) },
    // 内存模拟按字节 offset 读尾部（Buffer 字节语义 —— 与真实 fs 一致）
    readTail(path, byteOffset) {
      const content = files.get(path) ?? ""
      return Buffer.from(content, "utf8").subarray(byteOffset).toString("utf8")
    },
    stat(path) { return files.has(path) ? { size: Buffer.byteLength(files.get(path)!, "utf8") } : undefined },
    exists(path) { return files.has(path) },
    remove(path) { files.delete(path) },
  }
  return { fs, files }
}

/** 测试用内存索引。 */
export function memLogIndex(): LogStoreDeps["index"] {
  const rows = new Map<string, LogIndexRow>()
  return {
    upsert(row) { rows.set(`${row.cellId}:${row.kind}`, row) },
    get(cellId, kind) { return rows.get(`${cellId}:${kind}`) },
    remove(cellId) {
      for (const k of [...rows.keys()]) if (k.startsWith(`${cellId}:`)) rows.delete(k)
    },
  }
}
