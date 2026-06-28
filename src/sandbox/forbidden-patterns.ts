/** Canonical forbidden-file patterns — single source of truth.
 *
 *  PR-6.5-post-review: All consumers (patch-transaction, tool-risk, fim-guard,
 *  side-effect-guard) MUST reference this file instead of maintaining their
 *  own divergent lists. Adding a new forbidden pattern here protects all paths.
 *
 *  Categories:
 *    - SECRET_FILES: credential/key files that must never be written
 *    - RUNTIME_INTERNAL: the agent's own runtime/state directories
 *    - VCS_INTERNAL: version control internals
 */

// ── Secret / credential files ──

/** Files containing secrets, keys, or credentials — writing to these is
 *  always forbidden regardless of scope or context. */
export const FORBIDDEN_SECRET_FILES = [
  /\.env(\..*)?$/,         // .env, .env.local, .env.production
  /\.pem$/,                 // PEM certificate/key files
  /id_rsa$/,                // SSH private key
  /id_ecdsa$/,              // SSH ECDSA private key
  /id_ed25519$/,            // SSH Ed25519 private key
  /credentials\.json$/,     // GCP/AWS credential files
  /\.htpasswd$/,            // Apache password file
  /secret\.ya?ml$/i,        // Kubernetes secret manifests
]

// ── Runtime / internal directories ──

/** Directories that belong to the agent or package ecosystem —
 *  writing into these corrupts the agent's own state or node_modules. */
export const FORBIDDEN_RUNTIME_DIRS = [
  /(^|\/)\.deepseek-code\b/,
  /(^|\/)\.codegraph\b/,
  /(^|\/)\.wolf\b/,
  /(^|\/)node_modules\b/,
]

// ── Version control internals ──

/** Git internals — writing to .git bypasses version control. */
export const FORBIDDEN_VCS_DIRS = [
  /(^|\/)\.git\b/,
]

// ── Aggregate ──

/** All forbidden patterns, combined. Use this for blanket checks. */
export const ALL_FORBIDDEN_PATTERNS: RegExp[] = [
  ...FORBIDDEN_SECRET_FILES,
  ...FORBIDDEN_RUNTIME_DIRS,
  ...FORBIDDEN_VCS_DIRS,
]

import { resolve, relative, sep } from "node:path"

// ── Query ──

/** Check if a file path matches any forbidden pattern.
 *
 *  Paths are normalized (backslash → forward slash) before matching.
 *  Returns the matching pattern's string representation, or null if allowed.
 */
export function isForbiddenPath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/")
  for (const pattern of ALL_FORBIDDEN_PATTERNS) {
    if (pattern.test(normalized)) {
      return pattern.source
    }
  }
  return null
}

/** Check if a path would escape the project root (e.g. "../../etc/passwd"). */
export function isOutsideProjectRoot(
  filePath: string,
  projectRoot: string = process.cwd(),
): boolean {
  try {
    const resolved = resolve(filePath)
    const rel = relative(projectRoot, resolved)
    return rel.startsWith("..") || (sep === "\\" && !resolved.toLowerCase().startsWith(projectRoot.toLowerCase()))
  } catch {
    return true // Can't resolve → treat as outside root
  }
}
