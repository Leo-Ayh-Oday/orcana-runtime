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
import { dirname, join, relative, resolve } from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { FORBIDDEN_SECRET_FILES } from "../sandbox/forbidden-patterns"
import type { VerificationKind } from "../verification/result"
import type { FileTransaction, TransactionSnapshot } from "../tools/transaction"
import { createTransaction, rollbackTransaction } from "../tools/transaction"

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

  // PR-6.5-review: also block secret/credential files at the transaction layer
  const relLower = rel.toLowerCase()
  for (const pattern of FORBIDDEN_SECRET_FILES) {
    if (pattern.test(relLower)) {
      return { allowed: false, reason: `禁止写入敏感文件: ${rel}` }
    }
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

// ═══════════════════════════════════════════════════════════════
// PR-4.1: PatchTransaction State Machine
//
//   proposed ──→ applied_to_temp ──→ verified ──→ committed
//       │               │                 │              │
//       └───────────────┴─────────────────┴──────────────┘
//                         rolled_back  (from any state)
//
//  Key invariants:
//    - State transitions are monotonic forward; only rollback goes backward
//    - Temp files live in .deepseek-code/patches/<txId>/  (same filesystem → atomic rename)
//    - commit() does atomic rename (temp → target), then cleans up temp dir
//    - rollback() cleans up temp files and marks rolled_back
// ═══════════════════════════════════════════════════════════════

import { renameSync, rmSync } from "node:fs"

/** PatchTransaction lifecycle states. */
export type PatchState = "proposed" | "applied_to_temp" | "verified" | "committed" | "rolled_back"

/** Valid forward transitions. */
const VALID_TRANSITIONS: Record<PatchState, PatchState[]> = {
  proposed: ["applied_to_temp", "rolled_back"],
  applied_to_temp: ["verified", "rolled_back"],
  verified: ["committed", "rolled_back"],
  committed: ["rolled_back"],
  rolled_back: [],
}

/** Per-file entry in a managed transaction. */
export interface ManagedFileEntry {
  /** Relative path to the target file (from cwd). */
  relativePath: string
  /** Absolute path to the target file. */
  absolutePath: string
  /** Old content (null for new files). */
  oldContent: string | null
  /** New content to write. */
  newContent: string
  /** Expected base hash before write. */
  expectedBaseHash: string | null
  /** Temp file path after applyToTemp. */
  tempPath?: string
}

/** A PatchTransaction tracked by the state machine.
 *
 *  NOTE: For multi-file transactions (e.g. multi_edit), the `patch` field
 *  represents metadata from only the first file (diff, baseHash, path).
 *  Per-file data is in `files[]`. The `FileTransaction` snapshot in
 *  `patch.fileTransaction` correctly captures all paths. */
export interface ManagedPatchTransaction {
  /** Unique transaction ID (from the underlying PatchTransaction). */
  txId: string
  /** Current state. */
  state: PatchState
  /** The underlying PatchTransaction (created on init, immutable). */
  patch: PatchTransaction
  /** File entries in this transaction. */
  files: ManagedFileEntry[]
  /** Working directory for temp paths. */
  cwd: string
  /** Timestamps for each state transition. */
  stateTimestamps: Partial<Record<PatchState, number>>
  /** Error message if rolled back. */
  rollbackReason?: string
}

// ── Transaction registry (module-level, cleared per session) ──

const txRegistry = new Map<string, ManagedPatchTransaction>()

/** Get all managed transactions (active and completed). */
export function getAllManagedTransactions(): ManagedPatchTransaction[] {
  return [...txRegistry.values()]
}

/** Get a managed transaction by ID. */
export function getManagedTransaction(txId: string): ManagedPatchTransaction | undefined {
  return txRegistry.get(txId)
}

/** Clear the transaction registry (for test teardown). */
export function clearTransactionRegistry(): void {
  txRegistry.clear()
}

// ── Temp directory helpers ──

/** Root directory for all patch temp files. */
function patchesRoot(cwd: string): string {
  return resolve(cwd, ".deepseek-code", "patches")
}

/** Temp directory for a specific transaction. */
function txTempDir(txId: string, cwd: string): string {
  return join(patchesRoot(cwd), txId)
}

/** Temp file path for a specific file in a transaction. */
function txTempPath(txId: string, relativePath: string, cwd: string): string {
  return join(txTempDir(txId, cwd), relativePath)
}

// ── State validation ──

function assertTransition(current: PatchState, next: PatchState, txId: string): void {
  const allowed = VALID_TRANSITIONS[current]
  if (!allowed || !allowed.includes(next)) {
    throw new Error(
      `[PatchTransaction ${txId}] 非法状态转换: ${current} → ${next}。` +
      `允许的转换: ${allowed?.join(", ") ?? "无"}`
    )
  }
}

// ── State machine operations ──

export interface InitManagedTxInput {
  tool: string
  files: Array<{
    relativePath: string
    oldContent: string | null
    newContent: string
    expectedBaseHash?: string | null
  }>
  scope?: string[]
  verification?: VerificationKind[]
  cwd?: string
}

/** Initialize a managed PatchTransaction in "proposed" state.
 *  Creates the underlying PatchTransaction (with first file) and registers it.
 *  Does NOT write anything to disk yet. */
export function initManagedTransaction(input: InitManagedTxInput): ManagedPatchTransaction {
  const cwd = resolve(input.cwd ?? process.cwd())
  const firstFile = input.files[0]
  if (!firstFile) throw new Error("initManagedTransaction: 至少需要一个文件")

  // Build file entries
  const entries: ManagedFileEntry[] = input.files.map(f => ({
    relativePath: f.relativePath.replace(/\\/g, "/"),
    absolutePath: resolve(cwd, f.relativePath),
    oldContent: f.oldContent,
    newContent: f.newContent,
    expectedBaseHash: f.expectedBaseHash ?? null,
  }))

  // Forbidden file gate — reject before creating any disk artifacts
  for (const entry of entries) {
    const forbidden = checkForbiddenFile(entry.relativePath, cwd)
    if (!forbidden.allowed) {
      throw new Error(
        `initManagedTransaction: 禁止写入 ${entry.relativePath}: ${forbidden.reason}`
      )
    }
  }

  // Create the underlying PatchTransaction using the first file
  // (the fileTransaction snapshot captures all paths)
  const ft = createTransaction({
    tool: input.tool,
    paths: entries.map(e => e.absolutePath),
    cwd,
  })

  const patch = createPatchTransaction({
    tool: input.tool,
    path: firstFile.relativePath,
    oldContent: firstFile.oldContent,
    newContent: firstFile.newContent,
    fileTransaction: ft,
    scope: input.scope,
    verification: input.verification,
    cwd,
  })

  const mpt: ManagedPatchTransaction = {
    txId: patch.txId,
    state: "proposed",
    patch,
    files: entries,
    cwd,
    stateTimestamps: { proposed: Date.now() },
  }

  txRegistry.set(mpt.txId, mpt)
  return mpt
}

/** Write all files to temp directory. Transitions proposed → applied_to_temp.
 *
 *  Writes each file's newContent to .deepseek-code/patches/<txId>/<relativePath>.
 *  Creates parent directories as needed. Does NOT touch the target files. */
export function applyToTemp(mpt: ManagedPatchTransaction): ManagedPatchTransaction {
  assertTransition(mpt.state, "applied_to_temp", mpt.txId)

  const tempDir = txTempDir(mpt.txId, mpt.cwd)

  // Clean any existing temp dir (idempotent retry)
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true })
  }

  for (const entry of mpt.files) {
    const tempPath = txTempPath(mpt.txId, entry.relativePath, mpt.cwd)
    mkdirSync(dirname(tempPath), { recursive: true })
    writeFileSync(tempPath, entry.newContent, "utf-8")
    entry.tempPath = tempPath
  }

  mpt.state = "applied_to_temp"
  mpt.stateTimestamps.applied_to_temp = Date.now()
  return mpt
}

/** Mark the transaction as verified. Transitions applied_to_temp → verified.
 *
 *  Call this after running typecheck/test on the temp files.
 *  Does NOT modify any files on disk. */
export function verifyManagedTransaction(mpt: ManagedPatchTransaction): ManagedPatchTransaction {
  assertTransition(mpt.state, "verified", mpt.txId)
  mpt.state = "verified"
  mpt.stateTimestamps.verified = Date.now()
  return mpt
}

/** Atomically commit all files. Transitions verified → committed.
 *
 *  For each file entry:
 *    1. If target exists, it's overwritten by renaming temp → target
 *    2. If target is new, temp file is renamed to target
 *    3. Parent directories created as needed
 *
 *  After all files are moved, the temp directory is cleaned up.
 *  This is atomic per-file (rename on same filesystem), but NOT atomic across files
 *  (multi-file transactions can partially fail — the caller should handle this). */
export function commitManagedTransaction(mpt: ManagedPatchTransaction): ManagedPatchTransaction {
  assertTransition(mpt.state, "committed", mpt.txId)

  const committed: string[] = []
  try {
    for (const entry of mpt.files) {
      const tempPath = entry.tempPath
      if (!tempPath || !existsSync(tempPath)) {
        throw new Error(`Temp file missing for ${entry.relativePath}: ${tempPath ?? "未设置 tempPath"}`)
      }

      // Base-hash TOCTOU guard: verify target file hasn't changed since oldContent was captured.
      // Skip for new files (expectedBaseHash is null).
      if (entry.expectedBaseHash !== null) {
        const diskHash = readFileHash(entry.absolutePath)
        if (diskHash !== null && diskHash !== entry.expectedBaseHash) {
          throw new Error(
            `[PatchTransaction ${mpt.txId}] Base hash 不匹配: ${entry.relativePath}。` +
            `期望 ${entry.expectedBaseHash}, 实际 ${diskHash}。文件可能在事务期间被外部修改。`
          )
        }
      }

      mkdirSync(dirname(entry.absolutePath), { recursive: true })
      renameSync(tempPath, entry.absolutePath)
      committed.push(entry.absolutePath)
    }
  } catch (err) {
    // Partial commit — throw; the transaction.ts rollbackSnapshot is the safety net
    const errMsg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `[PatchTransaction ${mpt.txId}] commit 失败: ${errMsg}。` +
      `已提交 ${committed.length}/${mpt.files.length} 个文件。`
    )
  }

  // Clean up temp directory
  const tempDir = txTempDir(mpt.txId, mpt.cwd)
  try { rmSync(tempDir, { recursive: true, force: true }) } catch (err) {
    // best-effort cleanup; log for diagnostics
    if (process.env.DEEPSEEK_DEBUG) {
      console.warn(`[PatchTransaction ${mpt.txId}] temp cleanup failed: ${err}`)
    }
  }

  // Auto-purge from registry after commit (keep last N via telemetry if needed later)
  txRegistry.delete(mpt.txId)

  mpt.state = "committed"
  mpt.stateTimestamps.committed = Date.now()
  return mpt
}

/** Roll back the transaction from any state. Transitions → rolled_back.
 *
 *  Cleans up temp files if they exist. Does NOT revert committed files
 *  (that's handled by transaction.ts rollbackTransaction using snapshots).
 *
 *  IMPORTANT: When called after commit, this only marks the transaction as "rolled_back"
 *  for record-keeping. Files remain on disk unchanged. For actual file reversion after
 *  commit, use `rollbackTransaction(mpt.patch.fileTransaction.id)` from transaction.ts.
 *
 *  This is idempotent — calling it on an already-rolled-back transaction is a no-op. */
export function rollbackManagedTransaction(
  mpt: ManagedPatchTransaction,
  reason?: string,
): ManagedPatchTransaction {
  // rolled_back is a no-op
  if (mpt.state === "rolled_back") return mpt

  mpt.rollbackReason = reason ?? "manual rollback"

  // Clean up temp directory if it exists
  const tempDir = txTempDir(mpt.txId, mpt.cwd)
  if (existsSync(tempDir)) {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch (err) {
      if (process.env.DEEPSEEK_DEBUG) {
        console.warn(`[PatchTransaction ${mpt.txId}] rollback temp cleanup failed: ${err}`)
      }
    }
  }

  // Clear temp paths
  for (const entry of mpt.files) {
    entry.tempPath = undefined
  }

  // Auto-purge from registry after rollback
  txRegistry.delete(mpt.txId)

  mpt.state = "rolled_back"
  mpt.stateTimestamps.rolled_back = Date.now()
  return mpt
}

/**
 * Full lifecycle: propose → apply → verify → commit.
 * Rolls back on any failure. Returns the final state.
 *
 * @param verify — Callback that runs after temp files are written but before commit.
 *   Receives the ManagedPatchTransaction in "applied_to_temp" state.
 *   Return `true` to proceed to commit, `false` to roll back.
 *   Throw to roll back with the error as rollback reason.
 *
 *   **Contract:** The verify callback MUST be read-only. It MUST NOT mutate
 *   `mpt.files`, `mpt.patch`, or any other field on the transaction.
 *   Mutations will persist into the committed transaction, bypassing validation.
 */
export async function applyAndCommit(
  input: InitManagedTxInput,
  verify: (mpt: ManagedPatchTransaction) => Promise<boolean>,
): Promise<ManagedPatchTransaction> {
  const mpt = initManagedTransaction(input)
  try {
    applyToTemp(mpt)
    const ok = await verify(mpt)
    if (!ok) {
      return rollbackManagedTransaction(mpt, "verification failed")
    }
    verifyManagedTransaction(mpt)
    commitManagedTransaction(mpt)
    return mpt
  } catch (err) {
    if (mpt.state !== "committed" && mpt.state !== "rolled_back") {
      // Revert partial commits via FileTransaction snapshots (multi-file safety net)
      if (mpt.patch?.fileTransaction) {
        try { rollbackTransaction(mpt.patch.fileTransaction.id, mpt.cwd) } catch {
          /* best-effort reversion */
        }
      }
      rollbackManagedTransaction(mpt, err instanceof Error ? err.message : String(err))
    }
    // Always re-throw so callers can handle errors (e.g. Result.fail in file.ts)
    throw err
  }
}

// ── Serialization for managed transactions ──

export function serializeManagedTransaction(mpt: ManagedPatchTransaction): Record<string, unknown> {
  return {
    txId: mpt.txId,
    state: mpt.state,
    patch: serializePatchTransaction(mpt.patch),
    files: mpt.files.map(f => ({
      relativePath: f.relativePath,
      oldContent: f.oldContent?.slice(0, 200) ?? null,
      newContent: f.newContent.slice(0, 200),
      expectedBaseHash: f.expectedBaseHash,
    })),
    stateTimestamps: mpt.stateTimestamps,
    rollbackReason: mpt.rollbackReason,
  }
}
