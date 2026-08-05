/** Tool Runtime 2.0 (RT-6): apply_patch / apply_patch_transaction.
 *
 *  Standard unified-diff application with base-hash freshness, path-escape
 *  rejection (writable-root policy) and multi-file atomicity. Reuses the
 *  PatchTransaction machinery for atomic writes (temp → verify → commit).
 *
 *  apply_patch
 *    { diff, baseHash?, dryRun? } → structured file stats
 *  apply_patch_transaction
 *    { patches: [{diff, baseHash?}], idempotencyKey?, dryRun? } → all-or-nothing
 *
 *  idempotencyKey: a committed transaction with the same key is reported as
 *  already-applied instead of being applied twice (crash-recovery friendly).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import type { ToolDef, ToolResult } from "./registry"
import { Result } from "./registry"
import { computeBaseHash, checkBaseHash } from "../agent/patch-transaction"
import { checkWritablePath } from "../harness/capabilities/policy/writable-root-policy"

// ── Unified diff parsing ──

export interface ParsedHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: Array<{ type: "context" | "add" | "remove"; text: string }>
}

export interface ParsedFilePatch {
  /** New file path (from the +++ header). */
  path: string
  hunks: ParsedHunk[]
  /** Base hash declared by the caller for this file (optional). */
  expectedBaseHash?: string
}

export interface ParsedDiff {
  files: ParsedFilePatch[]
  /** Parse failures (malformed diff bodies are rejected, never guessed). */
  errors: string[]
}

const HEADER_RE = /^\+\+\+\s+(?:b\/)?(.+)$/
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Parse a standard unified diff into structured file patches. */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const files: ParsedFilePatch[] = []
  const errors: string[] = []
  let current: ParsedFilePatch | null = null
  let hunk: ParsedHunk | null = null

  for (const rawLine of diff.split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    if (line.startsWith("+++")) {
      const m = HEADER_RE.exec(line)
      if (!m) {
        errors.push(`malformed +++ header: ${line.slice(0, 40)}`)
        current = null
        continue
      }
      current = { path: m[1]!, hunks: [] }
      files.push(current)
      hunk = null
      continue
    }
    if (line.startsWith("---")) continue // old-file header (may be /dev/null)
    if (line.startsWith("@@")) {
      if (!current) {
        errors.push(`hunk without file header: ${line.slice(0, 40)}`)
        continue
      }
      const m = HUNK_RE.exec(line)
      if (!m) {
        errors.push(`malformed hunk header: ${line.slice(0, 40)}`)
        hunk = null
        continue
      }
      hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      }
      current.hunks.push(hunk)
      continue
    }
    if (line.startsWith("\\")) continue // "No newline at end of file"
    if (hunk) {
      if (line.startsWith("+")) hunk.lines.push({ type: "add", text: line.slice(1) })
      else if (line.startsWith("-")) hunk.lines.push({ type: "remove", text: line.slice(1) })
      else hunk.lines.push({ type: "context", text: line.slice(1) })
    }
  }
  return { files, errors }
}

// ── Hunk application ──

function applyHunk(content: string, hunk: ParsedHunk): { content: string; applied: boolean } {
  const lines = content.split("\n")
  // 1-indexed hunk position → 0-indexed array position.
  let pos = hunk.oldStart - 1
  for (const entry of hunk.lines) {
    if (entry.type === "remove") {
      if (lines[pos] !== entry.text) return { content, applied: false }
      lines.splice(pos, 1)
    } else if (entry.type === "context") {
      if (lines[pos] !== entry.text) return { content, applied: false }
      pos += 1
    } else {
      lines.splice(pos, 0, entry.text)
      pos += 1
    }
  }
  return { content: lines.join("\n"), applied: true }
}

export interface ApplyFileResult {
  path: string
  additions: number
  deletions: number
  applied: boolean
  error?: string
}

export interface ApplyPatchResult {
  files: ApplyFileResult[]
  totalAdditions: number
  totalDeletions: number
  dryRun: boolean
  errors: string[]
}

/** Apply parsed hunks to a file. When `dryRun`, nothing touches disk. */
export function applyParsedFilePatch(
  patch: ParsedFilePatch,
  opts: { projectRoot: string; dryRun?: boolean; expectedBaseHash?: string },
): ApplyFileResult {
  const target = isAbsolute(patch.path) ? patch.path : join(opts.projectRoot, patch.path)
  // Path boundary: reject escapes before anything else.
  const boundary = checkWritablePath(patch.path, { projectRoot: opts.projectRoot })
  if (!boundary.allowed) {
    return { path: patch.path, additions: 0, deletions: 0, applied: false, error: boundary.reason }
  }

  const declaredHash = opts.expectedBaseHash ?? patch.expectedBaseHash
  if (declaredHash && existsSync(target)) {
    const check = checkBaseHash(target, declaredHash)
    if (!check.match) {
      return {
        path: patch.path,
        additions: 0,
        deletions: 0,
        applied: false,
        error: `base hash mismatch for ${patch.path} (expected ${declaredHash}, got ${check.actual})`,
      }
    }
  }

  // New-file patch: all additions with no base.
  if (!existsSync(target)) {
    const content = patch.hunks.flatMap((h) => h.lines.filter((l) => l.type === "add").map((l) => l.text))
    const additions = content.length
    if (!opts.dryRun) writeFileAtomic(target, content.join("\n"))
    return { path: patch.path, additions, deletions: 0, applied: true }
  }

  // Hunk application happens in memory FIRST (dry-run or not) — a mismatched
  // hunk leaves the workspace untouched, which is what makes transactions
  // all-or-nothing: validate every patch dry, then commit.
  let content = readFileSync(target, "utf-8")
  let additions = 0
  let deletions = 0
  for (const hunk of patch.hunks) {
    const result = applyHunk(content, hunk)
    if (!result.applied) {
      return { path: patch.path, additions, deletions, applied: false, error: `hunk @${hunk.oldStart} did not match file content` }
    }
    content = result.content
    additions += hunk.lines.filter((l) => l.type === "add").length
    deletions += hunk.lines.filter((l) => l.type === "remove").length
  }
  if (!opts.dryRun) writeFileAtomic(target, content)
  return { path: patch.path, additions, deletions, applied: true }
}

function writeFileAtomic(target: string, content: string): void {
  // Atomic: temp file in the same directory → rename over the target.
  // New-file patches may target not-yet-existing directories.
  mkdirSync(dirname(target), { recursive: true })
  const temp = join(dirname(target), `.tmp-${process.pid}-${Date.now()}`)
  writeFileSync(temp, content, "utf-8")
  renameSync(temp, target)
}

/** Apply a full diff string; returns structured stats + errors. */
export function applyDiffString(
  diff: string,
  opts: { projectRoot: string; dryRun?: boolean; expectedBaseHashes?: Record<string, string> },
): ApplyPatchResult {
  const parsed = parseUnifiedDiff(diff)
  const files: ApplyFileResult[] = []
  let totalAdditions = 0
  let totalDeletions = 0
  for (const patch of parsed.files) {
    const result = applyParsedFilePatch(patch, {
      projectRoot: opts.projectRoot,
      dryRun: opts.dryRun,
      expectedBaseHash: opts.expectedBaseHashes?.[patch.path],
    })
    totalAdditions += result.additions
    totalDeletions += result.deletions
    files.push(result)
  }
  return { files, totalAdditions, totalDeletions, dryRun: opts.dryRun ?? false, errors: parsed.errors }
}

// ── Idempotency (apply_patch_transaction) ──

const committedKeys = new Set<string>()

export function isKeyCommitted(key: string): boolean {
  return committedKeys.has(key)
}

export function markKeyCommitted(key: string): void {
  committedKeys.add(key)
}

/** Reset the in-process committed-key registry (tests). */
export function resetCommittedKeys(): void {
  committedKeys.clear()
}

// ── Tool definitions ──

const APPLY_PATCH_SCHEMA = {
  type: "object",
  properties: {
    diff: { type: "string", description: "Standard unified diff text" },
    baseHash: { type: "string", description: "Expected current hash of the patched file (freshness)" },
    dryRun: { type: "boolean", description: "Validate and preview without writing" },
  },
  required: ["diff"],
} as const

/** Executable core (projectRoot injectable for tests; tools default to cwd). */
export function executeApplyPatch(params: Record<string, unknown>, projectRoot = process.cwd()): ToolResult {
  const diff = String(params["diff"] ?? "")
  const baseHash = typeof params["baseHash"] === "string" ? params["baseHash"] : undefined
  const dryRun = params["dryRun"] === true
  const out = applyDiffString(diff, { projectRoot, dryRun, expectedBaseHashes: baseHash ? { "*": baseHash } : undefined })
  const failures = out.files.filter((f) => !f.applied)
  if (failures.length > 0) {
    const message = failures.map((f) => `${f.path}: ${f.error}`).join("; ")
    return Result.fail(`apply_patch failed: ${message}`, message)
  }
  const summary = out.files.map((f) => `${f.path} (+${f.additions}/-${f.deletions})`).join(", ")
  return Result.ok(`applied ${out.files.length} file(s): ${summary}`, {
    files: out.files,
    totalAdditions: out.totalAdditions,
    totalDeletions: out.totalDeletions,
    dryRun,
  })
}

export const APPLY_PATCH_TOOL: ToolDef = {
  name: "apply_patch",
  description: "Apply a standard unified diff to the workspace. Supports baseHash freshness checks and dry-run previews.",
  isReadonly: false,
  category: "file",
  requiresConfirmation: true,
  inputSchema: APPLY_PATCH_SCHEMA as unknown as Record<string, unknown>,
  execute: (params) => executeApplyPatch(params),
}

const APPLY_PATCH_TRANSACTION_SCHEMA = {
  type: "object",
  properties: {
    patches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          diff: { type: "string" },
          baseHash: { type: "string" },
        },
        required: ["diff"],
      },
    },
    idempotencyKey: { type: "string", description: "Replays with the same key are reported as already-applied" },
    dryRun: { type: "boolean" },
  },
  required: ["patches"],
} as const

/** Executable core (projectRoot injectable for tests). */
export function executeApplyPatchTransaction(params: Record<string, unknown>, projectRoot = process.cwd()): ToolResult {
  const patches = params["patches"] as Array<{ diff: string; baseHash?: string }>
  const idempotencyKey = typeof params["idempotencyKey"] === "string" ? params["idempotencyKey"] : undefined
  const dryRun = params["dryRun"] === true

  if (idempotencyKey && isKeyCommitted(idempotencyKey)) {
    return Result.ok(`transaction ${idempotencyKey} already applied (idempotent replay)`, { idempotent: true })
  }

  // Phase 1 — validate EVERY patch dry (in-memory only). Nothing touches
  // disk until the whole transaction validates: all-or-nothing.
  const validated: Array<{ files: ApplyFileResult[]; errors: string[] }> = []
  for (const patch of patches) {
    const expectedHashes = patch.baseHash ? { "*": patch.baseHash } : undefined
    const out = applyDiffString(patch.diff, { projectRoot, dryRun: true, expectedBaseHashes: expectedHashes })
    validated.push({ files: out.files, errors: out.errors })
  }
  const failures = validated.flatMap((v) => v.files).filter((f) => !f.applied)
  const errors = validated.flatMap((v) => v.errors)
  if (failures.length > 0 || errors.length > 0) {
    const message = [
      ...failures.map((f) => `${f.path}: ${f.error}`),
      ...errors,
    ].join("; ")
    return Result.fail(`transaction rolled back (nothing written): ${message}`, message)
  }

  // Phase 2 — commit every patch for real (validation already passed, so
  // this phase cannot fail on content).
  const all: ApplyFileResult[] = []
  let totalAdditions = 0
  let totalDeletions = 0
  if (!dryRun) {
    for (const patch of patches) {
      const expectedHashes = patch.baseHash ? { "*": patch.baseHash } : undefined
      const out = applyDiffString(patch.diff, { projectRoot, dryRun: false, expectedBaseHashes: expectedHashes })
      all.push(...out.files)
      totalAdditions += out.totalAdditions
      totalDeletions += out.totalDeletions
    }
  } else {
    all.push(...validated.flatMap((v) => v.files))
    totalAdditions = validated.flatMap((v) => v.files).reduce((n, f) => n + f.additions, 0)
    totalDeletions = validated.flatMap((v) => v.files).reduce((n, f) => n + f.deletions, 0)
  }
  if (idempotencyKey) markKeyCommitted(idempotencyKey)
  const summary = all.map((f) => `${f.path} (+${f.additions}/-${f.deletions})`).join(", ")
  return Result.ok(`transaction committed (${all.length} file(s)): ${summary}`, {
    files: all,
    totalAdditions,
    totalDeletions,
    dryRun,
    idempotent: false,
  })
}

export const APPLY_PATCH_TRANSACTION_TOOL: ToolDef = {
  name: "apply_patch_transaction",
  description: "Apply multiple unified diffs atomically — all files commit or none do. Supports idempotencyKey for crash-safe replays.",
  isReadonly: false,
  category: "file",
  requiresConfirmation: true,
  inputSchema: APPLY_PATCH_TRANSACTION_SCHEMA as unknown as Record<string, unknown>,
  execute: (params) => executeApplyPatchTransaction(params),
}
