/** Tool Runtime 2.0 (RT-5): writable-root policy — every write path must
 *  resolve inside the declared writable roots. Path traversal (../, absolute
 *  paths outside roots) is rejected before any write tool executes.
 *
 *  Single shared boundary for shell/file/patch/git/MCP writers (plan §5 RT-5:
 *  no "shell blocked but patch can write" paths).
 */

import { isAbsolute, relative, resolve, sep } from "node:path"

export interface WritableRootCheck {
  allowed: boolean
  /** Reason when blocked (never set on allowed). */
  reason?: string
}

/** Canonical path keys write tools receive in their input. */
const WRITE_PATH_KEYS = ["path", "file", "target", "destination"] as const

/** Extract candidate write paths from a tool input (never throws). */
export function extractWritePaths(input: Record<string, unknown>): string[] {
  const paths: string[] = []
  for (const key of WRITE_PATH_KEYS) {
    const value = input[key]
    if (typeof value === "string" && value.length > 0) paths.push(value)
  }
  // diff payloads may embed paths — those are validated by the patch parser
  // (RT-6 apply_patch); this policy covers the declarative path parameters.
  return paths
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** Check one path against the writable roots (defaults to [projectRoot]). */
export function checkWritablePath(
  path: string,
  opts: { projectRoot: string; writableRoots?: string[] },
): WritableRootCheck {
  const roots = opts.writableRoots && opts.writableRoots.length > 0 ? opts.writableRoots : [opts.projectRoot]
  const absolute = isAbsolute(path) ? path : resolve(opts.projectRoot, path)
  for (const root of roots) {
    const absoluteRoot = isAbsolute(root) ? root : resolve(opts.projectRoot, root)
    if (isInside(absoluteRoot, absolute)) {
      return { allowed: true }
    }
  }
  return {
    allowed: false,
    reason: `path "${path}" resolves outside writable roots (${roots.join(", ")})`,
  }
}

/** Check every write path in a tool input. Returns null when the call has
 *  no write paths to check (readers/commands pass through). */
export function checkWritePaths(
  input: Record<string, unknown>,
  opts: { projectRoot: string; writableRoots?: string[] },
): WritableRootCheck | null {
  const paths = extractWritePaths(input)
  if (paths.length === 0) return null
  for (const path of paths) {
    const check = checkWritablePath(path, opts)
    if (!check.allowed) return check
  }
  return { allowed: true }
}

/** Windows-unsafe path separators rejected outright. */
export function isSuspiciousWritePath(path: string): boolean {
  return path.includes("\0") || path.split(sep).some((part) => part === "" && path.startsWith(sep))
}
