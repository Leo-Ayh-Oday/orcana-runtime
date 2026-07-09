/** File tools — read, write, edit. */

import { readFile, writeFile } from "node:fs/promises"
import { existsSync, mkdirSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { createHash } from "node:crypto"
import type { ToolDef, ToolResult } from "./registry"
import { Result } from "./registry"
import { FimEditor } from "../provider/fim"
import { cascadeAwareDecision, formatRippleBlock, getRippleProgram, previewEdit, tightenRippleDecision } from "../ripple/engine"
import { getRuntimeContextBudgetMode } from "../agent/runtime-context"
import { createTransaction, rollbackTransaction } from "./transaction"
import { applyAndCommit, type ManagedPatchTransaction } from "../agent/patch-transaction"
import { recordRuntimeFileRead, recordRuntimeFileWrite } from "../file-state"

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

function checkpointMetadata(path: string, oldContent: string | null): Record<string, unknown> {
  return {
    path,
    existedBefore: oldContent !== null,
    previousBytes: oldContent === null ? 0 : Buffer.byteLength(oldContent, "utf-8"),
    previousHash: oldContent === null ? null : createHash("sha256").update(oldContent).digest("hex").slice(0, 16),
  }
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
    const content = await readFile(p, "utf-8")
    const lines = content.split("\n")
    const total = lines.length

    // Sub-agent mode: large file, no explicit range → return structural analysis
    // instead of raw dump. The agent can then request specific sections with offset/limit.
    if (total > LARGE_FILE_LINES && offset <= 0 && !limit) {
      const analysis = analyzeCodeStructure(content, path)
      const fileState = recordRuntimeFileRead({ path: p, range: { kind: "full" }, content: analysis, totalLines: total, truncated: true })
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
    const fileState = recordRuntimeFileRead({ path: p, range, content: selectedContent, totalLines: total })
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

async function write_file(params: Record<string, unknown>): Promise<ToolResult> {
  const path = String(params.path ?? "")
  const content = String(params.content ?? "")

  try {
    const p = resolve(path)
    const existedBefore = existsSync(p)
    const oldContent = existedBefore ? await readFile(p, "utf-8") : ""
    const relPath = relative(process.cwd(), p).replace(/\\/g, "/")

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
          expectedBaseHash: existedBefore ? checkpointMetadata(path, oldContent).previousHash as string : null,
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
      rippleReport: ripple,
      checkpoint: checkpointMetadata(path, existedBefore ? oldContent : null),
      fileState: { path: fileState.path, status: fileState.status, source: fileState.source },
    })
  } catch (e) {
    return Result.fail(e instanceof Error ? e.message : String(e))
  }
}

async function edit_file(params: Record<string, unknown>): Promise<ToolResult> {
  const path = String(params.path ?? "")
  const oldStr = String(params.old_string ?? "")
  const newStr = String(params.new_string ?? "")

  try {
    const p = resolve(path)
    if (!existsSync(p)) return Result.fail(`File not found: ${path}`)
    const content = await readFile(p, "utf-8")
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
          expectedBaseHash: checkpointMetadata(path, content).previousHash as string,
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
      rippleReport: ripple,
      checkpoint: checkpointMetadata(path, content),
      fileState: { path: fileState.path, status: fileState.status, source: fileState.source },
    })
  } catch (e) {
    return Result.fail(e instanceof Error ? e.message : String(e))
  }
}

async function multi_edit(params: Record<string, unknown>): Promise<ToolResult> {
  const edits = Array.isArray(params.edits) ? params.edits as Array<Record<string, unknown>> : []
  if (!edits.length) return Result.fail("edits array is required")

  const originals = new Map<string, string>()
  const proposed = new Map<string, string>()
  const displayPaths: string[] = []

  try {
    for (const edit of edits) {
      const path = String(edit.path ?? "")
      const oldStr = String(edit.old_string ?? "")
      const newStr = String(edit.new_string ?? "")
      if (!path || !oldStr) return Result.fail("Each edit requires path and old_string")

      const p = resolve(path)
      if (!existsSync(p)) return Result.fail(`File not found: ${path}`)
      if (!originals.has(p)) originals.set(p, await readFile(p, "utf-8"))
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
        expectedBaseHash: checkpointMetadata(relPath, oldContent).previousHash as string,
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
      rippleReports: reports,
      checkpoints: displayPaths.map(path => checkpointMetadata(path, originals.get(resolve(path)) ?? "")),
      fileStates,
    })
  } catch (e) {
    return Result.fail(e instanceof Error ? e.message : String(e))
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
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      content: { type: "string", description: "Full file content" },
    },
    required: ["path", "content"],
  },
  execute: write_file,
}

export const EDIT_FILE: ToolDef = {
  name: "edit_file",
  description: "Replace a string in a file. Provide enough surrounding context to make the match unique.",
  isReadonly: false,
  category: "file" as const,
  requiresConfirmation: true,
  userFacingName: "Edit File",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      old_string: { type: "string", description: "Text to replace" },
      new_string: { type: "string", description: "Replacement text" },
    },
    required: ["path", "old_string", "new_string"],
  },
  execute: edit_file,
}

export const MULTI_EDIT: ToolDef = {
  name: "multi_edit",
  description: "Apply multiple string replacements as one atomic cascade patch. Use this when Ripple reports affected callers that must be updated together.",
  isReadonly: false,
  category: "file" as const,
  requiresConfirmation: true,
  userFacingName: "Atomic Multi Edit",
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
  execute: multi_edit,
}

async function edit_fim(params: Record<string, unknown>): Promise<ToolResult> {
  const path = String(params.path ?? "")
  const instruction = String(params.instruction ?? "")
  const startLine = Number(params.start_line ?? 0)
  const endLine = Number(params.end_line ?? 0)
  const functionName = String(params.function_name ?? "")

  if (!instruction) return Result.fail("instruction is required")
  if (!startLine && !endLine && !functionName) return Result.fail("Specify start_line+end_line or function_name")

  const editor = new FimEditor()
  let result

  if (functionName) {
    result = await editor.editFunction(path, instruction, functionName)
  } else {
    result = await editor.editFileRegion(path, instruction, startLine, endLine)
  }

  if (!result.success) return Result.fail(`FIM edit failed: ${result.error}`)

  try {
    const p = resolve(path)
    const oldContent = existsSync(p) ? await readFile(p, "utf-8") : ""
    const ripple = previewEdit({ targetFile: p, oldContent, newContent: result.fullNewFile, mode: "edit_fim" })
    const effectiveDecision = tightenRippleDecision(ripple, getRuntimeContextBudgetMode())
    if (effectiveDecision !== "allow") {
      return Result.blocked(`${formatRippleBlock(ripple)}\n\nFIM preview:\n${result.newText.slice(0, 500)}`)
    }
    const transaction = createTransaction({ tool: "edit_fim", paths: [p] })
    mkdirSync(dirname(p), { recursive: true })
    await writeFile(p, result.fullNewFile, "utf-8")
    const diag = runTsCheck(path)
    getRippleProgram().invalidateFile(path)
    const fileState = recordRuntimeFileWrite({ path: p, content: result.fullNewFile })
    return Result.ok(`FIM edit applied to ${path}\n${result.newText.slice(0, 500)}${diag}`, {
      path,
      mode: "fim",
      transactionId: transaction.id,
      rippleReport: ripple,
      fileState: { path: fileState.path, status: fileState.status, source: fileState.source },
    })
  } catch (e) {
    return Result.fail(`FIM generated edit but file write failed: ${e}\n\n${result.newText.slice(0, 500)}`)
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
  execute: edit_fim,
}

export const FILE_TOOLS: ToolDef[] = [READ_FILE, WRITE_FILE, EDIT_FILE, MULTI_EDIT, EDIT_FIM, ROLLBACK_TRANSACTION]
