import { buildCacheAnatomy } from "../../context/cache-anatomy"
import type { CacheAnatomy } from "../../context/cache-anatomy"
import type { CachePrefixCheck, CacheTracker } from "../../provider/cache-tracker"
import type { ProviderMessage } from "../../provider/types"
import type { ToolDescriptor } from "../../tools/registry"

// ── Token estimation ──

function toolSchemaChars(tools: ToolDescriptor[]): number {
  const schemas = tools.map(tool => tool.toAnthropicSchema()).slice(0, 128)
  return schemas.length ? JSON.stringify(schemas).length : 0
}

export function estimateRoundTokens(
  system: string,
  contextMessages: ProviderMessage[],
  rawMessages: ProviderMessage[],
  budgetContext: ProviderMessage | null,
  tools: ToolDescriptor[] = [],
): { roundInputTokens: number; providerMessages: ProviderMessage[] } {
  const schemas = toolSchemaChars(tools)
  let roundInputTokens = Math.round(
    (system.length +
      schemas +
      contextMessages.reduce((s, m) => s + msgCharLen(m), 0) +
      rawMessages.reduce((s, m) => s + msgCharLen(m), 0)) / 3
  )
  const providerMessages: ProviderMessage[] = [
    ...contextMessages,
    ...rawMessages,
  ]
  if (budgetContext) {
    contextMessages.push(budgetContext)
    providerMessages.push(budgetContext)
    roundInputTokens = Math.round(
      (system.length + schemas + providerMessages.reduce((s, m) => s + msgCharLen(m), 0)) / 3
    )
  }
  return { roundInputTokens, providerMessages }
}

function msgCharLen(m: ProviderMessage): number {
  return typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length
}

// ── Cache-stable tool set ──

/** Return the full tool set, respecting cache-stable mode. */
export function cacheStableProviderTools(allTools: ToolDescriptor[]): ToolDescriptor[] {
  // When cache-stable tools are enabled, always use the full tool set
  // so the prefix cache remains stable across rounds.
  return allTools
}

// ── Provider request assembly ──

export interface RoundRequestBuildInput {
  modelName: string
  system: string
  providerMessages: ProviderMessage[]
  tools: ToolDescriptor[]
  cacheTracker: CacheTracker
  thinkingTokenTotal: number
  contextInputTotal: number
  contextOutputTotal: number
  contextMax: number
  round: number
  contextUsagePercent: number
}

export interface RoundRequestBuildOutput {
  providerToolSchemas: Array<Record<string, unknown>>
  cacheAnatomy: CacheAnatomy
  cacheShape: CachePrefixCheck
  cacheStatus: CachePrefixCheck["status"]
  estimatedUsageEvent: {
    requestedModel: string
    inputTokens: number
    outputTokens: number
    contextMax: number
    round: number
    cacheHitRate: number
    cacheStatus: CachePrefixCheck["status"]
    cacheSource: "estimate"
    cachePrefixShape: {
      firstChangedSection?: string
      sections: CachePrefixCheck["sections"]
    }
    contextUsagePercent: number
    cacheAnatomy: CacheAnatomy
  }
}

export function buildRoundProviderRequest(input: RoundRequestBuildInput): RoundRequestBuildOutput {
  const providerToolSchemas = input.tools
    .map(tool => tool.toAnthropicSchema())
    .slice(0, 128)
  const cacheAnatomy = buildCacheAnatomy({
    system: input.system,
    tools: providerToolSchemas,
    messages: input.providerMessages,
    thinkingTokens: input.thinkingTokenTotal,
    contextMax: input.contextMax,
  })
  const cacheShape = input.cacheTracker.checkPrefixShape([
    { kind: "model", value: input.modelName },
    { kind: "system", value: input.system },
    { kind: "tools", value: providerToolSchemas },
    { kind: "messages", value: input.providerMessages },
  ])
  const cacheStatus = cacheShape.status
  const estimatedUsageEvent = {
    requestedModel: input.modelName,
    inputTokens: input.contextInputTotal,
    outputTokens: input.contextOutputTotal,
    contextMax: input.contextMax,
    round: input.round,
    cacheHitRate: cacheShape.hitRate,
    cacheStatus,
    cacheSource: "estimate" as const,
    cachePrefixShape: {
      firstChangedSection: cacheShape.firstChangedSection,
      sections: cacheShape.sections,
    },
    contextUsagePercent: input.contextUsagePercent,
    cacheAnatomy,
  }

  return {
    providerToolSchemas,
    cacheAnatomy,
    cacheShape,
    cacheStatus,
    estimatedUsageEvent,
  }
}
