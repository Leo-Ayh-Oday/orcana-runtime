/** Post-loop utilities: diagnostics, ripple verification, thinking compaction, state machine updates.
 *  Extracted from loop.ts to keep the main agent loop under size thresholds. */

import { existsSync } from "node:fs"
import { collectProcessRun } from "../../runtime/process-executor"
import { resolve } from "node:path"
import type { ProviderMessage } from "../../provider/types"
import { getLSPClient } from "../../lsp/client"
import { runTypeScriptNoEmit } from "../../tools/typescript"
import { AgentState, StateMachine } from "../state-machine"

// ── Post-edit diagnostics ──

export async function runPostEditDiagnostics(path: string, result: { success: boolean; content: string }) {
  if (!path.endsWith(".py") && !path.endsWith(".ts") && !path.endsWith(".tsx")) return
  // A custom or failed write adapter may report a path without materializing it.
  // There can be no file-local diagnostics in that case, and a full-project tsc
  // fallback would add seconds of work without changing the result.
  if (!existsSync(resolve(path))) return
  try {
    let diagnostics = ""
    if (path.endsWith(".py")) {
      const ruff = await collectProcessRun({ command: "ruff", args: ["check", path, "--output-format", "concise"], timeoutMs: 10000 })
      if (ruff.stdout.trim()) diagnostics = ruff.stdout.trim()
    }
    if (path.endsWith(".ts") || path.endsWith(".tsx")) {
      // LSP fast path: notify change + read cached diagnostics for this file
      const lsp = getLSPClient()
      lsp.notifyChange(path).catch(() => {})
      // Small delay for LSP to process (non-blocking — we just wait a tick)
      const lspResult = lsp.getVerificationResult(path)
      if (lspResult && lspResult.issues > 0) {
        diagnostics = lspResult.summary
      } else if (!lsp.isAvailable) {
        // LSP unavailable — fall back to full tsc (preserved ground truth)
        const check = await runTypeScriptNoEmit(process.cwd())
        const out = check.passed ? "" : check.output
        if (out.trim() && out.includes(path)) diagnostics = out.trim().split("\n").filter(l => l.includes(path)).join("\n")
      }
    }
    if (diagnostics && result.success) { ;(result as Record<string, unknown>).content = result.content + `\n\n[diagnostics]\n${diagnostics}` }
  } catch { /* not available */ }
}

// ── Ripple verification ──

export async function runRippleVerification(modifiedFiles: Set<string>): Promise<{ passed: boolean; available: boolean; issues: number; output?: string }> {
  const tsFiles = [...modifiedFiles].filter(path => path.endsWith(".ts") || path.endsWith(".tsx"))
  if (!tsFiles.length) return { passed: true, available: true, issues: 0 }
  if (!tsFiles.some(path => existsSync(resolve(path)))) return { passed: true, available: true, issues: 0 }

  // LSP fast path: check cached diagnostics for modified files
  const lsp = getLSPClient()
  if (lsp.isAvailable) {
    let totalErrors = 0
    const summaries: string[] = []
    for (const file of tsFiles) {
      const counts = lsp.getSeverityCounts(file)
      if (counts.errors > 0) {
        totalErrors += counts.errors
        summaries.push(`${file}: ${counts.errors} errors`)
      }
    }
    if (totalErrors > 0) {
      return { passed: false, available: true, issues: totalErrors, output: summaries.join("\n") }
    }
    return { passed: true, available: true, issues: 0, output: "LSP: no errors" }
  }

  // LSP unavailable — tsc ground truth
  return runTypeScriptNoEmit(process.cwd())
}

// ── Thinking compaction helpers ──

export interface CollectedThinkingRound {
  roundNum: number
  thinking: string
  toolsUsed: string[]
  hadError: boolean
}

export function collectThinkingRounds(messages: ProviderMessage[]): CollectedThinkingRound[] {
  const rounds: CollectedThinkingRound[] = []
  let roundNum = 0
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    const content = Array.isArray(msg.content) ? msg.content : []
    const thinkingBlocks: string[] = []
    const toolNames: string[] = []
    for (const block of content) {
      if (isRecord(block) && block.type === "thinking" && typeof block.thinking === "string") {
        thinkingBlocks.push(block.thinking)
      }
      if (isRecord(block) && block.type === "tool_use" && typeof block.name === "string") {
        toolNames.push(block.name)
      }
    }
    if (thinkingBlocks.length > 0) {
      rounds.push({
        roundNum: roundNum++,
        thinking: thinkingBlocks.join("\n---\n"),
        toolsUsed: toolNames,
        hadError: false, // approximated — errors detected during tool execution, not in history
      })
    }
  }
  return rounds
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// ── Thinking insufficiency detection ──

export function collectRecentTurns(messages: ProviderMessage[], count: number): Array<{ role: string; content: string }> {
  return messages.slice(-count).map(m => {
    const content = Array.isArray(m.content)
      ? m.content.filter((b: unknown) => isRecord(b) && b.type === "text").map((b: Record<string, unknown>) => String(b.text ?? "")).join("\n")
      : String(m.content ?? "")
    return { role: m.role, content: content.slice(0, 800) }
  })
}

// ── Microcompact: tool result placeholder substitution ──

const MC_READFILE_CHARS = Number(process.env.ORCANA_READFILE_COMPACT_CHARS) || 0
const MC_SHELL_CHARS = Number(process.env.ORCANA_SHELL_COMPACT_CHARS) || 3000
const MC_WEBFETCH_CHARS = Number(process.env.ORCANA_WEBFETCH_COMPACT_CHARS) || 5000

export function mcThreshold(toolName: string): number {
  if (toolName === "read_file") return MC_READFILE_CHARS
  if (toolName === "shell") return MC_SHELL_CHARS
  if (toolName === "web_fetch") return MC_WEBFETCH_CHARS
  return Infinity
}

/** Extract future-tense promises from agent text for testimony ledger. */
export function extractPromises(text: string): string[] {
  const patterns = [
    /(?:接下来|下一步|随后|下一步骤|马上|立即|现在)\s*(?:我会|我将|我们要|需要)\s*([^。\n]{4,40})/g,
    /(?:我会|我将|我们要|打算)\s*([^。\n]{4,40})/g,
    /(?:需要\s*(?:再|补充|额外|进一步))\s*([^。\n]{4,40})/g,
  ]
  const results: string[] = []
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const p = match[1]?.trim()
      if (p && p.length > 3 && !p.includes("？") && !p.includes("?")) {
        results.push(p)
      }
    }
  }
  return [...new Set(results)].slice(0, 5)
}

/** 错误特征行：压缩工具结果时保留对调试最关键的线索行。 */
const ERROR_LINE_RE = /error|fail(ed|ure)?|traceback|fatal|exception|✗|FAILED|exit code|timed out|cannot|undefined is not|panic/i

export function extractErrorLines(content: string, maxLines = 3): string[] {
  const lines = content.split("\n")
  const seen = new Set<string>()
  const picked: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (t.length < 5 || t.length > 400) continue
    if (!ERROR_LINE_RE.test(t)) continue
    if (seen.has(t)) continue
    seen.add(t)
    picked.push(t)
    if (picked.length >= maxLines) break
  }
  return picked
}

export function microcompactToolResults(
  results: Array<Record<string, unknown>>,
  completedCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): { compacted: number; results: Array<Record<string, unknown>> } {
  let compacted = 0
  const nameById = new Map(completedCalls.map(tc => [tc.id, tc]))
  const out: Array<Record<string, unknown>> = []
  for (const r of results) {
    if (r.type !== "tool_result" || typeof r.content !== "string" || r.content.length < 100) {
      out.push(r); continue
    }
    const tc = nameById.get(String(r.tool_use_id ?? ""))
    if (!tc) { out.push(r); continue }
    const threshold = mcThreshold(tc.name)
    if (threshold <= 0 || r.content.length <= threshold) { out.push(r); continue }
    const pathOrCmd = tc.name === "read_file" ? String(tc.input.path ?? "")
      : tc.name === "shell" ? String(tc.input.command ?? "").slice(0, 80)
      : tc.name === "web_fetch" ? String(tc.input.url ?? "")
      : ""
    // X2 (RC-02.5): head 300 + 错误特征行（≤3 行），避免大输出中错误线索被截掉。
    const prefix = r.content.slice(0, 300)
    const errorLines = extractErrorLines(r.content)
    const exitInfo = typeof r.is_error === "boolean" && r.is_error
      ? " [is_error]"
      : ""
    const placeholder = `[Microcompact: ${tc.name} ${pathOrCmd} — ${r.content.length} chars trimmed${exitInfo}. Re-execute ${tc.name}(${JSON.stringify(pathOrCmd)}) to retrieve full content.]`
    const errorBlock = errorLines.length
      ? "\n\n[错误线索]\n" + errorLines.map(l => `> ${l}`).join("\n")
      : ""
    out.push({ ...r, content: prefix + errorBlock + "\n\n" + placeholder })

    compacted++
  }
  return { compacted, results: out }
}

export function compactHistoricalToolResults(messages: ProviderMessage[], keepRecentRounds: number): number {
  let compacted = 0
  let assistantCount = 0
  const compactAfterAssistant = messages.length - keepRecentRounds * 2
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.role === "assistant") assistantCount++
    if (assistantCount <= compactAfterAssistant) continue
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (!isRecord(block) || block.type !== "tool_result" || typeof block.content !== "string" || block.content.includes("[Microcompact:")) continue
      if (block.content.length < 400) continue
      const tid = String(block.tool_use_id ?? "")
      // Only compact read_file/shell/web_fetch whose full output is embedded
      if (!/^(read_file|shell|web_fetch)/.test(tid.split("_")[0] ?? "")) continue
      if (block.content.length < MC_READFILE_CHARS && block.content.length < MC_SHELL_CHARS) continue
      // X2 (RC-02.5): historical 压缩同样保留错误特征行。
      const errorLines = extractErrorLines(block.content)
      const errorBlock = errorLines.length
        ? "\n\n[错误线索]\n" + errorLines.map(l => `> ${l}`).join("\n")
        : ""
      block.content = block.content.slice(0, 300) + errorBlock + `\n\n[Microcompact: historical ${tid.slice(0, 8)}… — content trimmed. Re-execute the original tool call to retrieve.]`
      compacted++
    }
  }
  return compacted
}

// ── State machine update ──

export interface StateMachineInput {
  roundHadToolError: boolean
  hadSearchTool: boolean
  hadWriteTool: boolean
  hadVerifyTool: boolean
  isDone: boolean
  pendingRippleCount: number
}

export function updateStateMachine(sm: StateMachine, input: StateMachineInput) {
  const current = sm.currentState
  try {
    if (input.isDone && current !== AgentState.DONE) {
      sm.transition(AgentState.DONE, `task complete (pending ripple: ${input.pendingRippleCount})`)
      return
    }
    if (input.roundHadToolError && current !== AgentState.REPAIR && current !== AgentState.BLOCKED) {
      sm.transition(AgentState.REPAIR, "tool errors detected")
      return
    }
    if (input.hadVerifyTool && (current === AgentState.CODE || current === AgentState.REPAIR)) {
      sm.transition(AgentState.VERIFY, "verification running")
      return
    }
    if (input.hadWriteTool && current !== AgentState.CODE && current !== AgentState.VERIFY && current !== AgentState.REPAIR) {
      sm.transition(AgentState.CODE, "writing code")
      return
    }
    if (input.hadSearchTool && (current === AgentState.UNDERSTAND || current === AgentState.SEARCH)) {
      sm.transition(AgentState.SEARCH, "searching")
      return
    }
  } catch {
    // Transition validation failed — state machine caught an illegal transition.
    // The ad-hoc flags still drive behavior; SM is a monitoring layer.
  }
}
