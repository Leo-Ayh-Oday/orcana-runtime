import type { ProviderMessage } from "../provider/types"

export type CacheAnatomySectionKind =
  | "system"
  | "tools"
  | "conversation"
  | "stableContext"
  | "volatileContext"
  | "contextBudgetGuard"
  | "currentPrompt"
  | "memoryAnchor"
  | "memoryDeltas"
  | "memoryRetrieval"
  | "thinking"

export interface CacheAnatomySection {
  kind: CacheAnatomySectionKind
  tokens: number
  stable: boolean
}

export interface CacheAnatomy {
  sections: CacheAnatomySection[]
  stableTokens: number
  volatileTokens: number
  totalTokens: number
  estimatedCacheableTokens: number
  estimatedUncachedTokens: number
  estimatedCacheableRate: number
  thinkingTokens: number
  /** True when thinking overhead is excessive (>40% of budget) */
  thinkingOverBudget: boolean
}

export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "")
  return Math.round(text.length / 3)
}

export function summarizeMessages(messages: ProviderMessage[]): {
  conversationTokens: number
  stableContextTokens: number
  volatileTokens: number
  budgetGuardTokens: number
  currentPromptTokens: number
} {
  let conversationTokens = 0
  let stableContextTokens = 0
  let volatileTokens = 0
  let budgetGuardTokens = 0
  let currentPromptTokens = 0

  messages.forEach((message, index) => {
    const tokens = estimateTokens(message.content)
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    if (content.includes("## Stable Prefix Context")) {
      stableContextTokens += tokens
    } else if (content.includes("## Volatile Round Context")) {
      volatileTokens += tokens
    } else if (content.includes("## Context Budget Guard")) {
      budgetGuardTokens += tokens
    } else if (message.role === "user" && index === messages.length - 1) {
      currentPromptTokens += tokens
    } else {
      conversationTokens += tokens
    }
  })

  return { conversationTokens, stableContextTokens, volatileTokens, budgetGuardTokens, currentPromptTokens }
}

/** Budget ratio above which thinking overhead triggers compaction. */
const THINKING_OVERBUDGET_RATIO = 0.4

export function buildCacheAnatomy(input: {
  system: string
  tools?: Array<Record<string, unknown>>
  messages: ProviderMessage[]
  /** Estimated tokens consumed by reasoning/thinking blocks this session */
  thinkingTokens?: number
  /** Total context window budget for adaptive threshold */
  contextMax?: number
}): CacheAnatomy {
  const messageSummary = summarizeMessages(input.messages)
  const thinkingTokens = input.thinkingTokens ?? 0
  const thinkingOverBudget = input.contextMax
    ? thinkingTokens > input.contextMax * THINKING_OVERBUDGET_RATIO
    : false

  const sections: CacheAnatomySection[] = [
    { kind: "system", tokens: estimateTokens(input.system), stable: true },
    { kind: "tools", tokens: estimateTokens(input.tools ?? []), stable: true },
    { kind: "stableContext", tokens: messageSummary.stableContextTokens, stable: true },
    { kind: "conversation", tokens: messageSummary.conversationTokens, stable: false },
    { kind: "volatileContext", tokens: messageSummary.volatileTokens, stable: false },
    { kind: "contextBudgetGuard", tokens: messageSummary.budgetGuardTokens, stable: false },
    { kind: "currentPrompt", tokens: messageSummary.currentPromptTokens, stable: false },
    { kind: "memoryAnchor", tokens: 0, stable: true },
    { kind: "memoryDeltas", tokens: 0, stable: false },
    { kind: "memoryRetrieval", tokens: 0, stable: false },
    { kind: "thinking", tokens: thinkingTokens, stable: false },
  ]
  return summarizeSections(sections, thinkingTokens, thinkingOverBudget)
}

export function summarizeSections(
  sections: CacheAnatomySection[],
  thinkingTokens = 0,
  thinkingOverBudget = false,
): CacheAnatomy {
  const stableTokens = sections.filter(section => section.stable).reduce((sum, section) => sum + section.tokens, 0)
  const volatileTokens = sections.filter(section => !section.stable).reduce((sum, section) => sum + section.tokens, 0)
  const totalTokens = stableTokens + volatileTokens
  return {
    sections,
    stableTokens,
    volatileTokens,
    totalTokens,
    estimatedCacheableTokens: stableTokens,
    estimatedUncachedTokens: volatileTokens,
    estimatedCacheableRate: totalTokens > 0 ? Math.round((stableTokens / totalTokens) * 1000) / 10 : 0,
    thinkingTokens,
    thinkingOverBudget,
  }
}
