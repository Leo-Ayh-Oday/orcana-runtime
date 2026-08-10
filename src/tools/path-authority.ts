/**
 * RC-19 Phase 2 — Tool ProjectRoot Authority.
 *
 * resolveToolPath() is the SINGLE path-resolution entry for every project
 * tool (D7). Relative paths bind to ToolExecutionContext.projectRoot — the
 * process cwd is NEVER consulted, so the same tool call yields the same
 * result regardless of the cwd (PROCESS_CWD_AFFECTS_TOOL=0). Absolute paths,
 * `..` traversal and symlink escapes that leave the authoritative roots are
 * rejected (CROSS_PROJECT_READ / CROSS_PROJECT_WRITE / SYMLINK_PROJECT_ESCAPE).
 *
 * read/write roots: writes only reach projectRoot + writableRoots; reads may
 * also reach readableRoots.
 */

import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path"
import { existsSync, realpathSync } from "node:fs"

export interface ToolPathAuthority {
  /** The authoritative project root — required (directive §6: 必填). */
  projectRoot: string
  /** Extra roots a read may reach (defaults to [projectRoot]). */
  readableRoots?: string[]
  /** Extra roots a write may reach (defaults to [] — writes opt in). */
  writableRoots?: string[]
}

export type ToolPathResolution =
  | { ok: true; path: string }
  | { ok: false; message: string }

export function resolveToolPath(
  authority: ToolPathAuthority | undefined,
  rawPath: string,
  mode: "read" | "write",
): ToolPathResolution {
  const root = authority?.projectRoot
  if (!root || typeof rawPath !== "string" || rawPath.trim() === "") {
    return {
      ok: false,
      message: "tool path resolution requires a projectRoot and a non-empty path",
    }
  }
  const base = resolve(root)
  // Relative paths always bind to projectRoot — never process.cwd() (D7).
  // Absolute paths are checked lexically first, then against symlink reality.
  const candidate = isAbsolute(rawPath) ? normalize(rawPath) : resolve(base, rawPath)
  if (candidate === base) return { ok: true, path: candidate }

  const allowedRoots = mode === "write"
    ? [base, ...(authority.writableRoots ?? [])]
    : [base, ...(authority.readableRoots ?? [])]

  if (!allowedRoots.some(root => isWithin(root, candidate))) {
    return {
      ok: false,
      message: `CROSS_PROJECT_${mode.toUpperCase()}: path escapes the project root (${mode}): ${rawPath}`,
    }
  }

  // SYMLINK_PROJECT_ESCAPE: a symlink whose real target leaves the root is a
  // cross-project access — reject via the realpath of the deepest existing
  // ancestor (the target itself may not exist yet on a fresh write).
  const realTarget = deepestExistingRealpath(candidate)
  if (realTarget !== undefined && !allowedRoots.some(root => isWithin(root, realTarget))) {
    return {
      ok: false,
      message: `SYMLINK_PROJECT_ESCAPE: path resolves outside the project root via symlink: ${rawPath}`,
    }
  }

  return { ok: true, path: candidate }
}

/** True when `candidate` equals `root` or sits strictly below it. */
export function isWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true
  const rel = relative(root, candidate)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

/** realpath of the deepest ancestor of `candidate` that exists on disk.
 *  IC01: 导出供 WorkspaceIoAuthority 复用 —— 全库唯一的 symlink 现实检查。 */
export function deepestExistingRealpath(candidate: string): string | undefined {
  let current = candidate
  for (let guard = 0; guard < 256; guard++) {
    if (existsSync(current)) {
      try {
        return realpathSync(current)
      } catch {
        return undefined
      }
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/** Deterministic project-relative display path (never cwd-dependent). */
export function projectRelativePath(root: string, path: string): string {
  const base = resolve(root)
  const rel = relative(base, resolve(path))
  if (rel === "" ) return "."
  if (!rel.startsWith("..") && !isAbsolute(rel)) return rel.replace(/\\/g, "/")
  return resolve(path).replace(/\\/g, "/")
}

/** True when the path is the root itself or a direct child (used by
 *  checkForbiddenFile-style guards that need the boundary constant). */
export function pathSeparatorOf(root: string): string {
  return root.endsWith(sep) ? root : root + sep
}
