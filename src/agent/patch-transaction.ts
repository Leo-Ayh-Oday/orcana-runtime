/** [PR 5] PatchTransaction — transactional write layer.
 *
 *  Every file mutation is wrapped in a PatchTransaction that carries:
 *    txId      — unique transaction identifier
 *    baseHash  — SHA256 of file content BEFORE the mutation
 *    diff      — what changed (line-diff, ± line count)
 *    scope     — why this change is being made (from active TaskPacket)
 *    verification — what verification is required (from active TaskPacket)
 *
 *  Pre-write checks:
 *    1. Base hash mismatch → reject (another process changed the file)
 *    2. Forbidden file → reject (runtime artifacts, .git, outside root)
 *
 *  Phase 1 (current): read hash → check preconditions → write → generate diff
 *  Phase 2 (future, PR 8): apply to temp → verify → atomically swap
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { createHash, randomBytes } from "node:crypto"
import type { VerificationKind } from "../verification/result"
import type { FileTransaction, TransactionSnapshot } from "../tools/transaction"

// ── PatchTransaction types ──

export interface PatchTransaction {
  /** Unique transaction ID. */
  txId: string
  /** SHA256 of file content before the mutation (hex, 16 chars). */
  baseHash: string | null  // null when creating a new file
  /** Human-readable summary of the diff. */
  diff: string
  /** What files are in scope (from active TaskPacket). */
  scope: string[]
  /** Required verification kinds (from active TaskPacket). */
  verification: VerificationKind[]
  /** Whether forbidden-file check passed. */
  forbiddenCheck: { passed: boolean; reason?: string }
  /** The underlying FileTransaction for rollback. */
  fileTransaction: FileTransaction
  createdAt: number
}

// ── Forbidden file patterns ──

const FORBIDDEN_PREFIXES = [
  ".git/",
  ".deepseek-code/",
  "node_modules/",
  ".codegraph/",
  ".wolf/",
]

const FORBIDDEN_EXACT = new Set([
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
])

function isRuntimeInternal(path: string): boolean {
  // Normalize to lowercase for case-insensitive filesystem safety (Windows)
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()
  if (FORBIDDEN_EXACT.has(normalized)) return true
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (normalized.startsWith(prefix)) return true
  }
  return false
}

/** Check if a path is outside the project root (escape attempt). */
function isOutsideRoot(absolutePath: string, cwd: string): boolean {
  const rel = relative(cwd, absolutePath)
  if (!rel) return false // same directory
  return rel.startsWith("..") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)
}

// ── Base hash ──

export function computeBaseHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

export function readFileHash(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    const content = readFileSync(path, "utf-8")
    return computeBaseHash(content)
  } catch {
    return null
  }
}

export interface HashCheckResult {
  match: boolean
  expected: string | null
  actual: string | null
}

/** Verify that the file on disk matches the expected base hash.
 *  Returns mismatch when another process modified the file between read and write. */
export function checkBaseHash(path: string, expectedHash: string | null): HashCheckResult {
  const actual = readFileHash(path)
  if (expectedHash === null) {
    // New file — no previous hash to check
    return { match: true, expected: null, actual: null }
  }
  if (actual === null) {
    // File existed before but is now gone
    return { match: false, expected: expectedHash, actual: null }
  }
  return { match: actual === expectedHash, expected: expectedHash, actual }
}

// ── Forbidden file check ──

export interface ForbiddenCheckResult {
  allowed: boolean
  reason?: string
}

export function checkForbiddenFile(path: string, cwd = process.cwd()): ForbiddenCheckResult {
  // Resolve to absolute path for containment check
  let absolute: string
  try {
    absolute = resolve(cwd, path)
  } catch {
    return { allowed: false, reason: `无效路径: ${path}` }
  }

  if (isOutsideRoot(absolute, resolve(cwd))) {
    return { allowed: false, reason: `路径在项目根目录之外: ${path}` }
  }

  const rel = relative(resolve(cwd), absolute).replace(/\\/g, "/")

  if (isRuntimeInternal(rel)) {
    return { allowed: false, reason: `禁止写入运行时文件: ${rel}` }
  }

  return { allowed: true }
}

// ── Diff generation ──

export interface SimpleDiff {
  header: string
  stats: { added: number; removed: number; unchanged: number }
  hunks: string[]
}

/** Generate a simple line-based diff between old and new content. */
export function generateLineDiff(
  oldContent: string | null,
  newContent: string,
  path: string,
): SimpleDiff {
  function splitLines(s: string): string[] {
    const lines = s.split("\n")
    // Strip trailing empty string from final newline
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop()
    }
    return lines
  }

  const oldLines = oldContent === null ? [] : splitLines(oldContent)
  const newLines = splitLines(newContent)

  // Count line-level changes (not a full Myers diff — that's for PR 8)
  const oldSet = new Set(oldLines)
  const newSet = new Set(newLines)

  let added = 0
  let removed = 0
  let unchanged = 0

  for (const line of newLines) {
    if (oldSet.has(line)) {
      unchanged++
    } else {
      added++
    }
  }

  for (const line of oldLines) {
    if (!newSet.has(line)) {
      removed++
    }
  }

  const action = oldContent === null
    ? "创建"
    : newContent.length > oldContent.length
      ? `修改 (+${newContent.length - oldContent.length} chars)`
      : `修改 (${newContent.length - oldContent.length} chars)`

  return {
    header: oldContent === null
      ? `--- /dev/null\n+++ ${path}\n`
      : `--- ${path} (base)\n+++ ${path} (patch)\n`,
    stats: { added, removed, unchanged },
    hunks: [
      `@@ ${action}: +${added} -${removed} (${unchanged} unchanged) @@`,
      oldContent === null
        ? `新建文件, ${newLines.length} 行`
        : `${oldLines.length} → ${newLines.length} 行`,
    ],
  }
}

/** Format a SimpleDiff as a compact human-readable string. */
export function formatDiff(diff: SimpleDiff): string {
  const parts = [
    diff.header,
    `@@ 统计: +${diff.stats.added} -${diff.stats.removed} (${diff.stats.unchanged}) @@`,
    ...diff.hunks,
  ]
  return parts.join("\n")
}

// ── Active patch context (set by loop.ts when node transitions) ──

interface ActivePatchContext {
  scope: string[]
  verification: VerificationKind[]
  nodeId: string
}

let activePatch: ActivePatchContext | null = null

/** Set the active patch context from the current node's TaskPacket.
 *  Called by loop.ts when a node becomes active. */
export function setActivePatchContext(opts: {
  scope: string[]
  verification: VerificationKind[]
  nodeId: string
}): void {
  activePatch = { ...opts }
}

export function getActivePatchContext(): ActivePatchContext | null {
  return activePatch
}

export function clearActivePatchContext(): void {
  activePatch = null
}

// ── PatchTransaction factory ──

export interface CreatePatchInput {
  tool: string
  path: string
  oldContent: string | null
  newContent: string
  /** FileTransaction from the base transaction layer. */
  fileTransaction: FileTransaction
  /** Optional override scope (falls back to active patch context). */
  scope?: string[]
  /** Optional override verification (falls back to active patch context). */
  verification?: VerificationKind[]
  cwd?: string
}

/** Create a full PatchTransaction with all PR 5 fields.
 *
 *  Performs:
 *    1. Forbidden file check
 *    2. Base hash computation
 *    3. Diff generation
 *    4. Scope/verification attachment from active patch context
 */
export function createPatchTransaction(input: CreatePatchInput): PatchTransaction {
  const cwd = resolve(input.cwd ?? process.cwd())
  const absolutePath = resolve(cwd, input.path)
  const relPath = relative(resolve(cwd), absolutePath).replace(/\\/g, "/")

  // 1. Forbidden file check
  const forbiddenCheck = checkForbiddenFile(relPath, cwd)

  // 2. Base hash
  const baseHash = input.oldContent !== null
    ? computeBaseHash(input.oldContent)
    : null

  // 3. Diff
  const diff: SimpleDiff = generateLineDiff(input.oldContent, input.newContent, relPath)

  // 4. Scope/verification — from input override, then active context, then defaults
  const ctx = getActivePatchContext()
  const scope = input.scope ?? ctx?.scope ?? [relPath]
  const verification = input.verification ?? ctx?.verification ?? ["typecheck"]

  return {
    txId: `ptxn_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`,
    baseHash,
    diff: formatDiff(diff),
    scope,
    verification,
    forbiddenCheck: forbiddenCheck.allowed
      ? { passed: true }
      : { passed: false, reason: forbiddenCheck.reason },
    fileTransaction: input.fileTransaction,
    createdAt: Date.now(),
  }
}

// ── Pre-write guard ──

export interface PreWriteCheck {
  allowed: boolean
  reason?: string
  patchTransaction?: PatchTransaction
}

/**
 * Run all pre-write checks and return a PatchTransaction if allowed.
 * This is the single entry point that write tools should call before mutating disk.
 *
 * Checks (in order):
 *   1. Forbidden file → reject
 *   2. Base hash mismatch → reject (mid-air conflict)
 */
export function preWriteCheck(input: {
  tool: string
  path: string
  oldContent: string | null
  newContent: string
  expectedBaseHash?: string | null
  fileTransaction: FileTransaction
  scope?: string[]
  verification?: VerificationKind[]
  cwd?: string
}): PreWriteCheck {
  const cwd = resolve(input.cwd ?? process.cwd())
  const absolutePath = resolve(cwd, input.path)

  // 1. Forbidden file check
  const forbidden = checkForbiddenFile(input.path, cwd)
  if (!forbidden.allowed) {
    return { allowed: false, reason: forbidden.reason }
  }

  // 2. Base hash check (when expected hash provided)
  if (input.expectedBaseHash !== undefined) {
    const hashCheck = checkBaseHash(absolutePath, input.expectedBaseHash ?? null)
    if (!hashCheck.match) {
      return {
        allowed: false,
        reason: `Base hash 不匹配: 期望 ${hashCheck.expected ?? "null"}, 实际 ${hashCheck.actual ?? "null"}。文件可能被外部修改。`,
      }
    }
  }

  // All checks passed — create the PatchTransaction
  const patchTransaction = createPatchTransaction({
    tool: input.tool,
    path: input.path,
    oldContent: input.oldContent,
    newContent: input.newContent,
    fileTransaction: input.fileTransaction,
    scope: input.scope,
    verification: input.verification,
    cwd,
  })

  return { allowed: true, patchTransaction }
}

// ── Serialization for session persistence ──

export function serializePatchTransaction(pt: PatchTransaction): Record<string, unknown> {
  return {
    txId: pt.txId,
    baseHash: pt.baseHash,
    diff: pt.diff.slice(0, 1000),
    scope: pt.scope,
    verification: pt.verification,
    forbiddenCheck: pt.forbiddenCheck,
    fileTransactionId: pt.fileTransaction.id,
    createdAt: pt.createdAt,
  }
}
