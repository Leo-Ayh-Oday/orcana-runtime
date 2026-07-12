import type { ConfidenceEvaluator } from "../../evaluator/confidence"
import type { ObjectiveSignals } from "../../evaluator/types"
import { AgentState } from "../state-machine"
import type { AgentContext } from "../state-machine"

export interface StringHistoryMessage {
  role: "user" | "assistant"
  content: string
}

export function resolveMaxRounds(explicit: number | undefined, envValue: string | undefined): number {
  if (Number.isFinite(explicit) && explicit! > 0) return Math.floor(explicit!)
  const configured = Number(envValue)
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 50
}

/** Select the newest history that fits while preserving chronological order. */
export function selectRecentHistoryWithinBudget<T extends StringHistoryMessage>(
  history: T[],
  tokenBudget: number,
  estimatedCharsPerToken = 3,
  maxMessages = 60,
): T[] {
  const recent = history.slice(-maxMessages)
  const selected: T[] = []
  let used = 0
  for (let index = recent.length - 1; index >= 0; index--) {
    const message = recent[index]!
    const estimate = Math.ceil(message.content.length / estimatedCharsPerToken)
    if (used + estimate > tokenBudget) break
    used += estimate
    selected.push(message)
  }
  selected.reverse()
  while (selected[0]?.role === "assistant") selected.shift()
  return selected
}

/** Build agent contract context for state machine validation. */
export function buildAgentContractContext(input: {
  round: number
  priorTools: string[]
  priorFiles: Set<string>
  toolErrors: number
  modifiedFiles: number
}): AgentContext {
  const wrote = input.modifiedFiles > 0 || input.priorTools.some(tool => tool === "write_file" || tool === "edit_file" || tool === "edit_fim" || tool === "multi_edit")
  const currentState = input.toolErrors > 0 ? AgentState.REPAIR : wrote ? AgentState.VERIFY : AgentState.DONE
  return {
    state: currentState,
    roundNum: input.round,
    priorTools: input.priorTools,
    priorFiles: new Set(input.priorFiles),
    errorCount: input.toolErrors,
    consecutiveErrors: input.toolErrors,
    toolResults: new Map(),
  }
}

/** Format the quality gate prompt when confidence/contracts are below threshold. */
export function formatQualityGatePrompt(input: {
  confidence: ReturnType<ConfidenceEvaluator["evaluateSync"]>
  contractMessages: string[]
  signals: ObjectiveSignals
}): string {
  const lines = [
    "## Runtime Quality Gate",
    "You cannot finish yet. The runtime quality gate found unresolved objective risks.",
    `Confidence recommendation: ${input.confidence.recommendation} (${Math.round(input.confidence.confidence * 100)}%).`,
  ]
  if (input.signals.typecheck && !input.signals.typecheck.passed) {
    lines.push(`Typecheck/diagnostics: failed with ${input.signals.typecheck.issues} issue(s).`)
  }
  if (typeof input.signals.toolErrors === "number" && input.signals.toolErrors > 0) {
    lines.push(`Tool errors this task: ${input.signals.toolErrors}.`)
  }
  if (input.signals.rippleDecision && input.signals.rippleDecision !== "allow") {
    lines.push(`Ripple decision: ${input.signals.rippleDecision}.`)
  }
  for (const message of input.contractMessages.slice(0, 5)) {
    lines.push(`Contract: ${message}`)
  }
  lines.push("")
  lines.push("Required next step: inspect the failing objective signal, repair or verify it with tools, then provide a concise completion only after the gate can pass.")
  return lines.join("\n")
}

/** Compact long assistant output for history (prefix-safe). */
export function compactAssistantContext(text: string, maxChars = 1200): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const head = lines.slice(0, 8).join("\n")
  const compact = head.length > maxChars ? head.slice(0, maxChars) : head
  return `${compact}\n[assistant output compacted from ${trimmed.length} chars]`
}

export function formatRoundBudgetExhausted(maxRounds: number): string {
  return `本次运行已达到 ${maxRounds} 轮安全上限，已暂停以避免无限工具循环。上下文和检查点仍保留；发送“继续”即可从当前进度接着执行。`
}
