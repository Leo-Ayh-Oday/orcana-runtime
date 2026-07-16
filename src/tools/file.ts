/** File tools — read, write, edit. */

import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import type { ToolDef, ToolExecutionContext, ToolResult } from "./registry"
import { Result } from "./registry"
import { FimEditor } from "../provider/fim"
import { cascadeAwareDecision, formatRippleBlock, getRippleProgram, previewEdit, tightenRippleDecision } from "../ripple/engine"
import { getRuntimeContextBudgetMode } from "../agent/runtime-context"
import { createTransaction, rollbackTransaction } from "./transaction"
import {
  applyAndCommit,
  checkBaseHash,
  checkForbiddenFile,
  computeBaseHash,
  PatchFreshnessConflictError,
  PatchPathConflictError,
  type ManagedPatchTransaction,
} from "../agent/patch-transaction"
import { fingerprintContent, recordRuntimeFileRead, recordRuntimeFileWrite } from "../file-state"

/** Threshold: files larger than this get sub-agent analysis instead of raw dump. */
const LARGE_FILE_LINES = 400

// ── Sub-agent: structural analysis for large files ──

interface CodeStub {
  name: string
  kind: string
  header: string
  line: number
  exported: boolean
}

/** Parse a TypeScript file into a structural table of contents.
 *  Pure, no LLM call — a "sub-agent" that runs inside the tool process. */
function analyzeCodeStructure(content: string, filePath: string): string {
  const lines = content.split("\n")
  const total = lines.length

  // Extract imports (first ~40 lines typically)
  const imports: string[] = []
  for (const line of lines.slice(0, Math.min(40, total))) {
    const t = line.trim()
    if (t.startsWith("import ") || t.startsWith("export {") || t.startsWith("export *")) {
      imports.push(t.slice(0, 120))
    }
  }

  // Extract exported symbols using simple regex (no ts.createSourceFile — fast, works on partial/wrong code)
  const stubs: CodeStub[] = []
  const patterns: Array<{ regex: RegExp; kind: string }> = [
    { regex: /^\s*export\s+(?:async\s+)?function\s+(\w+)/, kind: "function" },
    { regex: /^\s*export\s+(?:abstract\s+)?class\s+(\w+)/, kind: "class" },
    { regex: /^\s*export\s+interface\s+(\w+)/, kind: "interface" },
    { regex: /^\s*export\s+type\s+(\w+)/, kind: "type" },
    { regex: /^\s*export\s+(?:const|let|var)\s+(\w+)/, kind: "const" },
    { regex: /^\s*export\s+enum\s+(\w+)/, kind: "enum" },
    { regex: /^\s*export\s+default\s+(?:function|class)\s+(\w+)/, kind: "default" },
  ]
  for (let i = 0; i < total; i++) {
    const t = lines[i]!.trim()
    for (const { regex, kind } of patterns) {
      const m = regex.exec(t)
      if (m && m[1]) {
        stubs.push({ name: m[1], kind, header: t.slice(0, 100), line: i + 1, exported: true })
        break
      }
    }
  }

  // Build report
  const parts: string[] = [
    `[analyze] ${filePath} — ${total} lines, ${stubs.length} exported symbols`,
    "",
  ]
  if (imports.length > 0) {
    parts.push(`## Imports (${imports.length})`, ...imports.slice(0, 12))
    if (imports.length > 12) parts.push(`  ... +${imports.length - 12} more`)
    parts.push("")
  }
  if (stubs.length > 0) {
    parts.push(`## Exported Symbols (${stubs.length})`)
    for (const s of stubs) {
      parts.push(`  L${String(s.line).padStart(4)}  ${s.kind.padEnd(10)} ${s.name}  ${s.header.slice(0, 60)}`)
    }
    parts.push("")
  }
  // Head + tail samples
  parts.push(`## First 30 lines`)
  parts.push(...lines.slice(0, 30))
  parts.push("")
  parts.push(`## Last 20 lines`)
  parts.push(...lines.slice(Math.max(0, total - 20)))

  return parts.join("\n")
}

// ── No-op per-file tsc — batch runs in loop.ts ──

function runTsCheck(_path: string): string {
  return ""
}

function checkpointMetadata(
  path: string,
  oldContent: string | null,
  previousHash = oldContent === null ? null : computeBaseHash(oldContent),
): Record<string, unknown> {
  return {
    path,
    existedBefore: oldContent !== null,
    previousBytes: oldContent === null ? 0 : Buffer.byteLength(oldContent, "utf-8"),
    previousHash,
  }
}

function safeResultPath(path: string): string {
  const canonicalPath = resolve(path)
  const workspaceRelative = relative(process.cwd(), canonicalPath)
  if (workspaceRelative && !workspaceRelative.startsWith("..") && !isAbsolute(workspaceRelative)) {
    return workspaceRelative.replace(/\\/g, "/")
  }
  return "path"
}

function approvedBaseHash(
  context: ToolExecutionContext | undefined,
  path: string,
  fallback: () => string | null,
): string | null {
  const canonicalPath = resolve(path)
  const approved = context?.freshness?.expectedBaseHashes
  return approved && Object.prototype.hasOwnProperty.call(approved, canonicalPath)
    ? approved[canonicalPath] ?? null
    : fallback()
}

function approvedContent(
  context: ToolExecutionContext | undefined,
  path: string,
): { found: boolean; content: string | null } {
  const canonicalPath = resolve(path)
  const approved = context?.freshness?.approvedContents
  return approved && Object.prototype.hasOwnProperty.call(approved, canonicalPath)
    ? { found: true, content: approved[canonicalPath] ?? null }
    : { found: false, content: null }
}

function revalidateApprovedSnapshot(
  context: ToolExecutionContext | undefined,
  path: string,
  content: string | null,
): ToolResult | undefined {
  const canonicalPath = resolve(path)
  const approved = context?.freshness?.expectedBaseHashes
  if (!approved || !Object.prototype.hasOwnProperty.call(approved, canonicalPath)) return undefined

  const expected = approved[canonicalPath] ?? null
  const approvedSnapshot = context?.freshness?.approvedContents
  if (
    expected !== null &&
    approvedSnapshot &&
    Object.prototype.hasOwnProperty.call(approvedSnapshot, canonicalPath) &&
    approvedSnapshot[canonicalPath] === content
  ) {
    return undefined
  }
  const actual = content === null ? null : computeBaseHash(content)
  const result = expected === null
    ? checkBaseHash(canonicalPath, null)
    : {
        match: actual === expected,
        actual,
      }
  if (result.match) return undefined

  const status = expected === null ? "changed" : result.actual === null ? "deleted" : "stale"
  const reason = expected === null
    ? "new-file target appeared after freshness approval"
    : result.actual === null
      ? "file was deleted after freshness approval"
      : "disk content changed after freshness approval"
  const displayPath = safeResultPath(path)
  return Result.freshnessBlocked(displayPath, status, reason)
}

function fileToolFailure(error: unknown): ToolResult {
  if (error instanceof PatchPathConflictError) {
    const path = safeResultPath(error.path)
    return Result.blocked(`PathPolicy blocked write for ${path}: ${error.reason}`, {
      gate: "path_policy",
      pathPolicy: { path, reason: error.reason },
    })
  }
  if (error instanceof PatchFreshnessConflictError) {
    const status = error.expected === null
      ? "changed"
      : error.actualState === "absent"
        ? "deleted"
        : error.actualState === "file"
          ? "stale"
          : "changed"
    const reason = error.expected === null
      ? "new-file target appeared before commit"
      : error.actualState === "absent"
        ? "file was deleted before commit"
        : error.actualState === "file"
          ? "disk content changed before commit"
          : "target became unreadable or stopped being a regular file before commit"
    return Result.freshnessBlocked(safeResultPath(error.path), status, reason)
  }
  return Result.fail(error instanceof Error ? error.message : String(error))
}

function isRuntimeArtifact(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "")
  return (
    normalized === "deepseek-run.out.txt" ||
    normalized === "deepseek-run.err.txt" ||
    normalized.startsWith(".deepseek-code/runs/") ||
    normalized.startsWith(".deepseek-code/transactions/")
  )
}

async function read_file(params: Record<string, unknown>): Promise<ToolResult> {
  const path = String(params.path ?? "")
  const offset = Number(params.offset ?? 0)
  const limit = params.limit ? Number(params.limit) : undefined

  try {
    if (isRuntimeArtifact(path)) {
      return Result.blocked(`Runtime artifact is hidden from agent reads: ${path}. Continue with the user task instead of inspecting agent logs.`)
    }
    const p = resolve(path)
    if (!existsSync(p)) return Result.fail(`File not found: ${path}`)
    const buffer = await readFile(p)
    const content = buffer.toString("utf-8")
    const fingerprint = fingerprintContent(buffer)
    const lines = content.split("\n")
    const total = lines.length

    // Sub-agent mode: large file, no explicit range → return structural analysis
    // instead of raw dump. The agent can then request specific sections with offset/limit.
    if (total > LARGE_FILE_LINES && offset <= 0 && !limit) {
      const analysis = analyzeCodeStructure(content, path)
      const fileState = recordRuntimeFileRead({ path: p, range: { kind: "full" }, content: analysis, fingerprint, totalLines: total, truncated: true })
      return Result.ok(analysis, {
        path,
        analyzed: true,
        totalLines: total,
        exportedSymbols: (analysis.match(/^  L/gm) ?? []).length,
        fileState: fileState ? { path: fileState.path, status: fileState.status, source: fileState.source } : undefined,
      })
    }

    let selected = lines
    if (offset > 0) selected = selected.slice(offset)
    if (limit) selected = selected.slice(0, limit)

    const header = `[${path}] lines ${offset + 1}-${offset + selected.length} of ${total}\n`
    const selectedContent = selected.join("\n")
    const range = offset > 0 || typeof limit === "number"
      ? { kind: "range" as const, startLine: offset + 1, endLine: offset + selected.length }
      : { kind: "full" as const }
    const fileState = recordRuntimeFileRead({ path: p, range, content: selectedContent, fingerprint, totalLines: total })
    return Result.ok(header + selectedContent, {
      path,
      lines: selected.length,
      total,
      fileState: fileState ? { path: fileState.path, status: fileState.status, source: fileState.source } : undefined,
    })
  } catch (e) {
    return Result.fail(e instanceof Error ? e.message : String(e))
  }
}

async function write_file(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
  const path = String(params.path ?? "")
  const content = String(params.content ?? "")

  try {
    const p = resolve(path)
    const snapshot = approvedContent(context, p)
    const existedBefore = snapshot.found ? snapshot.content !== null : existsSync(p)
    const oldContent = snapshot.found
      ? snapshot.content ?? ""
      : existedBefore
        ? await readFile(p, "utf-8")
        : ""
    const freshnessBlock = revalidateApprovedSnapshot(context, p, existedBefore ? oldContent : null)
    if (freshnessBlock) return freshnessBlock
    const relPath = relative(process.cwd(), p).replace(/\\/g, "/")
    const baseHash = approvedBaseHash(
      context,
      p,
      () => existedBefore ? computeBaseHash(oldContent) : null,
    )

    // Ripple pre-check
    const ripple = previewEdit({ targetFile: p, oldContent, newContent: content, mode: "write_file" })
    const effectiveDecision = tightenRippleDecision(ripple, getRuntimeContextBudgetMode())
    if (effectiveDecision !== "allow") {
      return Result.blocked(`${formatRippleBlock(ripple)}`)
    }

    // PR-4.2: Use state machine for atomic write (temp → verify → commit)
    const mpt = await applyAndCommit(
      {
        tool: "write_file",
        files: [{
          relativePath: relPath,
          oldContent: existedBefore ? oldContent : null,
          newContent: content,
          expectedBaseHash: baseHash,
        }],
      },
      async (_mpt: ManagedPatchTransaction) => {
        // Inline verification: run tsc if available (batch tsc happens in loop.ts post-round)
        // Return true for now — the real verification gate is in CompletionOrchestrator
        return true
      },
    )

    const lines = content.split("\n").length
    const diag = runTsCheck(path)
    getRippleProgram().invalidateFile(path)
    const fileState = recordRuntimeFileWrite({ path: p, content })
    return Result.ok(`Written ${path} - ${lines} lines, ${content.length} chars${diag}`, {
      path,
      lines,
      transactionId: mpt.patch.fileTransaction.id,
      patchTransactionId: mpt.txId,
      rippleReport: ripple,
      checkpoint: checkpointMetadata(path, existedBefore ? oldContent : null, baseHash),
      fileState: { path: fileState.path, status: fileState.status, source: fileState.source },
    })
  } catch (e) {
    return fileToolFailure(e)
  }
}

async function edit_file(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
  const path = String(params.path ?? "")
  const oldStr = String(params.old_string ?? "")
  const newStr = String(params.new_string ?? "")

  try {
    const p = resolve(path)
    const snapshot = approvedContent(context, p)
    if (snapshot.found && snapshot.content === null) return Result.fail(`File not found: ${path}`)
    if (!snapshot.found && !existsSync(p)) return Result.fail(`File not found: ${path}`)
    const content = snapshot.found ? snapshot.content! : await readFile(p, "utf-8")
    const freshnessBlock = revalidateApprovedSnapshot(context, p, content)
    if (freshnessBlock) return freshnessBlock
    const baseHash = approvedBaseHash(context, p, () => computeBaseHash(content))
    const count = content.split(oldStr).length - 1

    if (count === 0) return Result.fail(`String not found in ${path}`)
    if (count > 1) return Result.fail(`Found ${count} occurrences — provide more context for a unique match`)

    const newContent = content.replace(oldStr, newStr)
    const relPath = relative(process.cwd(), p).replace(/\\/g, "/")

    // Ripple pre-check
    const ripple = previewEdit({ targetFile: p, oldContent: content, newContent, mode: "edit_file" })
    const effectiveDecision = tightenRippleDecision(ripple, getRuntimeContextBudgetMode())
    if (effectiveDecision !== "allow") {
      return Result.blocked(formatRippleBlock(ripple))
    }

    // PR-4.2: Use state machine for atomic write (temp → verify → commit)
    const mpt = await applyAndCommit(
      {
        tool: "edit_file",
        files: [{
          relativePath: relPath,
          oldContent: content,
          newContent,
          expectedBaseHash: baseHash,
        }],
      },
      async (_mpt: ManagedPatchTransaction) => true,
    )

    const diag = runTsCheck(path)
    getRippleProgram().invalidateFile(path)
    const fileState = recordRuntimeFileWrite({ path: p, content: newContent })
    return Result.ok(`Replaced 1 occurrence in ${path}${diag}`, {
      path,
      occurrences: 1,
      transactionId: mpt.patch.fileTransaction.id,
      patchTransactionId: mpt.txId,
      rippleReport: ripple,
      checkpoint: checkpointMetadata(path, content, baseHash),
      fileState: { path: fileState.path, status: fileState.status, source: fileState.source },
    })
  } catch (e) {
    return fileToolFailure(e)
  }
}

async function multi_edit(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
  const edits = Array.isArray(params.edits) ? params.edits as Array<Record<string, unknown>> : []
  if (!edits.length) return Result.fail("edits array is required")

  const originals = new Map<string, string>()
  const proposed = new Map<string, string>()
  const baseHashes = new Map<string, string>()
  const displayPaths: string[] = []

  try {
    for (const edit of edits) {
      const path = String(edit.path ?? "")
      const oldStr = String(edit.old_string ?? "")
      const newStr = String(edit.new_string ?? "")
      if (!path || !oldStr) return Result.fail("Each edit requires path and old_string")

      const p = resolve(path)
      if (!originals.has(p)) {
        const snapshot = approvedContent(context, p)
        if (snapshot.found && snapshot.content === null) return Result.fail(`File not found: ${path}`)
        if (!snapshot.found && !existsSync(p)) return Result.fail(`File not found: ${path}`)
        const original = snapshot.found ? snapshot.content! : await readFile(p, "utf-8")
        originals.set(p, original)
        const freshnessBlock = revalidateApprovedSnapshot(context, p, original)
        if (freshnessBlock) return freshnessBlock
        baseHashes.set(p, approvedBaseHash(context, p, () => computeBaseHash(original))!)
      }
      const current = proposed.get(p) ?? originals.get(p) ?? ""
      const count = current.split(oldStr).length - 1
      if (count === 0) return Result.fail(`String not found in ${path}`)
      if (count > 1) return Result.fail(`Found ${count} occurrences in ${path}; provide more context`)
      proposed.set(p, current.replace(oldStr, newStr))
      displayPaths.push(path)
    }

    const modifiedFiles = new Set([...proposed.keys()].map(p => relativePath(p)))
    const reports = [...proposed.entries()].map(([p, newContent]) => {
      const oldContent = originals.get(p) ?? ""
      return previewEdit({ targetFile: p, oldContent, newContent, mode: "edit_file" })
    })

    for (const report of reports) {
      const effectiveDecision = cascadeAwareDecision(report, modifiedFiles, getRuntimeContextBudgetMode())
      if (effectiveDecision !== "allow") {
        return Result.blocked(formatRippleBlock(report))
      }
    }

    // PR-4.2: Build files array for state machine
    const files = [...proposed.entries()].map(([p, newContent]) => {
      const oldContent = originals.get(p) ?? ""
      const relPath = relative(process.cwd(), p).replace(/\\/g, "/")
      return {
        relativePath: relPath,
        oldContent,
        newContent,
        expectedBaseHash: baseHashes.get(p) ?? computeBaseHash(oldContent),
      }
    })

    // PR-4.2: Atomic multi-file write via state machine (temp → verify → commit)
    // applyAndCommit handles rollback on partial failure internally
    const mpt = await applyAndCommit(
      { tool: "multi_edit", files },
      async (_mpt: ManagedPatchTransaction) => true,
    )

    const diag = displayPaths.map(path => runTsCheck(path)).filter(Boolean).join("\n")
    for (const p of proposed.keys()) getRippleProgram().invalidateFile(p)
    const fileStates = [...proposed.entries()].map(([p, content]) => {
      const record = recordRuntimeFileWrite({ path: p, content })
      return { path: record.path, status: record.status, source: record.source }
    })
    return Result.ok(`Applied ${edits.length} atomic edit(s) across ${proposed.size} file(s)${diag}`, {
      paths: displayPaths,
      transactionId: mpt.patch.fileTransaction.id,
      patchTransactionId: mpt.txId,
      rippleReports: reports,
      checkpoints: displayPaths.map(path => {
        const canonicalPath = resolve(path)
        return checkpointMetadata(
          path,
          originals.get(canonicalPath) ?? "",
          baseHashes.get(canonicalPath) ?? null,
        )
      }),
      fileStates,
    })
  } catch (e) {
    return fileToolFailure(e)
  }
}

function relativePath(path: string): string {
  return relative(process.cwd(), resolve(path)).replace(/\\/g, "/")
}

// Tool definitions

export const READ_FILE: ToolDef = {
  name: "read_file",
  description: "Read a file's contents. Pass offset and limit to read specific lines.",
  isReadonly: true,
  category: "safe" as const,
  contract: {
    stateUpdates: ["file_state"],
  },
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      offset: { type: "integer", description: "Line offset (0-indexed)" },
      limit: { type: "integer", description: "Max lines" },
    },
    required: ["path"],
  },
  execute: read_file,
}

export const WRITE_FILE: ToolDef = {
  name: "write_file",
  description: "Create or overwrite a file. Use this to create new files. For editing existing files, use edit_file instead.",
  isReadonly: false,
  category: "file" as const,
  requiresConfirmation: true,
  userFacingName: "Save File",
  managesFreshnessApproval: true,
  contract: {
    pathPolicy: "workspace_only",
    stateRequirement: "fresh_full_baseline_if_existing",
    stateUpdates: ["file_state", "checkpoint"],
  },
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      content: { type: "string", description: "Full file content" },
    },
    required: ["path", "content"],
  },
  execute: (params, _onProgress, context) => write_file(params, context),
}

export const EDIT_FILE: ToolDef = {
  name: "edit_file",
  description: "Replace a string in a file. Provide enough surrounding context to make the match unique.",
  isReadonly: false,
  category: "file" as const,
  requiresConfirmation: true,
  userFacingName: "Edit File",
  managesFreshnessApproval: true,
  contract: {
    pathPolicy: "workspace_only",
    stateRequirement: "fresh_full_baseline",
    stateUpdates: ["file_state", "checkpoint"],
  },
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      old_string: { type: "string", description: "Text to replace" },
      new_string: { type: "string", description: "Replacement text" },
    },
    required: ["path", "old_string", "new_string"],
  },
  execute: (params, _onProgress, context) => edit_file(params, context),
}

export const MULTI_EDIT: ToolDef = {
  name: "multi_edit",
  description: "Apply multiple string replacements as one atomic cascade patch. Use this when Ripple reports affected callers that must be updated together.",
  isReadonly: false,
  category: "file" as const,
  requiresConfirmation: true,
  userFacingName: "Atomic Multi Edit",
  managesFreshnessApproval: true,
  contract: {
    pathPolicy: "workspace_only",
    stateRequirement: "fresh_full_baseline",
    stateUpdates: ["file_state", "checkpoint"],
  },
  inputSchema: {
    type: "object",
    properties: {
      edits: {
        type: "array",
        description: "Edits to apply atomically",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            old_string: { type: "string", description: "Unique text to replace" },
            new_string: { type: "string", description: "Replacement text" },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
    },
    required: ["edits"],
  },
  execute: (params, _onProgress, context) => multi_edit(params, context),
}

async function edit_fim(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
  const path = String(params.path ?? "")
  const instruction = String(params.instruction ?? "")
  const startLine = Number(params.start_line ?? 0)
  const endLine = Number(params.end_line ?? 0)
  const functionName = String(params.function_name ?? "")

  if (!instruction) return Result.fail("instruction is required")
  if (!startLine && !endLine && !functionName) return Result.fail("Specify start_line+end_line or function_name")

  let generatedPreview = ""
  try {
    const p = resolve(path)
    const pathCheck = checkForbiddenFile(p, process.cwd())
    if (!pathCheck.allowed) {
      const displayPath = safeResultPath(path)
      return Result.blocked(`PathPolicy blocked edit_fim for ${displayPath}: ${pathCheck.reason ?? "forbidden path"}`, {
        gate: "path_policy",
        pathPolicy: { path: displayPath, reason: pathCheck.reason ?? "forbidden path" },
      })
    }

    const snapshot = approvedContent(context, p)
    const oldContent = snapshot.found ? snapshot.content : await readFile(p, "utf-8")
    if (oldContent === null) return Result.fail(`File not found: ${path}`)
    const freshnessBlock = revalidateApprovedSnapshot(context, p, oldContent)
    if (freshnessBlock) return freshnessBlock
    const baseHash = approvedBaseHash(context, p, () => computeBaseHash(oldContent))

    const editor = new FimEditor()
    const result = functionName
      ? await editor.editFunctionContent(path, oldContent, instruction, functionName)
      : await editor.editFileContentRegion(path, oldContent, instruction, startLine, endLine)
    if (!result.success) return Result.fail(`FIM edit failed: ${result.error}`)
    generatedPreview = result.newText.slice(0, 500)

    const ripple = previewEdit({ targetFile: p, oldContent, newContent: result.fullNewFile, mode: "edit_fim" })
    const effectiveDecision = tightenRippleDecision(ripple, getRuntimeContextBudgetMode())
    if (effectiveDecision !== "allow") {
      return Result.blocked(`${formatRippleBlock(ripple)}\n\nFIM preview:\n${result.newText.slice(0, 500)}`)
    }
    const relPath = relative(process.cwd(), p).replace(/\\/g, "/")
    const mpt = await applyAndCommit(
      {
        tool: "edit_fim",
        files: [{
          relativePath: relPath,
          oldContent,
          newContent: result.fullNewFile,
          expectedBaseHash: baseHash,
        }],
      },
      async (_mpt: ManagedPatchTransaction) => true,
    )
    const diag = runTsCheck(path)
    getRippleProgram().invalidateFile(path)
    const fileState = recordRuntimeFileWrite({ path: p, content: result.fullNewFile })
    return Result.ok(`FIM edit applied to ${path}\n${result.newText.slice(0, 500)}${diag}`, {
      path,
      mode: "fim",
      transactionId: mpt.patch.fileTransaction.id,
      patchTransactionId: mpt.txId,
      rippleReport: ripple,
      checkpoint: checkpointMetadata(path, oldContent, baseHash),
      fileState: { path: fileState.path, status: fileState.status, source: fileState.source },
    })
  } catch (e) {
    if (e instanceof PatchFreshnessConflictError || e instanceof PatchPathConflictError) return fileToolFailure(e)
    return Result.fail(`FIM generated edit but file write failed: ${e}\n\n${generatedPreview}`)
  }
}

async function rollback_transaction(params: Record<string, unknown>): Promise<ToolResult> {
  const transactionId = String(params.transactionId ?? params.transaction_id ?? "")
  if (!transactionId) return Result.fail("transactionId is required")
  try {
    const result = rollbackTransaction(transactionId)
    const changed = [...result.restored, ...result.deleted]
    return Result.ok(`Rolled back ${transactionId}: restored ${result.restored.length}, deleted ${result.deleted.length}`, {
      transactionId,
      paths: changed,
      restored: result.restored,
      deleted: result.deleted,
    })
  } catch (e) {
    return Result.fail(e instanceof Error ? e.message : String(e))
  }
}

export const ROLLBACK_TRANSACTION: ToolDef = {
  name: "rollback_transaction",
  description: "Rollback a previous file write transaction by transactionId. Use only when verification fails and reverting is safer than repair.",
  isReadonly: false,
  category: "file" as const,
  requiresConfirmation: true,
  userFacingName: "Rollback Transaction",
  inputSchema: {
    type: "object",
    properties: {
      transactionId: { type: "string", description: "Transaction id returned by write_file, edit_file, edit_fim, or multi_edit" },
    },
    required: ["transactionId"],
  },
  execute: rollback_transaction,
}

export const EDIT_FIM: ToolDef = {
  name: "edit_fim",
  description: "Edit a specific line range or function in a file using DeepSeek FIM. Provide start_line+end_line OR function_name. Auto-detects function boundaries. Faster and cheaper than rewriting the whole file.",
  isReadonly: false,
  category: "file" as const,
  requiresConfirmation: true,
  userFacingName: "FIM Edit",
  managesFreshnessApproval: true,
  contract: {
    pathPolicy: "workspace_only",
    stateRequirement: "fresh_full_baseline",
    stateUpdates: ["file_state", "checkpoint"],
  },
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      instruction: { type: "string", description: "What to change" },
      start_line: { type: "integer", description: "Start line (1-indexed)" },
      end_line: { type: "integer", description: "End line (1-indexed)" },
      function_name: { type: "string", description: "Function name to edit (alternative to line range)" },
    },
    required: ["path", "instruction"],
  },
  execute: (params, _onProgress, context) => edit_fim(params, context),
}

export const FILE_TOOLS: ToolDef[] = [READ_FILE, WRITE_FILE, EDIT_FILE, MULTI_EDIT, EDIT_FIM, ROLLBACK_TRANSACTION]
