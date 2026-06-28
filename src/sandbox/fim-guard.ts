/** FIM Safety Guard — transaction protection for Fill-in-the-Middle edits.
 *
 *  PR-6.5: Wraps FimEditor with safety constraints:
 *    - Forbidden file check (no .git/.env/node_modules/.pem)
 *    - Scope validation (only files in active node's scope)
 *    - Transaction ID tracking (txn_fim_* format)
 *    - Pre-edit hash for rollback
 *    - Base-hash check before applying (TOCTOU guard)
 *
 *  Design: FimGuard is a pure safety wrapper. It does NOT perform the
 *  edit itself — it validates, then delegates to FimEditor, and finally
 *  wraps the result with transaction metadata.
 */

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { sep } from "node:path"
import { isForbiddenPath } from "./forbidden-patterns"

// ── Types ──

export interface FimSafetyContext {
  /** Active patch context scope (files the current node is allowed to touch). */
  scope?: string[]
  /** Whether the current node requires verification after edits. */
  requiresVerification?: boolean
  /** Verification kinds required. */
  verificationKinds?: string[]
}

export interface FimGuardResult {
  allowed: boolean
  reason?: string
  /** Transaction ID if allowed (txn_fim_<hash>). */
  txId?: string
  /** Pre-edit SHA256 hash for rollback. */
  preEditHash?: string
  /** Required verification after edit. */
  requiredVerification?: string[]
}

// ── Helpers ──

function isForbiddenFile(filePath: string): boolean {
  return isForbiddenPath(filePath) !== null
}

/** Path-suffix based scope check. Uses directory boundaries ("/" anchors)
 *  to prevent overscope-by-substring (e.g. scope "src/a" matching "src/a_secret/").
 *
 *  Scope entries without trailing "/" are treated as exact file matches.
 *  Scope entries with trailing "/" are treated as directory prefixes. */
function isInScope(filePath: string, scope: string[]): boolean {
  if (scope.length === 0) return true
  // Anchor with "/" prefix so boundary checks work against any path prefix
  const normalized = "/" + filePath.replace(/\\/g, "/").toLowerCase()
  return scope.some(s => {
    let sNorm = s.replace(/\\/g, "/").toLowerCase()
    const isDir = sNorm.endsWith("/")
    if (!sNorm.startsWith("/")) sNorm = "/" + sNorm
    if (isDir) {
      // Directory scope: path must contain /scopeDir/ as a proper segment
      return normalized.includes(sNorm) || normalized.startsWith(sNorm)
    } else {
      // File scope: exact path suffix match (boundary via "/" prefix anchor)
      return normalized.endsWith(sNorm)
    }
  })
}

function generateFimTxId(filePath: string): string {
  const hash = createHash("sha256")
    .update(`${filePath}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 12)
  return `txn_fim_${hash}`
}

async function computeFileHash(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath)
    return createHash("sha256").update(content).digest("hex").slice(0, 16)
  } catch {
    return null
  }
}

// ── Main API ──

/**
 * Check whether a FIM edit is safe to perform.
 *
 * Returns a FimGuardResult — if allowed=false, the edit should be rejected.
 * If allowed=true, the caller receives txId, preEditHash, and requiredVerification.
 */
export async function checkFimSafety(
  filePath: string,
  ctx: FimSafetyContext,
): Promise<FimGuardResult> {
  // 1. Forbidden file check
  if (isForbiddenFile(filePath)) {
    return {
      allowed: false,
      reason: `FIM 安全守卫: 禁止编辑受保护文件 ${filePath}`,
    }
  }

  // 2. Scope validation
  if (ctx.scope && ctx.scope.length > 0 && !isInScope(filePath, ctx.scope)) {
    return {
      allowed: false,
      reason: `FIM 安全守卫: ${filePath} 不在当前节点 scope 内 (${ctx.scope.join(", ")})`,
    }
  }

  // 3. File existence check
  if (!existsSync(filePath)) {
    return {
      allowed: false,
      reason: `FIM 安全守卫: 文件不存在 ${filePath}`,
    }
  }

  // 4. Pre-edit hash
  const preEditHash = await computeFileHash(filePath)
  if (!preEditHash) {
    return {
      allowed: false,
      reason: `FIM 安全守卫: 无法读取文件哈希 ${filePath}`,
    }
  }

  // 5. Generate transaction ID
  const txId = generateFimTxId(filePath)

  // 6. Required verification
  const requiredVerification = ctx.requiresVerification
    ? ctx.verificationKinds ?? ["typecheck"]
    : undefined

  return {
    allowed: true,
    txId,
    preEditHash,
    requiredVerification,
  }
}

/**
 * Verify that the file hasn't changed since the pre-edit hash (TOCTOU guard).
 * Call this AFTER the FIM edit to ensure no concurrent modification.
 */
export async function verifyFimPreEditHash(
  filePath: string,
  expectedHash: string,
): Promise<{ valid: boolean; currentHash?: string }> {
  const currentHash = await computeFileHash(filePath)
  if (!currentHash) {
    return { valid: false, currentHash: undefined }
  }
  return { valid: currentHash === expectedHash, currentHash }
}

/**
 * Check if a FIM edit is allowed without computing hashes (fast pre-check).
 */
export function quickFimCheck(
  filePath: string,
  ctx: FimSafetyContext,
): { allowed: boolean; reason?: string } {
  if (isForbiddenFile(filePath)) {
    return {
      allowed: false,
      reason: `FIM 安全守卫: 禁止编辑受保护文件 ${filePath}`,
    }
  }
  if (ctx.scope && ctx.scope.length > 0 && !isInScope(filePath, ctx.scope)) {
    return {
      allowed: false,
      reason: `FIM 安全守卫: ${filePath} 不在当前节点 scope 内`,
    }
  }
  return { allowed: true }
}

/**
 * Format a FIM guard result as a user-visible message.
 */
export function formatFimGuardResult(result: FimGuardResult): string {
  if (result.allowed) {
    const parts = [`FIM 安全守卫: ✅ 通过 — ${result.txId}`]
    if (result.requiredVerification?.length) {
      parts.push(`  需要验证: ${result.requiredVerification.join(", ")}`)
    }
    return parts.join("\n")
  }
  return `FIM 安全守卫: ❌ 阻止 — ${result.reason}`
}
