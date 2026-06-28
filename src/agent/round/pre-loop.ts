/** Pre-loop utilities: error tracking, tool execution, hooks, typecheck helpers,
 *  runtime self-edit gate, file requirement helpers, context building.
 *  Extracted from loop.ts — pure functions and simple classes with no loop state coupling. */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { StreamEvent, ProviderMessage } from "../../provider/types"
import type { ToolDescriptor, ToolResult } from "../../tools/registry"
import type { HookSystem } from "../../hooks"
import type { VerificationResult } from "../../verification/result"
import { normalizeProjectPath } from "../../ripple/obligations"

// ── Self-learning error tracker ──

interface ErrorRecord { toolName: string; errorContent: string; count: number }

export class ErrorTracker {
  private errors = new Map<string, ErrorRecord>()
  private triggered = new Set<string>()

  /** Total number of distinct errors tracked (for mode transition gating). */
  get errorCount(): number { return this.errors.size }

  record(name: string, content: string): string | null {
    if (!/[ef]ail|[ef]rr|blocked|not found|denied/i.test(content)) return null
    const key = name + ":" + content.slice(0, 80).replace(/[^a-zA-Z0-9一-鿿]/g, "")
    const rec = this.errors.get(key)
    if (rec) {
      rec.count++
      if (rec.count === 2 && !this.triggered.has(key)) {
        this.triggered.add(key)
        return `\n[系统提示] 工具 "${name}" 重复失败。请用 web_search 搜索此错误并学习正确用法:\n  "${content.slice(0, 200)}"\n不要用同样的参数重试。搜索完把解决方案总结存入知识库。\n`
      }
      if (rec.count >= 4 && !this.triggered.has(key + "_skip")) {
        this.triggered.add(key + "_skip")
        return `\n[系统提示] "${name}" 已失败 ${rec.count} 次。放弃当前方案，向用户承认遇到了困难并解释已尝试的方法。\n`
      }
    } else {
      this.errors.set(key, { toolName: name, errorContent: content.slice(0, 200), count: 1 })
    }
    return null
  }
}

// ── Tool timeout ──

const TOOL_TIMEOUT_SLOW = 180_000
const TOOL_TIMEOUT_DEFAULT = 60_000
const SLOW_TOOLS = new Set(["shell", "multi_edit", "edit_file", "edit_fim"])

export async function withToolTimeout<T>(name: string, work: Promise<T>, timeoutMs?: number): Promise<T> {
  const effectiveTimeout = timeoutMs ?? (SLOW_TOOLS.has(name) ? TOOL_TIMEOUT_SLOW : TOOL_TIMEOUT_DEFAULT)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Tool '${name}' timed out after ${effectiveTimeout / 1000}s`)), effectiveTimeout)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ── Provider stream helpers ──

export async function nextProviderEvent(
  iterator: AsyncIterator<StreamEvent>,
  timeoutMs: number,
): Promise<IteratorResult<StreamEvent>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`provider stream idle timeout after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function providerIdleTimeoutMs(): number {
  const raw = Number(process.env.DEEPSEEK_PROVIDER_IDLE_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 180_000
}

// ── Hook helpers ──

function blockedByHookResult(tool: string, reason?: string): ToolResult {
  const message = reason?.trim() || `Tool '${tool}' blocked by runtime hook`
  return { success: false, content: `[blocked] ${message}`, error: message, metadata: { blocked: true, hookBlocked: true } }
}

function normalizeHookResult(result: { success: boolean; content: string }, previous?: ToolResult): ToolResult {
  if (result.success) return { success: true, content: result.content, metadata: previous?.metadata }
  return { success: false, content: result.content, error: result.content, metadata: previous?.metadata }
}

export async function runToolBeforeHook(
  hooks: HookSystem | undefined,
  tool: string,
  params: Record<string, unknown>,
): Promise<{ blocked?: ToolResult; warnings: string[]; replaceParams?: Record<string, unknown> }> {
  if (!hooks) return { warnings: [] }
  const output = await hooks.runBefore(tool, params)
  if (output.blocked) return { blocked: blockedByHookResult(tool, output.warnings.join("; ")), warnings: output.warnings }
  return { warnings: output.warnings, replaceParams: output.replaceParams }
}

export async function runToolAfterHook(
  hooks: HookSystem | undefined,
  tool: string,
  params: Record<string, unknown>,
  result: ToolResult,
): Promise<{ result: ToolResult; warnings: string[] }> {
  if (!hooks) return { result, warnings: [] }
  const output = await hooks.runAfter(tool, params, { success: result.success, content: result.content })
  return { result: output.replaceResult ? normalizeHookResult(output.replaceResult, result) : result, warnings: output.warnings }
}

export function appendHookWarnings(result: ToolResult, warnings: string[]): ToolResult {
  if (warnings.length === 0) return result
  const content = `${result.content}\n\n[hook warning] ${warnings.join("\n[hook warning] ")}`
  if (result.success) return { ...result, content }
  return { ...result, content, error: result.error }
}

export async function executeToolWithHooks(input: {
  hooks?: HookSystem
  tool: ToolDescriptor
  params: Record<string, unknown>
  execute: (params: Record<string, unknown>) => Promise<ToolResult>
}): Promise<ToolResult> {
  const before = await runToolBeforeHook(input.hooks, input.tool.defn.name, input.params)
  if (before.blocked) return appendHookWarnings(before.blocked, before.warnings)

  // Apply param replacement from hooks (e.g. writeGuard modifies scope restrictions)
  const effectiveParams = before.replaceParams ?? input.params
  const rawResult = await input.execute(effectiveParams)
  const after = await runToolAfterHook(input.hooks, input.tool.defn.name, effectiveParams, rawResult)
  return appendHookWarnings(after.result, [...before.warnings, ...after.warnings])
}

// ── Context building ──

export function buildVolatileContextMessage(ctxText: string, thinkContext: string, knowledgeContext: string): ProviderMessage | null {
  const chunks: string[] = []
  if (ctxText.trim()) chunks.push(`## Loaded Context\n${ctxText.trim()}`)
  if (thinkContext.trim()) chunks.push(`## Similar Thinking Notes\n${thinkContext.trim()}`)
  if (knowledgeContext.trim()) chunks.push(`## Learned Knowledge\n${knowledgeContext.trim()}`)
  if (chunks.length === 0) return null

  return {
    role: "user",
    content: [
      "## Volatile Round Context",
      "Use this as temporary context for the current request. Do not treat it as a new user request.",
      chunks.join("\n\n"),
    ].join("\n\n"),
  }
}

// ── Research evidence ──

import type { ResearchEvidence } from "../research-answer"

export async function collectResearchEvidence(input: {
  tools: ToolDescriptor[]
  queries: string[]
  hooks?: HookSystem
}): Promise<ResearchEvidence[]> {
  const webSearch = input.tools.find(tool => tool.defn.name === "web_search")
  if (!webSearch) {
    return input.queries.slice(0, 3).map(query => ({
      query,
      success: false,
      content: "web_search tool is not available.",
    }))
  }

  const evidence: ResearchEvidence[] = []
  for (const query of input.queries.slice(0, 3)) {
    try {
      const result = await executeToolWithHooks({
        hooks: input.hooks,
        tool: webSearch,
        params: { query },
        execute: (p) => withToolTimeout("web_search", webSearch.execute(p), 12_000),
      })
      evidence.push({ query, success: result.success, content: result.content })
    } catch (e) {
      evidence.push({ query, success: false, content: e instanceof Error ? e.message : String(e) })
    }
  }
  return evidence
}

// ── Typecheck helpers ──

export function containsTypecheckFailure(text: string): boolean {
  return /\berror TS\d+|\btypecheck\b.*\b(fail|failed|error)|\[diagnostics\]|\[tsc unavailable\]/i.test(text)
}

export function countTypecheckIssues(text: string): number {
  const matches = text.match(/\berror TS\d+/g)
  if (matches?.length) return matches.length
  return containsTypecheckFailure(text) ? 1 : 0
}

export function isVerificationUnavailable(text: string): boolean {
  return /\[tsc unavailable\]|not recognized|command not found|failed to spawn/i.test(text)
}

// ── Runtime self-edit gate ──

export function isRuntimeProjectRoot(cwd = process.cwd()): boolean {
  return existsSync(resolve(cwd, "src/agent/loop.ts")) &&
    existsSync(resolve(cwd, "src/provider/deepseek.ts")) &&
    existsSync(resolve(cwd, "package.json"))
}

export function isRuntimeSourceFile(path: string, cwd = process.cwd()): boolean {
  if (!isRuntimeProjectRoot(cwd)) return false
  const normalized = normalizeProjectPath(path)
  return (
    normalized.startsWith("src/agent/") ||
    normalized.startsWith("src/tools/") ||
    normalized.startsWith("src/ui/") ||
    normalized.startsWith("src/provider/") ||
    normalized.startsWith("src/memory/") ||
    normalized.startsWith("src/context/") ||
    normalized.startsWith("src/hooks/") ||
    normalized.startsWith("src/verification/") ||
    normalized.startsWith("tests/")
  )
}

export function rootRuntimeVerificationPassed(results: VerificationResult[]): boolean {
  return results.some(result => {
    if (!result.passed || result.kind !== "typecheck") return false
    const command = result.command.replace(/\\/g, "/").toLowerCase()
    return !/\bcd\s+blog\b|\/blog\b|blog\//.test(command)
  })
}

export function formatRuntimeSelfEditGate(files: string[]): string {
  return [
    "## Runtime Self-Edit Gate",
    "You changed DeepSeek Code runtime source files in the currently running process.",
    "The current Node process cannot use those source changes until the CLI is restarted.",
    "",
    "Required next step:",
    "1. Run exactly one root project typecheck command, for example: `bun run typecheck` or `npx tsc --noEmit --pretty false` from the deepseek-code root.",
    "2. If it passes, stop and tell the user to restart DeepSeek Code.",
    "3. Do not inspect unrelated files, do not keep debugging the old in-memory behavior, and do not claim the running process has picked up the fix.",
    "",
    "Changed runtime files:",
    ...files.slice(0, 12).map(file => `- ${file}`),
  ].join("\n")
}

// ── Explicit required file helpers ──

export function normalizeExplicitFile(path: string): string {
  return normalizeProjectPath(path)
    .replace(/^\.\/+/, "")
    .replace(/[),.;:]+$/g, "")
}

export function explicitRequiredFiles(prompt: string): string[] {
  const files = new Set<string>()
  const patterns = [
    /\b(?:add|create|write|include)\b[^.\n\r]{0,120}?\b([A-Za-z0-9_./\\-]+(?:\.test|\.spec)\.(?:ts|tsx|js|jsx|mjs|cjs))\b/gi,
    /(?:添加|创建|新建|写入|编写)[^。\n\r]{0,120}?([A-Za-z0-9_./\\-]+(?:\.test|\.spec)\.(?:ts|tsx|js|jsx|mjs|cjs))/gi,
  ]
  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const file = match[1] ? normalizeExplicitFile(match[1]) : ""
      if (file) files.add(file)
    }
  }
  return [...files]
}

export function missingExplicitRequiredFiles(prompt: string, modifiedFiles: Set<string>, cwd = process.cwd()): string[] {
  return explicitRequiredFiles(prompt).filter(file => {
    if (modifiedFiles.has(file)) return false
    return !existsSync(resolve(cwd, file))
  })
}
