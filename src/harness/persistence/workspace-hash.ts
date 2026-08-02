/** Workspace hash (H6, plan §13.4): content fingerprint of a project tree.
 *
 *  Aggregates per-file sha256 fingerprints (reusing file-state's
 *  fingerprintFile) into one stable hash. Excludes node_modules, .git,
 *  .deepseek-code and dist. Callers decide when to compute it — small
 *  projects only (tests use small dirs).
 */

import { createHash } from "node:crypto"
import { readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fingerprintFile } from "../../file-state/file-fingerprint"

const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".deepseek-code", "dist", ".wolf"])

export function computeWorkspaceHash(projectRoot: string): string {
  const hashes: Array<{ path: string; sha256: string }> = []
  const walk = (dir: string) => {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry)) continue
      const full = join(dir, entry)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        walk(full)
      } else if (stat.isFile()) {
        const fingerprint = fingerprintFile(full)
        if (fingerprint) {
          hashes.push({ path: relative(projectRoot, full), sha256: fingerprint.sha256 })
        }
      }
    }
  }
  walk(projectRoot)
  hashes.sort((a, b) => a.path.localeCompare(b.path))
  const digest = createHash("sha256")
  for (const item of hashes) {
    digest.update(`${item.path}:${item.sha256}\n`)
  }
  return digest.digest("hex")
}
