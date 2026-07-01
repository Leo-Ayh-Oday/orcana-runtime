/** adapter-helpers — 纯格式化函数，从 main.tsx 提取。
 *  被 event-adapter.ts、event-reducer.ts 和 main.tsx 共用，
 *  避免逻辑重复并保持 reducer 纯净（不依赖 .tsx 文件）。 */

import type { ClarificationReady, ClarificationQuestion } from "../../agent/clarification"
import { cleanDisplayText } from "../format"

// ── Assistant text ──

export function appendAssistantText(current: string, chunk: string): string {
  const next = current + chunk
  const maxLiveChars = Number(process.env.DEEPSEEK_TUI_LIVE_CHARS ?? "12000")
  if (next.length <= maxLiveChars) return next
  return `...[live output trimmed ${next.length - maxLiveChars} chars]\n${next.slice(-maxLiveChars)}`
}

export function compactAssistantText(text: string): string {
  return text
    .trim()
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s*[-*]\s+/gm, "- ")
}

// ── User prompt ──

export function summarizeUserPromptForTranscript(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const lines = normalized ? normalized.split("\n").length : 0
  const chars = normalized.length
  const maxInlineChars = Number(process.env.DEEPSEEK_TUI_USER_DISPLAY_CHARS ?? "1600")
  const maxInlineLines = Number(process.env.DEEPSEEK_TUI_USER_DISPLAY_LINES ?? "12")
  if (chars <= maxInlineChars && lines <= maxInlineLines) return text

  const firstUsefulLine = normalized
    .split("\n")
    .map(line => line.trim())
    .find(Boolean)
  const preview = firstUsefulLine ? `\npreview: ${firstUsefulLine.slice(0, 180)}` : ""
  return `[Pasted text loaded: +${lines} lines, ${chars} chars]${preview}`
}

// ── Clarification ──

export function formatClarificationTranscript(data: ClarificationReady): string {
  return `I need ${data.questions.length} clarification answers before implementation. Use the selector below.`
}

export function formatClarificationHistoryMarker(data: ClarificationReady): string {
  return [
    "[clarification-gate]",
    "Clarification requested. The TUI is collecting answers one question at a time.",
    `Original request: ${data.originalPrompt}`,
  ].join("\n")
}

// ── Status / Error ──

export function compactStatusText(status: string): string {
  if (/^context-kernel:/i.test(status)) return "context ready"
  if (/^thinking-compaction:/i.test(status)) return "memory compacted"
  if (/^ctx\s/i.test(status)) return status
  if (status === "working") return "working"
  return status
}

export function cleanAgentError(text: string): string {
  if (text.includes("[clarification-gate]")) {
    return "Clarification failed. Please add a little more detail and try again."
  }
  return text
}

// ── Telemetry ──

export function modelNameFromUsage(data: Record<string, unknown>): string {
  if (typeof data.actualModel === "string") return data.actualModel
  if (typeof data.requestedModel === "string") return data.requestedModel
  return "unknown-model"
}

export function formatTelemetryLine(data: Record<string, unknown>, modelName?: string): string {
  const model = modelName ?? modelNameFromUsage(data)
  return `model ${model} / ctx ${data.contextUsagePercent ?? "?"}% / cache ${data.cacheHitRate ?? "?"}% / round ${data.round ?? "?"}`
}

export function formatStatusLineFromUsage(data: Record<string, unknown>): string {
  return `ctx ${data.contextUsagePercent ?? "?"}% / cache ${data.cacheHitRate ?? "?"}% / r${data.round ?? "?"}`
}

// ── Tool output ──

export function summarizeToolOutput(content?: string): string {
  if (!content || !content.trim()) return ""
  return ` / ${cleanDisplayText(content).replace(/\s+/g, " ").slice(0, 120)}`
}

// ── Text helpers ──

export function takeVisibleLines(text: string, maxLines: number): string {
  return text.split("\n").slice(0, maxLines).join("\n")
}

// ── Clarification wizard helpers ──

/** 返回 question 中第一个 recommended 选项的索引，无则 0。 */
export function recommendedOptionIndex(question: ClarificationQuestion | undefined): number {
  if (!question?.options.length) return 0
  const recommended = question.options.findIndex(option => option.recommended)
  return recommended >= 0 ? recommended : 0
}

/** 将 clarification wizard 的答案合成为一条文本消息，作为新一轮 agent 输入。 */
export function synthesizeClarificationAnswer(wizard: {
  answers: Array<{ question: string; key: string; label: string }>
}): string {
  const lines = [
    "Clarification answers:",
    ...wizard.answers.map((answer, index) => `${index + 1}. ${answer.question}: ${answer.key}. ${answer.label}`),
  ]
  lines.push("Extra: none")
  return lines.join("\n")
}
