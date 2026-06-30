import type { ClarificationReady } from "../../agent/clarification"

export function appendAssistantText(current: string, chunk: string): string {
  const next = current + chunk
  const maxLiveChars = Number(process.env.DEEPSEEK_TUI_LIVE_CHARS ?? "12000")
  if (next.length <= maxLiveChars) return next
  return `...[live output trimmed ${next.length - maxLiveChars} chars]\n${next.slice(-maxLiveChars)}`
}

export function formatClarificationTranscript(data: ClarificationReady): string {
  return `I need ${data.questions.length} clarification answers before implementation. Use the selector below.`
}

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
