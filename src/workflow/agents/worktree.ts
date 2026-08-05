/** Worktree isolation (G7): each agent writes inside its own worktree.
 *
 *  git repositories get a real `git worktree add` (shared history, isolated
 *  working tree); non-git projects degrade to a directory snapshot (copy of
 *  the owned files, writes land in the copy). `dispose` cleans up.
 */

import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

export interface WorktreeHandle {
  agentId: string
  root: string
  /** git worktree or directory snapshot. */
  mode: "git" | "snapshot"
  dispose: () => void
}

/** Resolve the worktree root for an agent under the project. */
export function worktreeRoot(projectRoot: string, agentId: string): string {
  return join(projectRoot, ".orcana", "worktrees", agentId)
}

function isGitRepo(root: string): boolean {
  return existsSync(join(root, ".git")) || existsSync(join(root, ".git", "HEAD"))
}

/** Snapshot-copy a directory tree (best-effort, excluding .orcana). */
function snapshotCopy(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === ".orcana") continue
    const from = join(src, entry.name)
    const to = join(dst, entry.name)
    if (entry.isDirectory()) {
      snapshotCopy(from, to)
    } else {
      cpSync(from, to, { force: true })
    }
  }
}

/** Create an isolated worktree for an agent. */
export function createWorktree(projectRoot: string, agentId: string, files?: string[]): WorktreeHandle {
  const root = worktreeRoot(projectRoot, agentId)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })

  if (isGitRepo(projectRoot)) {
    const result = spawnSync("git", ["worktree", "add", "--detach", root], {
      cwd: projectRoot,
      stdio: "ignore",
      timeout: 30_000,
    })
    if (result.status === 0) {
      return {
        agentId,
        root,
        mode: "git",
        dispose: () => {
          spawnSync("git", ["worktree", "remove", "--force", root], { cwd: projectRoot, stdio: "ignore", timeout: 30_000 })
          rmSync(root, { recursive: true, force: true })
        },
      }
    }
    // Fall through to snapshot when `git worktree` is unavailable.
  }

  // Non-git (or worktree-unavailable) degradation: snapshot the owned files.
  if (files && files.length > 0) {
    for (const file of files) {
      const from = resolve(projectRoot, file)
      const to = resolve(root, file)
      if (existsSync(from)) {
        mkdirSync(join(to, ".."), { recursive: true })
        cpSync(from, to, { force: true })
      }
    }
  }
  return {
    agentId,
    root,
    mode: "snapshot",
    dispose: () => {
      rmSync(root, { recursive: true, force: true })
    },
  }
}
