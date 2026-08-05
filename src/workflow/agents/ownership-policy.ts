/** MACP-M3: ownership policy — writes constrained to the agent's owned set.
 *
 *  Every declared or actual write path is normalized and checked BEFORE the
 *  write executes (declared) and again AFTER against the actual paths the
 *  tool reported (actual). Defenses:
 *    - `../` escape: resolved path must stay under the project root;
 *    - absolute-path bypass: absolute paths are rejected unless they are
 *      already inside the project root;
 *    - symlink escape: realpath of the nearest existing ancestor must stay
 *      under the realpath of the project root;
 *    - case variance: normalized lower-case comparison (guards case-
 *      insensitive filesystems without depending on the platform).
 *  Ownership itself is normalized-path exact: the written file must be one
 *  of the agent's ownerFiles (UNOWNED_WRITE: 0).
 */

import { isAbsolute, normalize, relative, resolve, dirname, sep } from "node:path"
import { existsSync, realpathSync } from "node:fs"

export interface PathCheck {
  ok: boolean
  /** Absolute, normalized path (when ok). */
  path?: string
  reason?: string
}

/** Lower-case + normalized comparison key (case-variance defense). */
export function caseKey(path: string): string {
  return normalize(path).toLowerCase()
}

/** Normalize a declared path against the project root. */
export function normalizeProjectPath(projectRoot: string, raw: string): PathCheck {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "empty path" }
  }
  if (raw.includes("\0")) {
    return { ok: false, reason: "null byte in path" }
  }
  const root = resolve(projectRoot)

  // Absolute-path bypass: allowed only when already inside the project.
  let candidate: string
  if (isAbsolute(raw)) {
    candidate = normalize(raw)
    if (!caseKey(candidate).startsWith(caseKey(root) + sep) && caseKey(candidate) !== caseKey(root)) {
      return { ok: false, reason: `absolute path escapes project root: ${raw}` }
    }
  } else {
    candidate = resolve(root, raw)
  }

  // `../` escape: after resolution the path must stay under the project.
  const rootKey = caseKey(root)
  const candKey = caseKey(candidate)
  if (candKey !== rootKey && !candKey.startsWith(rootKey + sep)) {
    return { ok: false, reason: `path escapes project root: ${raw}` }
  }

  // Symlink escape: resolve the nearest existing ancestor's real path; the
  // final path must stay under the real project root.
  const realRoot = realRootOf(root)
  let probe = candidate
  let guard = 0
  while (!existsSync(probe) && guard < 64) {
    const parent = dirname(probe)
    if (parent === probe) break
    probe = parent
    guard += 1
  }
  const realProbe = existsSync(probe) ? realpathSync(probe) : probe
  const realKey = caseKey(realProbe)
  if (realKey !== caseKey(realRoot) && !realKey.startsWith(caseKey(realRoot) + sep)) {
    return { ok: false, reason: `symlink escapes project root: ${raw}` }
  }

  return { ok: true, path: candidate }
}

function realRootOf(root: string): string {
  try {
    return realpathSync(root)
  } catch {
    return root
  }
}

/** Whether a normalized absolute path is exactly one of the owned files.
 *  Ownership is matched on the project-relative path (the agent's worktree
 *  mirrors the same relative layout, so an owner "a.ts" matches both the
 *  shared workspace and the worktree copy). */
export function isOwnedFile(ownerFiles: string[], root: string, path: string): boolean {
  const rel = relative(root, path)
  if (rel.startsWith("..") || isAbsolute(rel)) return false
  const key = caseKey(rel)
  return ownerFiles.some(owner => caseKey(owner) === key)
}

export interface OwnershipDecision {
  allowed: boolean
  reason?: string
}

/** Pre-write: the declared path must normalize AND be owned by the agent. */
export function authorizeDeclaredWrite(
  assignment: { agentId: string; canWrite: boolean; ownerFiles: string[] },
  projectRoot: string,
  declaredPath: string,
): OwnershipDecision {
  if (!assignment.canWrite) {
    return { allowed: false, reason: `agent "${assignment.agentId}" is not writable (planner/reviewer)` }
  }
  const checked = normalizeProjectPath(projectRoot, declaredPath)
  if (!checked.ok || !checked.path) {
    return { allowed: false, reason: `declared write path invalid: ${declaredPath} — ${checked.reason ?? "unresolvable"}` }
  }
  if (!isOwnedFile(assignment.ownerFiles, projectRoot, checked.path)) {
    return { allowed: false, reason: `agent "${assignment.agentId}" does not own "${declaredPath}"` }
  }
  return { allowed: true }
}

export interface ActualWriteViolation {
  actual: string
  reason: string
}

/** Post-write: every actual path the tool reported must normalize and be
 *  owned (the declared path is NOT the trust anchor — the actual is). */
export function verifyActualWrites(
  assignment: { agentId: string; canWrite: boolean; ownerFiles: string[] },
  projectRoot: string,
  actualPaths: string[],
): { ok: boolean; violations: ActualWriteViolation[] } {
  if (!assignment.canWrite) {
    return { ok: false, violations: actualPaths.map(actual => ({ actual, reason: `agent "${assignment.agentId}" is not writable` })) }
  }
  const violations: ActualWriteViolation[] = []
  for (const actual of actualPaths) {
    const checked = normalizeProjectPath(projectRoot, actual)
    if (!checked.ok || !checked.path) {
      violations.push({ actual, reason: `invalid write path: ${checked.reason ?? "unresolvable"}` })
      continue
    }
    if (!isOwnedFile(assignment.ownerFiles, projectRoot, checked.path)) {
      violations.push({ actual, reason: `agent "${assignment.agentId}" does not own "${actual}"` })
    }
  }
  return { ok: violations.length === 0, violations }
}

/** Extract actual written paths from a tool output (write tools must carry
 *  them — MACP-M3 task 8). Accepts metadata.paths (string | string[]). */
export function extractActualWritePaths(output: unknown): string[] {
  if (!output || typeof output !== "object") return []
  const metadata = (output as { metadata?: unknown }).metadata
  if (!metadata || typeof metadata !== "object") return []
  const paths = (metadata as { paths?: unknown }).paths
  if (typeof paths === "string") return [paths]
  if (Array.isArray(paths)) return paths.filter(p => typeof p === "string")
  return []
}
