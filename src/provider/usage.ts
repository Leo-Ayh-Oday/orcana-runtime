import type { ProviderTokenUsage } from "./types"

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null
}

function numberField(record: Record<string, unknown>, names: string[]): number | undefined {
  for (const name of names) {
    const value = record[name]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

function firstUsageRecord(event: unknown): Record<string, unknown> | null {
  const root = asRecord(event)
  if (!root) return null

  const direct = asRecord(root.usage)
  if (direct) return direct

  const message = asRecord(root.message)
  const messageUsage = asRecord(message?.usage)
  if (messageUsage) return messageUsage

  const delta = asRecord(root.delta)
  const deltaUsage = asRecord(delta?.usage)
  if (deltaUsage) return deltaUsage

  return null
}

export function cacheHitRateFromUsage(usage: ProviderTokenUsage): number | undefined {
  const hit = usage.cacheReadInputTokens
  const miss = usage.cacheMissInputTokens
  if (typeof hit !== "number" || typeof miss !== "number") return undefined
  const total = hit + miss
  if (total <= 0) return undefined
  return Math.round((hit / total) * 100)
}

export function enrichProviderTokenUsage(usage: ProviderTokenUsage): ProviderTokenUsage {
  const enriched: ProviderTokenUsage = { ...usage }
  enriched.cacheHitRate = cacheHitRateFromUsage(enriched)

  const hit = enriched.cacheReadInputTokens ?? 0
  const miss = enriched.cacheMissInputTokens ?? 0
  const output = enriched.outputTokens ?? 0
  const total = hit + miss + output
  if (total > 0) {
    enriched.outputShare = Math.round((output / total) * 1000) / 10
    enriched.missShare = Math.round((miss / total) * 1000) / 10
    enriched.claudeStyleCacheShape = (
      (enriched.cacheHitRate ?? 0) >= 99 &&
      enriched.missShare <= 1 &&
      enriched.outputShare <= 1
    )
  }
  return enriched
}

export function extractProviderTokenUsage(event: unknown): ProviderTokenUsage | null {
  const usage = firstUsageRecord(event)
  if (!usage) return null

  const inputTokens = numberField(usage, ["input_tokens", "prompt_tokens", "inputTokens", "promptTokens"])
  const outputTokens = numberField(usage, ["output_tokens", "completion_tokens", "outputTokens", "completionTokens"])
  const promptTokenDetails = asRecord(usage.prompt_tokens_details) ?? asRecord(usage.promptTokensDetails)
  const cacheReadInputTokens = numberField(usage, [
    "cache_read_input_tokens",
    "cache_hit_tokens",
    "prompt_cache_hit_tokens",
    "cacheHitTokens",
    "cache_read_tokens",
  ]) ?? (promptTokenDetails ? numberField(promptTokenDetails, ["cached_tokens", "cachedTokens"]) : undefined)
  const cacheCreationInputTokens = numberField(usage, [
    "cache_creation_input_tokens",
    "prompt_cache_creation_tokens",
    "cacheCreationInputTokens",
    "cache_creation_tokens",
  ])
  const explicitMiss = numberField(usage, [
    "cache_miss_input_tokens",
    "cache_missed_input_tokens",
    "cache_miss_tokens",
    "prompt_cache_miss_tokens",
    "cacheMissTokens",
  ])

  const hasCacheSignal = typeof cacheReadInputTokens === "number" || typeof cacheCreationInputTokens === "number" || typeof explicitMiss === "number"
  const cacheMissInputTokens = typeof explicitMiss === "number"
    ? explicitMiss
    : typeof cacheReadInputTokens === "number" && typeof inputTokens === "number"
    ? Math.max(0, inputTokens - cacheReadInputTokens)
    : hasCacheSignal
    ? inputTokens
    : undefined

  const normalized: ProviderTokenUsage = {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    cacheMissInputTokens,
    source: "provider",
  }
  const enriched = enrichProviderTokenUsage(normalized)

  if (
    typeof enriched.inputTokens !== "number" &&
    typeof enriched.outputTokens !== "number" &&
    typeof enriched.cacheReadInputTokens !== "number" &&
    typeof enriched.cacheMissInputTokens !== "number"
  ) {
    return null
  }

  return enriched
}

export function mergeProviderTokenUsage(previous: ProviderTokenUsage | null, next: ProviderTokenUsage): ProviderTokenUsage {
  const merged: ProviderTokenUsage = { ...(previous ?? {}), ...next, source: next.source ?? previous?.source ?? "provider" }
  return enrichProviderTokenUsage(merged)
}
