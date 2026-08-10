/** LNXF-1.0: PathGuard —— 工作区内容指纹快照与差异（host-audit 与 bwrap 共用）。
 *
 *  执行前对 worktreeRoot 做内容指纹快照，执行后 diff 出 created/changed/deleted；
 *  ownerFiles（相对路径集合）之外的文件写 = unexpectedWrites（审计信号）。
 *
 *  有界快照（2026-08-07 OTS-004 事故修复）：snapshotWorkspace 此前对每个文件
 *  无上限 readFileSync 全量哈希 —— disk 炸弹在 worktree 写入 3GiB 大文件后，
 *  赛后快照把整块内容读进 Runtime 进程内存（bun RSS ~4.5GiB → 宿主 OOM）。
 *  现在单文件超限即跳过（不入内存）并记录 skippedLargeFiles，总字节预算超限
 *  停止继续哈希 —— receipt.snapshotGuard 携带这些证据，可证明未全量读入。
 */

import { readdirSync, statSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { createHash } from "node:crypto"

/** 单文件内容哈希上限：超过上限的文件不进内存（记录 skippedLargeFiles）。
 *  8MiB 覆盖常规源码/构建产物；巨型二进制（数据/镜像/压缩包）跳过。 */
export const DEFAULT_SNAPSHOT_MAX_FILE_BYTES = 8 * 1024 * 1024
/** 单次快照总字节预算：多文件累积也封顶（防"很多个 7MiB 文件"拖垮进程）。 */
export const DEFAULT_SNAPSHOT_MAX_TOTAL_BYTES = 256 * 1024 * 1024

export interface SnapshotLimits {
  maxFileBytes?: number
  maxTotalBytes?: number
}

export interface SnapshotResult {
  /** 相对路径 → sha256:16（受上限约束，非全量）。 */
  files: Record<string, string>
  /** 超过 maxFileBytes 被跳过（未读入内存）的文件。 */
  skippedLargeFiles: string[]
  /** 总预算耗尽（剩余文件未入指纹）。 */
  budgetExceeded: boolean
  bytesHashed: number
  filesHashed: number
}

/** 工作区快照（有界指纹：size 超限跳过 + 总预算封顶，杜绝内容无界读入）。
 *  统计指纹（size:mtime 不行 —— 内容 sha256，避免粗粒度 fs 误报）。 */
export function snapshotWorkspace(root: string, limits: SnapshotLimits = {}): SnapshotResult {
  const maxFileBytes = limits.maxFileBytes ?? DEFAULT_SNAPSHOT_MAX_FILE_BYTES
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_SNAPSHOT_MAX_TOTAL_BYTES
  const files: Record<string, string> = {}
  const skippedLargeFiles: string[] = []
  let bytesHashed = 0
  let filesHashed = 0
  let budgetExceeded = false

  const walk = (dir: string): void => {
    if (budgetExceeded) return
    let entries: import("node:fs").Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (budgetExceeded) return
      const full = join(dir, entry.name)
      if (entry.name === ".git" || entry.name === "node_modules") continue
      try {
        const st = statSync(full)
        if (entry.isDirectory()) { walk(full); continue }
        const rel = relative(root, full).replace(/\\/g, "/")
        if (st.size > maxFileBytes) {
          skippedLargeFiles.push(rel)
          continue
        }
        if (bytesHashed + st.size > maxTotalBytes) {
          budgetExceeded = true
          return
        }
        const content = readFileSync(full)
        files[rel] = createHash("sha256").update(content).digest("hex").slice(0, 16)
        bytesHashed += st.size
        filesHashed += 1
      } catch { /* 不可读跳过 */ }
    }
  }
  walk(root)
  return { files, skippedLargeFiles, budgetExceeded, bytesHashed, filesHashed }
}

/** PathGuard 差异（事后审计）：记录执行前后项目工作区的文件变化。 */
export function pathGuardDiff(before: SnapshotResult, after: SnapshotResult): {
  changed: string[]
  created: string[]
  deleted: string[]
} {
  const b = before.files
  const a = after.files
  const changed: string[] = []
  const created: string[] = []
  const deleted: string[] = []
  for (const [path, hash] of Object.entries(a)) {
    if (!(path in b)) created.push(path)
    else if (b[path] !== hash) changed.push(path)
  }
  for (const path of Object.keys(b)) {
    if (!(path in a)) deleted.push(path)
  }
  return { changed, created, deleted }
}

/** 预期写集合：ownerFiles 声明的路径（相对 worktreeRoot）。 */
export function isOwnedFile(relPath: string, ownerFiles?: string[]): boolean {
  if (!ownerFiles || ownerFiles.length === 0) return false
  return ownerFiles.some(owned => relPath === owned || relPath.startsWith(owned.replace(/\/+$/, "") + "/"))
}

/** 计算 unexpectedWrites：diff 中不属于 ownerFiles 的写入。 */
export function classifyUnexpectedWrites(
  diff: { created: string[]; changed: string[] } | undefined,
  ownerFiles?: string[],
): string[] {
  if (!diff) return []
  return [...diff.created, ...diff.changed].filter(p => !isOwnedFile(p, ownerFiles))
}
