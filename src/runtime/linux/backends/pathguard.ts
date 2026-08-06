/** LNXF-1.0: PathGuard —— 工作区内容指纹快照与差异（host-audit 与 bwrap 共用）。
 *
 *  执行前对 worktreeRoot 做内容指纹快照，执行后 diff 出 created/changed/deleted；
 *  ownerFiles（相对路径集合）之外的文件写 = unexpectedWrites（审计信号）。
 */

import { readdirSync, statSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { createHash } from "node:crypto"

/** 工作区快照（统计指纹：size:mtime 不行 —— 内容 sha256，避免粗粒度 fs 误报）。 */
export function snapshotWorkspace(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.name === ".git" || entry.name === "node_modules") continue
      try {
        const st = statSync(full)
        if (entry.isDirectory()) walk(full)
        else {
          const content = readFileSync(full)
          out[relative(root, full).replace(/\\/g, "/")] = createHash("sha256").update(content).digest("hex").slice(0, 16)
        }
      } catch { /* 不可读跳过 */ }
    }
  }
  walk(root)
  return out
}

/** PathGuard 迁移（事后审计）：记录执行前后项目工作区的文件变化。 */
export function pathGuardDiff(before: Record<string, string>, after: Record<string, string>): {
  changed: string[]
  created: string[]
  deleted: string[]
} {
  const changed: string[] = []
  const created: string[] = []
  const deleted: string[] = []
  for (const [path, hash] of Object.entries(after)) {
    if (!(path in before)) created.push(path)
    else if (before[path] !== hash) changed.push(path)
  }
  for (const path of Object.keys(before)) {
    if (!(path in after)) deleted.push(path)
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
