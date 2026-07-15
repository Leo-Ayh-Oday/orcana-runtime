/** Path Guard — pre-execution file snapshot + post-execution diff detection.
 *
 *  Before a sandboxed command runs, snapshot the project's file tree (names +
 *  sizes only — not content). After execution, diff the tree and report any
 *  writes or deletions outside the expected project directories.
 *
 *  This is a post-hoc guard, not a real-time interceptor. It catches damage
 *  after the fact but does not prevent it during execution. Combined with
 *  Job Object (process tree termination), it provides defense-in-depth.
 */

import { existsSync, readdirSync, statSync, lstatSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"

interface FileEntry {
  size: number
  mtimeMs: number
}

function toNum(v: number | bigint): number {
  return typeof v === "bigint" ? Number(v) : v
}

const SKIP_DIRS = new Set([".git", "node_modules", ".codegraph", "dist", "coverage", ".next", ".deepseek-code"])

export class PathGuard {
  private snapshot: Map<string, FileEntry> | null = null
  private projectRoot: string

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot)
  }

  /** Take a snapshot of all files under projectRoot. */
  snapshotTree(): void {
    this.snapshot = new Map()
    this.walk(this.projectRoot, (relPath, st) => {
      if (!st) return
      this.snapshot!.set(relPath, { size: st.size, mtimeMs: toNum(st.mtimeMs) })
    })
  }

  /** Diff current tree against snapshot. Returns violations (files created/modified/deleted outside expected paths). */
  diff(expectedPaths: string[] = []): PathGuardReport {
    if (!this.snapshot) return { violations: [], untracked: [] }

    const current = new Map<string, FileEntry>()
    this.walk(this.projectRoot, (relPath, st) => {
      if (!st) return
      current.set(relPath, { size: st.size, mtimeMs: toNum(st.mtimeMs) })
    })

    const violations: PathViolation[] = []
    const untracked: string[] = []

    const expected = new Set(expectedPaths.map(p => relative(this.projectRoot, resolve(this.projectRoot, p)).replace(/\\/g, "/")))

    // New or modified files
    for (const [path, entry] of current) {
      const prev = this.snapshot.get(path)
      if (!prev) {
        if (!expected.has(path)) {
          violations.push({ kind: "new-file", path, detail: `${entry.size} bytes` })
        } else {
          untracked.push(path)
        }
      } else if (prev.size !== entry.size || prev.mtimeMs !== entry.mtimeMs) {
        if (!expected.has(path)) {
          violations.push({ kind: "modified", path, detail: `${prev.size} → ${entry.size} bytes` })
        }
      }
    }

    // Deleted files
    for (const [path] of this.snapshot) {
      if (!current.has(path) && !expected.has(path)) {
        violations.push({ kind: "deleted", path, detail: "file removed during sandbox execution" })
      }
    }

    return { violations, untracked }
  }

  /** Format violations as a human-readable summary for the agent. */
  static formatReport(report: PathGuardReport): string {
    const lines: string[] = []
    if (report.violations.length > 0) {
      lines.push("[沙箱文件守护] 检测到非预期的文件变更:")
      for (const v of report.violations.slice(0, 12)) {
        lines.push(`  ${v.kind}: ${v.path} (${v.detail})`)
      }
      if (report.violations.length > 12) {
        lines.push(`  ... 及其他 ${report.violations.length - 12} 项`)
      }
    }
    if (report.untracked.length > 0 && report.violations.length === 0) {
      lines.push("[沙箱文件守护] 未发现异常文件变更")
    }
    return lines.join("\n")
  }

  // ── Internal ──

  private walk(dir: string, onFile: (relPath: string, st: { size: number; mtimeMs: number | bigint }) => void): void {
    let entries
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const full = join(dir, name)
      let st
      try { st = lstatSync(full) } catch { continue }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) this.walk(full, onFile)
      } else if (st.isFile()) {
        const rel = relative(this.projectRoot, full).replace(/\\/g, "/")
        onFile(rel, st)
      }
    }
  }
}

export interface PathViolation {
  kind: "new-file" | "modified" | "deleted"
  path: string
  detail: string
}

export interface PathGuardReport {
  violations: PathViolation[]
  /** Files that changed but were in the expected set (not violations) */
  untracked: string[]
}
