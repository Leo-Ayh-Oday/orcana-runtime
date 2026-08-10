/** Worktree isolation (G7): each agent writes inside its own worktree.
 *
 *  git repositories get a real `git worktree add` (shared history, isolated
 *  working tree); non-git projects degrade to a directory snapshot (copy of
 *  the owned files, writes land in the copy). `dispose` cleans up.
 */

import { spawnSyncLegacy } from "../../runtime/legacy-process"
const spawnSync = spawnSyncLegacy
import { cpSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs"
import { isAbsolute, join, resolve, sep } from "node:path"

export interface WorktreeHandle {
  agentId: string
  root: string
  /** git worktree or directory snapshot. */
  mode: "git" | "snapshot"
  dispose: () => void
}

/** M2: an agent id must be a plain identifier, never a path — the worktree
 *  root and (deleted) directory join it directly. */
export function isValidAgentId(agentId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(agentId)
}

/** M3: fail closed when a resolved owner-file path escapes its base — the
 *  snapshot source must stay under the project, the target under the
 *  worktree root (no `../secret.txt` reads or writes). */
function assertContained(root: string, file: string, label: string): void {
  const base = resolve(root)
  const candidate = resolve(base, file)
  if (candidate !== base && !candidate.startsWith(base + sep)) {
    throw new Error(`worktree: ownerFile "${file}" escapes ${label} (${candidate})`)
  }
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

/** Create an isolated worktree for an agent.
 *  `declaredRoot` (M18): the AgentSpec.worktree root is authoritative when
 *  declared — the execution root must match what the pool configured. */
export function createWorktree(projectRoot: string, agentId: string, files?: string[], declaredRoot?: string): WorktreeHandle {
  // M2/M3: validate BEFORE any fs mutation — an escaping agent id would make
  // the rmSync below target an arbitrary directory; escaping owner files
  // would read from / write to outside the project. Both fail closed.
  if (!isValidAgentId(agentId)) {
    throw new Error(
      `worktree: invalid agent id "${agentId}" (must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$)`,
    )
  }
  if (declaredRoot !== undefined && !isAbsolute(declaredRoot)) {
    throw new Error(`worktree: declared root for agent "${agentId}" must be an absolute path (got "${declaredRoot}")`)
  }
  for (const file of files ?? []) {
    assertContained(projectRoot, file, "project root")
    assertContained(declaredRoot ?? worktreeRoot(projectRoot, agentId), file, "worktree root")
  }
  const root = declaredRoot ?? worktreeRoot(projectRoot, agentId)
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
