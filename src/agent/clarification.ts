import type { TaskTracker } from "./task-tracker"
import type { LLMProvider, ProviderCallOptions } from "../provider/types"
import type { UILanguage } from "./language"

export const CLARIFICATION_MARKER = "[clarification-gate]"

export interface ClarificationResult {
  required: boolean
  reason?: string
  originalPrompt?: string
}

export interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

export interface ModelClarificationInput {
  provider: LLMProvider
  model: string
  prompt: string
  tracker: TaskTracker
  result: ClarificationResult
  language?: UILanguage
}

export interface ClarificationOption {
  key: string
  label: string
  recommended?: boolean
}

export interface ClarificationQuestion {
  id: string
  title: string
  options: ClarificationOption[]
}

export interface ClarificationReady {
  marker: string
  originalPrompt: string
  questions: ClarificationQuestion[]
  extraPrompt?: string
  rawText: string
}

function normalizedLength(text: string): number {
  return text.replace(/\s+/g, "").length
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text))
}

function specificityScore(prompt: string): number {
  let score = 0
  if (hasAny(prompt, [/react|vue|svelte|vite|next|bun|node|express|hono|typescript|sqlite|postgres|mysql/i])) score++
  if (hasAny(prompt, [/style|design|visual|palette|font|responsive|mobile|dashboard|login|comment|tag|search|markdown|seo|风格|设计|视觉|配色|字体|响应式|移动端|后台|管理|登录|评论|标签|搜索/i])) score++
  if (hasAny(prompt, [/test|typecheck|build|verify|deploy|测试|验证|构建|上线|部署/i])) score++
  if (hasAny(prompt, [/database|file storage|json|api|auth|permission|cache|数据库|文件存储|接口|鉴权|权限|缓存/i])) score++
  if (/[,.;?，。；？\n].*[,.;?，。；？\n]/.test(prompt)) score++
  return score
}

function formatTrackerFacts(tracker: TaskTracker): string {
  const steps = tracker.steps.map(step => `${step.id}:${step.title}`).join(", ") || "none"
  return [
    `goal: ${tracker.goal}`,
    `intent: ${tracker.intent}`,
    `phase: ${tracker.phase}`,
    `requiredFiles: ${tracker.requiredFiles.join(", ") || "none"}`,
    `verification: ${tracker.verification.join(", ") || "none"}`,
    `steps: ${steps}`,
  ].join("\n")
}

export function findPendingClarification(history: ChatMessage[] | undefined): string | null {
  if (!history?.length) return null
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i]
    if (item?.role !== "assistant" || !item.content.includes(CLARIFICATION_MARKER)) continue
    for (let j = i - 1; j >= 0; j--) {
      const prior = history[j]
      if (prior?.role === "user" && prior.content.trim()) return prior.content
    }
    return null
  }
  return null
}

export function buildEffectivePrompt(prompt: string, history: ChatMessage[] | undefined): string {
  const original = findPendingClarification(history)
  if (!original) return prompt
  return [original, "", "User clarification:", prompt].join("\n")
}

export function evaluateClarificationNeed(input: {
  prompt: string
  tracker: TaskTracker | null
  history?: ChatMessage[]
}): ClarificationResult {
  if (!input.tracker) return { required: false }
  if (findPendingClarification(input.history)) return { required: false }

  const shortPrompt = normalizedLength(input.prompt) < 80
  const underspecified = specificityScore(input.prompt) < 3
  if (!shortPrompt || !underspecified) return { required: false }

  return {
    required: true,
    reason: "prompt_underspecified",
    originalPrompt: input.prompt,
  }
}

function normalizeOptionKey(key: string, fallback: number): string {
  const upper = key.trim().toUpperCase()
  if (/^[A-Z]$/.test(upper)) return upper
  return String.fromCharCode("A".charCodeAt(0) + fallback)
}

function cleanupOptionLabel(text: string): { label: string; recommended: boolean } {
  const trimmed = text.trim().replace(/[。.\s]+$/g, "").trim()
  const recommended = /\b(recommended|default)\b|推荐|默认/i.test(trimmed)
  const label = trimmed
    .replace(/[（(]\s*(recommended|default|推荐|默认)\s*[）)]/ig, "")
    .replace(/\s+/g, " ")
    .trim()
  return { label: label || trimmed, recommended }
}

function normalizeQuestions(value: unknown): ClarificationQuestion[] {
  if (!Array.isArray(value)) return []
  const questions: ClarificationQuestion[] = []
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object") continue
    const record = item as Record<string, unknown>
    const title = String(record.title ?? record.question ?? "").trim()
    const rawOptions = Array.isArray(record.options) ? record.options : []
    const options: ClarificationOption[] = []

    for (const [optionIndex, option] of rawOptions.entries()) {
      if (typeof option === "string") {
        const cleaned = cleanupOptionLabel(option)
        if (cleaned.label) {
          options.push({
            key: normalizeOptionKey("", optionIndex),
            label: cleaned.label,
            recommended: Boolean(cleaned.recommended),
          })
        }
        continue
      }
      if (!option || typeof option !== "object") continue
      const optionRecord = option as Record<string, unknown>
      const cleaned = cleanupOptionLabel(String(optionRecord.label ?? optionRecord.text ?? ""))
      if (!cleaned.label) continue
      options.push({
        key: normalizeOptionKey(String(optionRecord.key ?? ""), optionIndex),
        label: cleaned.label,
        recommended: Boolean(optionRecord.recommended) || Boolean(cleaned.recommended),
      })
    }

    if (title && options.length >= 2) {
      questions.push({ id: String(record.id ?? index + 1), title, options })
    }
  }
  return questions
}

function parseJsonClarification(text: string): ClarificationQuestion[] {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    return normalizeQuestions(parsed.questions)
  } catch {
    return []
  }
}

function parseTextQuestionLine(line: string): ClarificationQuestion | null {
  const questionMatch = line.match(/^\s*(\d+)[\.\u3001\)]\s*(.+)$/)
  if (!questionMatch) return null
  const id = questionMatch[1] ?? ""
  const body = questionMatch[2] ?? ""
  const firstOption = body.search(/\bA[\.\u3001:：]/i)
  if (firstOption < 0) return null

  const title = body.slice(0, firstOption).replace(/[：:，,]\s*$/g, "").trim()
  const optionsText = body.slice(firstOption)
  const optionMatches = [...optionsText.matchAll(/\b([A-Z])[\.\u3001:：]\s*([\s\S]*?)(?=\s+\b[A-Z][\.\u3001:：]|\s*$)/gi)]
  const options = optionMatches
    .map((match, index) => {
      const cleaned = cleanupOptionLabel(match[2] ?? "")
      return {
        key: normalizeOptionKey(match[1] ?? "", index),
        label: cleaned.label,
        recommended: cleaned.recommended,
      }
    })
    .filter(option => option.key && option.label)

  if (!title || options.length < 2) return null
  return { id, title, options }
}

function parseTextClarification(text: string): ClarificationQuestion[] {
  return text
    .split(/\r?\n/)
    .map(line => parseTextQuestionLine(line))
    .filter((question): question is ClarificationQuestion => Boolean(question))
    .slice(0, 5)
}

export function isUsableModelClarification(text: string): boolean {
  return parseModelClarification(text, "probe") !== null
}

export function parseModelClarification(text: string, originalPrompt: string): ClarificationReady | null {
  const trimmed = text.trim()
  if (!trimmed.includes(CLARIFICATION_MARKER)) return null

  const questions = parseJsonClarification(trimmed).length > 0
    ? parseJsonClarification(trimmed)
    : parseTextClarification(trimmed)
  if (questions.length < 1) return null

  const extraPrompt = trimmed
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.includes("Orcana") && /extra|anything else|额外|补充/i.test(line))

  return {
    marker: CLARIFICATION_MARKER,
    originalPrompt,
    questions,
    extraPrompt,
    rawText: trimmed,
  }
}

export function formatModelClarificationFailure(): string {
  return [
    CLARIFICATION_MARKER,
    "Clarification failed: the model did not return selectable questions.",
    "No fallback questions were generated.",
  ].join("\n")
}

export function buildModelClarificationCall(input: ModelClarificationInput): ProviderCallOptions {
  const lang = input.language ?? "en"
  const langLine = lang === "zh"
    ? "用户使用中文。你必须用中文生成所有问题和选项文本。"
    : "The user is using English. Generate all questions and options in English."
  const system = [
    "You are Orcana's clarification question generator.",
    langLine,
    "Only clarify requirements. Do not implement, plan, or call tools.",
    "Do not use hardcoded template questions. Questions must be derived from the user's request and tracker facts.",
    "",
    "Return valid JSON only, with this shape:",
    "{",
    `  "marker": "${CLARIFICATION_MARKER}",`,
    '  "questions": [',
    '    {"id":"1","title":"...","options":[{"key":"A","label":"...","recommended":true},{"key":"B","label":"..."},{"key":"C","label":"..."}]}',
    "  ],",
    '  "extraPrompt": "Anything else you want to tell Orcana?"',
    "}",
    "",
    "Rules:",
    `- marker must be ${CLARIFICATION_MARKER}`,
    "- Ask 1 to 5 questions that materially change implementation.",
    "- Each question needs 2 to 4 concrete options.",
    "- Mark at most one recommended option per question.",
    "- Do not include markdown or code fences.",
  ].join("\n")

  const user = [
    "Original user request:",
    input.prompt,
    "",
    "Runtime decided this is an underspecified long coding task.",
    "Tracker facts:",
    formatTrackerFacts(input.tracker),
  ].join("\n")

  return {
    model: input.model,
    purpose: "clarification",
    system,
    messages: [{ role: "user", content: user }],
    tools: [],
    thinking: { type: "enabled", budget_tokens: 8192, effort: "max" },
    maxTokens: 4096,
  }
}
