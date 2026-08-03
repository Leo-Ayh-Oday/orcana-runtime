/** Context Pipeline orchestrator (H10, plan §16.3).
 *
 *  Collect → dedupe → freshness → sort by layer → budget allocate → trim →
 *  ContextSlice. Every first-batch provider is a synchronous wrapper, so
 *  collection preserves registration order (Promise.all then restore by
 *  index). Budget is disabled by default: the current loop has no context
 *  trimming, and enabling it changes the model-visible bytes (§3.5) — that
 *  is a separate decision with its own Golden Trace update.
 */

import type {
  ContextContribution,
  ContextPipelineOptions,
  ContextSlice,
  ContextTrimInfo,
} from "../contracts/context"
import { LAYER_ORDER } from "../contracts/context"
import { dedupeContributions } from "./dedupe"
import { allocateContextBudget } from "./budget-allocator"

export async function runContextPipeline(options: ContextPipelineOptions): Promise<ContextSlice> {
  const now = options.now ?? Date.now()
  const maxAge = options.maxContributionAgeMs ?? Number.POSITIVE_INFINITY

  // ── Step 1: collect (registration order preserved) ──
  const collected = await Promise.all(
    options.providers.map((provider) => provider.provide(options.request)),
  )

  // ── Step 2: dedupe ──
  const { kept: deduped, dropped: dedupeDropped } = dedupeContributions(collected)

  // ── Step 3: freshness ──
  const fresh: ContextContribution[] = []
  const dropped: ContextTrimInfo[] = [...dedupeDropped]
  const warnings: string[] = []
  for (const contribution of deduped) {
    if (contribution.freshness !== undefined && now - contribution.freshness > maxAge) {
      if (contribution.required) {
        warnings.push(`required contribution ${contribution.providerId} is stale but kept`)
        fresh.push(contribution)
      } else {
        dropped.push({ providerId: contribution.providerId, reason: "stale" })
      }
      continue
    }
    fresh.push(contribution)
  }

  // ── Step 4: sort by layer, then priority, then providerId ──
  const sorted = [...fresh].sort((a, b) => {
    const byLayer = LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer)
    if (byLayer !== 0) return byLayer
    if (a.priority !== b.priority) return a.priority - b.priority
    return a.providerId.localeCompare(b.providerId)
  })

  // ── Steps 5-6: budget allocation + trim ──
  const budgetPolicy = options.budget ?? { enabled: false }
  const allocation = allocateContextBudget(sorted, budgetPolicy)
  for (const trim of allocation.trimmed) dropped.push(trim)
  for (const warning of allocation.warnings) warnings.push(warning)

  // ── Step 7: ContextSlice ──
  const byProvider = new Map<string, ContextContribution>()
  for (const contribution of allocation.kept) byProvider.set(contribution.providerId, contribution)

  const cachePrefixKeys: string[] = []
  for (const contribution of allocation.kept) {
    if (contribution.layer === "stable" && contribution.cacheKey) cachePrefixKeys.push(contribution.cacheKey)
  }

  return {
    contributions: allocation.kept,
    byProvider,
    dropped,
    budget: allocation,
    cachePrefixKeys,
    warnings,
  }
}
