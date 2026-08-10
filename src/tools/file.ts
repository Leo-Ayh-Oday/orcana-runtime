/** File tools — read, write, edit. */

import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import * as ts from "typescript"
import type { ToolDef, ToolExecutionContext, ToolResult } from "./registry"
import { Result } from "./registry"
import { projectRelativePath, resolveToolPath } from "./path-authority"
import { FimEditor } from "../provider/fim"
import { cascadeAwareDecision, formatRippleBlock, getRippleProgram, previewEdit, tightenRippleDecision } from "../ripple/engine"
import { getRuntimeContextBudgetMode } from "../agent/runtime-context"
import { createTransaction } from "./transaction"
import {
  applyAndCommit,
  checkBaseHash,
  checkForbiddenFile,
  computeBaseHash,
  PatchFreshnessConflictError,
  PatchPathConflictError,
  rollbackCommittedTransaction,
  type ManagedPatchTransaction,
} from "../agent/patch-transaction"
import { fingerprintContent, recordRuntimeFileRead, recordRuntimeFileWrite } from "../file-state"
import {
  BoundedFileReader,
  FileReadError,
  readCapBytes,
  type BoundedRangeReadResult,
} from "../runtime/io/bounded-file-reader"
import {
  checkWorkspaceBaseDrift,
  enforceWorkspaceRead,
  validateOpenFileCanonical,
} from "../runtime/io/workspace-io-authority"
import { getWorkspaceIoAuthority } from "../runtime/execution-context"
import type { WorkspaceIoAuthority } from "../runtime/io/workspace-io-authority"

/** IC01: 统一有界读取器（stat/range/chunk/流式哈希/abort/二进制/限额）。
 *  无状态（只读配置），模块级单例。 */
const WORKSPACE_FILE_READER = new BoundedFileReader()

/** IC01: open 侧 fd canonical 校验（check/open race 读取侧闭环）。
 *  无 workspace（旧路径/非 production）时不接线 —— 由 resolveToolPath
 *  的静态检查兜底。 */
function openValidatorFor(
  workspace: WorkspaceIoAuthority | undefined,
  p: string,
): ((fd: number) => Promise<string | null>) | undefined {
  if (!workspace) return undefined
  return async (fd: number) => {
    const violation = await validateOpenFileCanonical(workspace, p, fd)
    return violation?.reason ?? null
  }
}

/** IC01: 有界预读（write/edit/multi_edit/edit_symbol 共享）——
 *  UNBOUNDED_RUNTIME_FILE_READ = 0：写路径预读同样服从 maxFileBytes，
 *  超限文件 fail closed（完整读取一个 1 GiB 仓库文件重新引入原问题）。 */
async function boundedPreRead(
  p: string,
  signal: AbortSignal | undefined,
): Promise<{ ok: true; content: string } | { ok: false; reason: string }> {
  try {
    const info = WORKSPACE_FILE_READER.statSync(p)
    if (info.size > readCapBytes()) {
      return {
        ok: false,
        reason: `FILE_TOO_LARGE_FOR_SAFE_EDIT: ${p} is ${info.size} bytes (cap ${readCapBytes()}) — bounded edits refuse to pre-read beyond the cap; use read_file with range/selector instead`,
      }
    }
    const full = await WORKSPACE_FILE_READER.readFile(p, { signal })
    if (full.truncated) {
      return {
        ok: false,
        reason: `FILE_TOO_LARGE_FOR_SAFE_EDIT: ${p} exceeds the bounded read budget`,
      }
    }
    return { ok: true, content: full.buffer.toString("utf-8") }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

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

/** RC-19 Phase 2 (D7): display path — project-relative when an authority is
 *  known, absolute otherwise. NEVER cwd-relative (PROCESS_CWD_AFFECTS_TOOL=0). */
function safeResultPath(path: string, root?: string): string {
  if (root) return projectRelativePath(root, path)
  return resolve(path).replace(/\\/g, "/")
}

/** RC-19 Phase 2 (D7): the single path-resolution entry — resolveToolPath()
 *  binds relative paths to projectRoot; escapes surface as blocked policy
 *  violations (CROSS_PROJECT_READ / CROSS_PROJECT_WRITE / SYMLINK_PROJECT_ESCAPE).
 *  IC01: 统一 Workspace I/O Authority —— 基线漂移 fail closed（WORKSPACE_PATH_BASE_DRIFT），
 *  权威读取强制（SECRET_READ / OUTSIDE_WORKSPACE_READ / SYMLINK_READ_ESCAPE）。 */
function authoritativePath(
  context: ToolExecutionContext | undefined,
  rawPath: string,
  mode: "read" | "write",
): { ok: true; path: string } | { ok: false; result: ToolResult } {
  // IC01: ToolExecutionContext.projectRoot 必须与权威读取根一致（realpath 归一化）。
  const workspace = getWorkspaceIoAuthority()
  if (workspace) {
    const drift = checkWorkspaceBaseDrift(workspace, context?.projectRoot)
    if (drift) {
      return {
        ok: false,
        result: Result.blocked(drift.reason, {
          gate: "workspace_io",
          workspaceIo: { code: drift.code },
        }),
      }
    }
  }
  const resolution = resolveToolPath(context, rawPath, mode)
  if (!resolution.ok) return { ok: false, result: Result.blocked(resolution.message, { gate: "path_authority" }) }
  // IC01: 权威读取强制（秘密文件 / 工作区外 / symlink 逃逸）——读取根以
  // TrustedExecutionAuthority.workspace.hostRoot 为权威。
  if (mode === "read" && workspace) {
    const violation = enforceWorkspaceRead(workspace, resolution.path, rawPath, context?.projectRoot)
    if (violation) {
      return {
        ok: false,
        result: Result.blocked(violation.reason, {
          gate: "workspace_io",
          workspaceIo: { code: violation.code },
        }),
      }
    }
  }
  return { ok: true, path: resolution.path }
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
  const displayPath = safeResultPath(path, fileToolRoot(context))
  return Result.freshnessBlocked(displayPath, status, reason)
}

function fileToolFailure(error: unknown, root?: string): ToolResult {
  if (error instanceof PatchPathConflictError) {
    const path = safeResultPath(error.path, root)
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
    return Result.freshnessBlocked(safeResultPath(error.path, root), status, reason)
  }
  return Result.fail(error instanceof Error ? error.message : String(error))
}

function fileToolRoot(context: ToolExecutionContext | undefined): string | undefined {
  return context?.projectRoot || undefined
}

/** Transaction-relative path: project-relative when an authority is known,
 *  absolute otherwise — never cwd-relative (RC-19 Phase 2, D7). */
function toolRelativePath(context: ToolExecutionContext | undefined, p: string): string {
  const root = fileToolRoot(context)
  return root ? projectRelativePath(root, p) : resolve(p).replace(/\\/g, "/")
}

function isRuntimeArtifact(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "")
  return (
    normalized === "deepseek-run.out.txt" ||
    normalized === "deepseek-run.err.txt" ||
    normalized.startsWith(".orcana/runs/") ||
    normalized.startsWith(".orcana/transactions/")
  )
}

async function read_file(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
  const path = String(params.path ?? "")
  const offset = Number(params.offset ?? 0)
  const limit = params.limit ? Number(params.limit) : undefined
  const selector = params.selector as { kind?: string; start?: number; end?: number; name?: string; length?: number } | undefined
  const expectedHash = typeof params.expectedHash === "string" ? params.expectedHash : undefined

  try {
    if (isRuntimeArtifact(path)) {
      return Result.blocked(`Runtime artifact is hidden from agent reads: ${path}. Continue with the user task instead of inspecting agent logs.`)
    }
    // RC-19 Phase 2 (D7): relative paths bind to projectRoot, never cwd.
    // IC01: 统一 Workspace I/O Authority（漂移/秘密/工作区外/symlink 强制）。
    const resolution = authoritativePath(context, path, "read")
    if (!resolution.ok) return resolution.result
    const p = resolution.path
    if (!existsSync(p)) return Result.fail(`File not found: ${path}`)

    // IC01: 有界读取 —— stat 校验普通文件；range/窗口路径绝不完整分配。
    let info: { size: number; isRegular: boolean; mtimeMs: number }
    try {
      info = await WORKSPACE_FILE_READER.stat(p)
    } catch {
      return Result.fail(`File not found: ${path}`)
    }
    if (!info.isRegular) return Result.fail(`Not a regular file: ${path}`)

    // ── selector: byte_range —— 直接 range read（绝不分配整个文件） ──
    if (selector?.kind === "byte_range" && typeof selector.start === "number") {
      const length = selector.length ?? 0
      const wsRead = getWorkspaceIoAuthority()
      const range = await WORKSPACE_FILE_READER.readRange(p, selector.start, length, {
        signal: context?.abortSignal,
        validateOpen: openValidatorFor(wsRead, p),
      })
      if (range.binary) return binaryFileResult(path, range)
      const selected = range.buffer.toString("utf-8").split("\n").join("\n")
      const fingerprint = fingerprintContent(range.buffer)
      if (expectedHash && fingerprint.sha256 !== expectedHash) return staleFileResult(path)
      const fileState = recordRuntimeFileRead({
        path: p,
        range: { kind: "selector" as never },
        content: selected,
        fingerprint,
        totalLines: undefined,
      })
      return Result.ok(selected, {
        path,
        selected: true,
        selectorKind: "byte_range",
        bytes: range.byteCount,
        fileState: fileState ? { path: fileState.path, status: fileState.status, source: fileState.source } : undefined,
      })
    }

    // ── selector: symbol —— 有界全量（maxFileBytes 上限）+ AST 定位 ──
    if (selector?.kind === "symbol" && typeof selector.name === "string") {
      const wsRead = getWorkspaceIoAuthority()
      const full = await WORKSPACE_FILE_READER.readFile(p, {
        signal: context?.abortSignal,
        validateOpen: openValidatorFor(wsRead, p),
      })
      if (full.binary) return binaryFileResult(path, full)
      const content = full.buffer.toString("utf-8")
      const fingerprint = fingerprintContent(full.buffer)
      if (expectedHash && fingerprint.sha256 !== expectedHash) return staleFileResult(path)
      const span = findSymbolSpan(content, selector.name)
      if (!span) return Result.fail(`Symbol not found: ${selector.name} in ${path}`)
      const lines = content.split("\n")
      const total = lines.length
      const selectorLines = lines.slice(span.start, span.end)
      const fileState = recordRuntimeFileRead({
        path: p,
        range: { kind: "selector" as never },
        content: selectorLines.join("\n"),
        fingerprint,
        totalLines: total,
        truncated: full.truncated,
      })
      return Result.ok(selectorLines.join("\n"), {
        path,
        selected: true,
        selectorKind: "symbol",
        totalLines: total,
        fileState: fileState ? { path: fileState.path, status: fileState.status, source: fileState.source } : undefined,
      })
    }

    // ── offset/limit 或 selector:lines —— 流式行窗口（绝不先完整分配） ──
    const hasWindowParams = selector?.kind === "lines" || offset > 0 || limit !== undefined
    if (hasWindowParams) {
      const startLine = selector?.kind === "lines"
        ? Math.max(0, Math.floor(selector.start ?? 0))
        : Math.max(0, Math.floor(offset))
      const windowCount = selector?.kind === "lines"
        ? Math.max(0, Math.floor((selector.end ?? startLine + (selector.length ?? 1)) - startLine))
        : limit !== undefined
          ? Math.max(0, Math.floor(limit))
          : Number.POSITIVE_INFINITY

      // count=0：空窗口（与旧 slice().slice(0,0) 语义一致）。
      if (windowCount === 0) {
        const header = `[${path}] lines ${startLine + 1}-${startLine} of ?\n`
        const fileState = recordRuntimeFileRead({
          path: p,
          range: { kind: "range" as const, startLine: startLine + 1, endLine: startLine },
          content: "",
          fingerprint: fingerprintContent(""),
          totalLines: undefined,
          truncated: true,
        })
        return Result.ok(header, {
          path,
          lines: 0,
          fileState: fileState ? { path: fileState.path, status: fileState.status, source: fileState.source } : undefined,
        })
      }

      const workspace = getWorkspaceIoAuthority()
      const window = await WORKSPACE_FILE_READER.readLineWindow(p, startLine, windowCount, {
        signal: context?.abortSignal,
        // IC01: 文件在有界全量预算内 → 窗口找到后继续扫描到 EOF，
        // 得到全文件流式哈希与精确 totalLines（freshness 基线语义不变）。
        scanToEof: info.size <= readCapBytes(),
        // P1-6: open 后 fd canonical 校验（check/open race 读取侧闭环）。
        validateOpen: openValidatorFor(workspace, p),
      })
      if (window.binary) return binaryFileResult(path, { totalBytes: info.size, sha256: window.sha256 })
      // 全文件哈希已知时构造完整基线指纹（sha256 语义与旧全量读一致）；
      // 超限文件只指纹窗口内容。
      const fingerprint = window.wholeFileSha256
        ? { sha256: window.wholeFileSha256, mtimeMs: info.mtimeMs, size: info.size }
        : fingerprintContent(Buffer.from(window.text, "utf-8"))
      if (expectedHash && fingerprint.sha256 !== expectedHash) return staleFileResult(path)
      const header = selector?.kind === "lines"
        ? ""
        : window.totalLines === null
          ? `[${path}] lines ${startLine + 1}-${startLine + window.linesCount}\n`
          : `[${path}] lines ${startLine + 1}-${startLine + window.linesCount} of ${window.totalLines}\n`
      const fileState = recordRuntimeFileRead({
        path: p,
        range: { kind: "range" as const, startLine: startLine + 1, endLine: startLine + window.linesCount },
        content: window.text,
        fingerprint,
        totalLines: window.totalLines ?? undefined,
        truncated: window.truncated || !window.scannedToEof,
      })
      return Result.ok(header + window.text, {
        path,
        lines: window.linesCount,
        ...(window.totalLines === null ? {} : { total: window.totalLines }),
        fileState: fileState ? { path: fileState.path, status: fileState.status, source: fileState.source } : undefined,
      })
    }

    // ── 全量有界读取（无 range 参数）—— maxFileBytes 上限，超出即截断 ──
    const wsRead = getWorkspaceIoAuthority()
    const full = await WORKSPACE_FILE_READER.readFile(p, {
      signal: context?.abortSignal,
      validateOpen: openValidatorFor(wsRead, p),
    })
    if (full.binary) return binaryFileResult(path, full)
    const content = full.buffer.toString("utf-8")
    const fingerprint = fingerprintContent(full.buffer)
    // RT-6: expectedHash freshness — a stale read is a conflict, not a silent dump.
    if (expectedHash && fingerprint.sha256 !== expectedHash) return staleFileResult(path)
    const lines = content.split("\n")
    const total = lines.length

    // Sub-agent mode: large file → structural analysis instead of raw dump.
    if (total > LARGE_FILE_LINES) {
      const analysis = analyzeCodeStructure(content, path)
      const fileState = recordRuntimeFileRead({
        path: p,
        range: { kind: "full" },
        content: analysis,
        fingerprint,
        totalLines: total,
        truncated: true,
      })
      return Result.ok(analysis, {
        path,
        analyzed: true,
        totalLines: total,
        exportedSymbols: (analysis.match(/^  L/gm) ?? []).length,
        fileState: fileState ? { path: fileState.path, status: fileState.status, source: fileState.source } : undefined,
      })
    }

    const header = `[${path}] lines 1-${total} of ${total}\n`
    const fileState = recordRuntimeFileRead({
      path: p,
      range: { kind: "full" },
      content,
      fingerprint,
      totalLines: total,
      truncated: full.truncated,
    })
    return Result.ok(header + content, {
      path,
      lines: total,
      total,
      fileState: fileState ? { path: fileState.path, status: fileState.status, source: fileState.source } : undefined,
    })
  } catch (e) {
    if (e instanceof FileReadError && e.code === "ABORTED") {
      return Result.fail(`Read aborted: ${path}`)
    }
    return Result.fail(e instanceof Error ? e.message : String(e))
  }
}

function staleFileResult(path: string): ToolResult {
  return Result.fail(`STALE_FILE: ${path} content hash does not match expectedHash (file changed since you read it)`)
}

/** IC01: 二进制文件结果 —— 只回注记，不倾倒原始字节。 */
function binaryFileResult(path: string, result: { totalBytes: number; sha256: string }): ToolResult {
  return Result.ok(
    `<binary file ${path}: ${result.totalBytes} bytes, sha256 ${result.sha256.slice(0, 16)}>`,
    { path, binary: true, bytes: result.totalBytes, sha256: result.sha256.slice(0, 16) },
  )
}

async function write_file(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
  const path = String(params.path ?? "")
  const content = String(params.content ?? "")

  try {
    const resolution = authoritativePath(context, path, "write")
    if (!resolution.ok) return resolution.result
    const p = resolution.path
    const snapshot = approvedContent(context, p)
    const existedBefore = snapshot.found ? snapshot.content !== null : existsSync(p)
    // IC01: 写路径预读走有界读取 —— 超限文件 fail closed（UNBOUNDED_RUNTIME_FILE_READ = 0）。
    let oldContent = ""
    if (snapshot.found) {
      oldContent = snapshot.content ?? ""
    } else if (existedBefore) {
      const pre = await boundedPreRead(p, context?.abortSignal)
      if (!pre.ok) return Result.fail(pre.reason)
      oldContent = pre.content
    }
    const freshnessBlock = revalidateApprovedSnapshot(context, p, existedBefore ? oldContent : null)
    if (freshnessBlock) return freshnessBlock
    const relPath = toolRelativePath(context, p)
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
        cwd: fileToolRoot(context),
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
    return fileToolFailure(e, fileToolRoot(context))
  }
}

async function edit_file(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
  const path = String(params.path ?? "")
  const oldStr = String(params.old_string ?? "")
  const newStr = String(params.new_string ?? "")

  try {
    const resolution = authoritativePath(context, path, "write")
    if (!resolution.ok) return resolution.result
    const p = resolution.path
    const snapshot = approvedContent(context, p)
    if (snapshot.found && snapshot.content === null) return Result.fail(`File not found: ${path}`)
    if (!snapshot.found && !existsSync(p)) return Result.fail(`File not found: ${path}`)
    // IC01: 有界预读 —— 超限文件 fail closed。
    const preRead = snapshot.found
      ? { ok: true as const, content: snapshot.content! }
      : await boundedPreRead(p, context?.abortSignal)
    if (!preRead.ok) return Result.fail(preRead.reason)
    const content = preRead.content
    const freshnessBlock = revalidateApprovedSnapshot(context, p, content)
    if (freshnessBlock) return freshnessBlock
    const baseHash = approvedBaseHash(context, p, () => computeBaseHash(content))
    const count = content.split(oldStr).length - 1

    if (count === 0) return Result.fail(`String not found in ${path}`)
    if (count > 1) return Result.fail(`Found ${count} occurrences — provide more context for a unique match`)

    const newContent = content.replace(oldStr, newStr)
    const relPath = toolRelativePath(context, p)

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
        cwd: fileToolRoot(context),
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
    return fileToolFailure(e, fileToolRoot(context))
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

      const resolution = authoritativePath(context, path, "write")
      if (!resolution.ok) return resolution.result
      const p = resolution.path
      if (!originals.has(p)) {
        const snapshot = approvedContent(context, p)
        if (snapshot.found && snapshot.content === null) return Result.fail(`File not found: ${path}`)
        if (!snapshot.found && !existsSync(p)) return Result.fail(`File not found: ${path}`)
        // IC01: 有界预读 —— 超限文件 fail closed。
        const preRead = snapshot.found
          ? { ok: true as const, content: snapshot.content! }
          : await boundedPreRead(p, context?.abortSignal)
        if (!preRead.ok) return Result.fail(preRead.reason)
        const original = preRead.content
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

    const modifiedFiles = new Set([...proposed.keys()].map(p => relativePath(p, fileToolRoot(context))))
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
      const relPath = toolRelativePath(context, p)
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
      { tool: "multi_edit", cwd: fileToolRoot(context), files },
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
    return fileToolFailure(e, fileToolRoot(context))
  }
}

/** Display/ledger path — project-relative when a root is known, absolute
 *  otherwise; never cwd-relative (RC-19 Phase 2, D7). */
function relativePath(path: string, root?: string): string {
  return root ? projectRelativePath(root, path) : resolve(path).replace(/\\/g, "/")
}

// Tool definitions

export const READ_FILE: ToolDef = {
  name: "read_file",
  description: "Read a file's contents. Pass offset and limit to read specific lines; selector for line/symbol/byte ranges; expectedHash for freshness.",
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
      // RT-6: structured selection + freshness.
      selector: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["lines", "symbol", "byte_range"] },
          start: { type: "integer" },
          end: { type: "integer" },
          name: { type: "string", description: "Symbol name for kind=symbol" },
          length: { type: "integer" },
        },
      },
      expectedHash: { type: "string", description: "Expected content hash — mismatch returns STALE_FILE" },
    },
    required: ["path"],
  },
  execute: (params, _onProgress, context) => read_file(params, context),
}

/** RT-6: TypeScript-AST symbol span (function/method/class/interface/type
 *  alias/object member) — line numbers are 0-indexed [start, end). */
function findSymbolSpan(content: string, symbol: string): { start: number; end: number } | null {
  const source = ts.createSourceFile("probe.ts", content, ts.ScriptTarget.Latest, true)
  let span: { start: number; end: number } | null = null
  const visit = (node: ts.Node): void => {
    if (span) return
    const name = (node as { name?: { text?: string } }).name?.text
    if (name === symbol) {
      const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line
      const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1
      span = { start, end }
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return span
}

// ── edit_symbol (RT-6): symbol-anchored editing via TS AST ──

const EDIT_SYMBOL_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string" },
    symbol: { type: "string", description: "Function/method/class/interface/type-alias name" },
    newText: { type: "string", description: "Replacement text for the whole symbol" },
    dryRun: { type: "boolean", description: "Return the current symbol text + span without editing" },
  },
  required: ["path", "symbol"],
} as const

async function edit_symbol(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
  const path = String(params["path"] ?? "")
  const symbol = String(params["symbol"] ?? "")
  const newText = typeof params["newText"] === "string" ? params["newText"] : undefined
  const dryRun = params["dryRun"] === true

  try {
    const resolution = authoritativePath(context, path, "write")
    if (!resolution.ok) return resolution.result
    const p = resolution.path
    const snapshot = approvedContent(context, p)
    if (snapshot.found && snapshot.content === null) return Result.fail(`File not found: ${path}`)
    if (!snapshot.found && !existsSync(p)) return Result.fail(`File not found: ${path}`)
    // IC01: 有界预读 —— 超限文件 fail closed。
    const preRead = snapshot.found
      ? { ok: true as const, content: snapshot.content! }
      : await boundedPreRead(p, context?.abortSignal)
    if (!preRead.ok) return Result.fail(preRead.reason)
    const content = preRead.content
    const freshnessBlock = revalidateApprovedSnapshot(context, p, content)
    if (freshnessBlock) return freshnessBlock
    const span = findSymbolSpan(content, symbol)
    if (!span) return Result.fail(`Symbol not found: ${symbol} in ${path}`)

    const lines = content.split("\n")
    const current = lines.slice(span.start, span.end).join("\n")

    if (dryRun) {
      return Result.ok(current, {
        path,
        symbol,
        symbolKind: "ast",
        authority: "compiler",
        startLine: span.start,
        endLine: span.end,
        dryRun: true,
      })
    }
    if (newText === undefined) {
      return Result.fail(`edit_symbol requires newText (or dryRun=true to preview): ${symbol}`)
    }

    const before = lines.slice(0, span.start).join("\n")
    const after = lines.slice(span.end).join("\n")
    const replacement = before + (before ? "\n" : "") + newText + (after ? "\n" : "") + after
    const baseHash = approvedBaseHash(context, p, () => computeBaseHash(content))
    const relPath = toolRelativePath(context, p)

    const ripple = previewEdit({ targetFile: p, oldContent: content, newContent: replacement, mode: "edit_file" })
    const effectiveDecision = tightenRippleDecision(ripple, getRuntimeContextBudgetMode())
    if (effectiveDecision !== "allow") {
      return Result.blocked(formatRippleBlock(ripple))
    }

    const mpt = await applyAndCommit(
      {
        tool: "edit_symbol",
        cwd: fileToolRoot(context),
        files: [{
          relativePath: relPath,
          oldContent: content,
          newContent: replacement,
          expectedBaseHash: baseHash,
        }],
      },
      async (_mpt: ManagedPatchTransaction) => true,
    )

    getRippleProgram().invalidateFile(p)
    const fileState = recordRuntimeFileWrite({ path: p, content: replacement })
    return Result.ok(`edited symbol ${symbol} (lines ${span.start + 1}-${span.end})`, {
      path,
      symbol,
      symbolKind: "ast",
      authority: "compiler",
      startLine: span.start,
      endLine: span.end,
      dryRun: false,
      transactionId: mpt.patch.fileTransaction.id,
      patchTransactionId: mpt.txId,
      rippleReport: ripple,
      checkpoint: checkpointMetadata(path, content, baseHash),
      fileState: { path: fileState.path, status: fileState.status, source: fileState.source },
    })
  } catch (e) {
    return fileToolFailure(e, fileToolRoot(context))
  }
}

export const EDIT_SYMBOL_TOOL: ToolDef = {
  name: "edit_symbol",
  description: "Edit a TypeScript symbol (function/method/class/interface/type alias/object member) located via the compiler AST. Use dryRun to preview the current text and span.",
  isReadonly: false,
  category: "file",
  requiresConfirmation: true,
  managesFreshnessApproval: true,
  contract: {
    pathPolicy: "workspace_only",
    stateRequirement: "fresh_full_baseline",
    stateUpdates: ["file_state", "checkpoint"],
  },
  inputSchema: EDIT_SYMBOL_SCHEMA as unknown as Record<string, unknown>,
  execute: (params, _onProgress, context) => edit_symbol(params, context),
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
    const resolution = authoritativePath(context, path, "write")
    if (!resolution.ok) return resolution.result
    const p = resolution.path
    const root = fileToolRoot(context)
    const pathCheck = checkForbiddenFile(p, root ?? p)
    if (!pathCheck.allowed) {
      const displayPath = safeResultPath(path, root)
      return Result.blocked(`PathPolicy blocked edit_fim for ${displayPath}: ${pathCheck.reason ?? "forbidden path"}`, {
        gate: "path_policy",
        pathPolicy: { path: displayPath, reason: pathCheck.reason ?? "forbidden path" },
      })
    }

    const snapshot = approvedContent(context, p)
    if (snapshot.found && snapshot.content === null) return Result.fail(`File not found: ${path}`)
    // IC01: 有界预读 —— 超限文件 fail closed。
    const preRead = snapshot.found
      ? { ok: true as const, content: snapshot.content! }
      : await boundedPreRead(p, context?.abortSignal)
    if (!preRead.ok) return Result.fail(preRead.reason)
    const oldContent = preRead.content
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
    const relPath = toolRelativePath(context, p)
    const mpt = await applyAndCommit(
      {
        tool: "edit_fim",
        cwd: fileToolRoot(context),
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
    if (e instanceof PatchFreshnessConflictError || e instanceof PatchPathConflictError) {
      return fileToolFailure(e, fileToolRoot(context))
    }
    return Result.fail(`FIM generated edit but file write failed: ${e}\n\n${generatedPreview}`)
  }
}

async function rollback_transaction(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
  const transactionId = String(params.transactionId ?? params.transaction_id ?? "")
  if (!transactionId) return Result.fail("transactionId is required")
  try {
    // SS-Next-2B: rollback invalidates pre-rollback evidence (write-generation
    // L2 + commit-history binding L3) while keeping the binding usable.
    // RC-19 Phase 2 (D7): look up the transaction under the authority root —
    // never process.cwd() (the store is anchored at the root that wrote it).
    const root = fileToolRoot(context)
    if (!root) return Result.blocked("rollback_transaction requires a projectRoot authority (RC-19 Phase 2)", { gate: "path_authority" })
    const result = rollbackCommittedTransaction(transactionId, root)
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
  execute: (params, _onProgress, context) => rollback_transaction(params, context),
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
