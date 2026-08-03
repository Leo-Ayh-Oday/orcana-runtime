/** Context budget allocation (H10, plan §16.5).
 *
 *  Pure function over contributions:
 *    - Stable: fixed cap, non-required trimmed by descending priority
 *      (skills → context-map → kernel → stable-memory; stable-memory and
 *      plan-state/planning are required and never trimmed).
 *    - Plan: required parts never trimmed; non-required plan parts are only
 *      trimmed after volatile is exhausted.
 *    - Volatile: trimmed first, by descending priority (tail → mode →
 *      planning → knowledge → …).
 *    - maxTotalTokens backstop; if required still overruns, keep every
 *      required contribution and report budget_overrun_required.
 *
 *  When the policy is disabled every contribution survives (byte-frozen path).
 */

import type { ContextBudgetPolicy, ContextContribution, ContextTrimInfo } from "../contracts/context"
import { LAYER_ORDER } from "../contracts/context"

export interface AllocationResult {
  kept: ContextContribution[]
  trimmed: ContextTrimInfo[]
  allocatedTokens: Partial<Record<ContextContribution["layer"], number>>
  totalTokens: number
  trimmedTokens: number
  warnings: string[]
}

const layerOf = (contribution: ContextContribution) => contribution.layer

function estimatedTokens(contribution: ContextContribution): number {
  return contribution.estimatedTokens > 0 ? contribution.estimatedTokens : Math.ceil(contribution.content.length / 3)
}

export function allocateContextBudget(
  contributions: ContextContribution[],
  policy: ContextBudgetPolicy,
): AllocationResult {
  const warnings: string[] = []
  if (!policy.enabled) {
    const totalTokens = contributions.reduce((sum, c) => sum + estimatedTokens(c), 0)
    return {
      kept: contributions,
      trimmed: [],
      allocatedTokens: { stable: 0, plan: 0, node: 0, volatile: 0 },
      totalTokens,
      trimmedTokens: 0,
      warnings,
    }
  }

  const trimmed: ContextTrimInfo[] = []
  const allocatedTokens: Partial<Record<ContextContribution["layer"], number>> = {
    stable: 0, plan: 0, node: 0, volatile: 0,
  }

  // ── Per-layer caps ──
  const keptByLayer = new Map<ContextContribution["layer"], ContextContribution[]>()
  for (const layer of LAYER_ORDER) keptByLayer.set(layer, [])

  for (const contribution of contributions) {
    const layer = layerOf(contribution)
    const cap = policy.maxTokensByLayer?.[layer]
    const tokens = estimatedTokens(contribution)

    if (cap !== undefined && (allocatedTokens[layer] ?? 0) + tokens > cap) {
      if (!contribution.required) {
        trimmed.push({ providerId: contribution.providerId, reason: "budget", detail: `${layer} layer cap` })
        continue
      }
    }
    keptByLayer.get(layer)!.push(contribution)
    allocatedTokens[layer] = (allocatedTokens[layer] ?? 0) + tokens
  }

  // ── Total cap: trim volatile first, then non-required plan ──
  let kept = [...keptByLayer.values()].flat()
  let totalTokens = kept.reduce((sum, c) => sum + estimatedTokens(c), 0)
  if (policy.maxTotalTokens !== undefined && totalTokens > policy.maxTotalTokens) {
    const trimOrder = [...kept].sort((a, b) => {
      const layerRank = LAYER_ORDER.indexOf(b.layer) - LAYER_ORDER.indexOf(a.layer) // volatile first
      if (layerRank !== 0) return layerRank
      return b.priority - a.priority // descending priority within layer
    })
    for (const contribution of trimOrder) {
      if (totalTokens <= policy.maxTotalTokens) break
      if (contribution.required) continue
      kept = kept.filter((c) => c !== contribution)
      totalTokens -= estimatedTokens(contribution)
      trimmed.push({ providerId: contribution.providerId, reason: "budget", detail: "total cap" })
    }
  }

  // ── Required overrun backstop ──
  const requiredTokens = kept.filter((c) => c.required).reduce((sum, c) => sum + estimatedTokens(c), 0)
  if (policy.maxTotalTokens !== undefined && requiredTokens > policy.maxTotalTokens) {
    warnings.push("budget_overrun_required")
  }

  const trimmedTokens = contributions.reduce((sum, c) => sum + estimatedTokens(c), 0) - totalTokens
  return {
    kept,
    trimmed,
    allocatedTokens,
    totalTokens,
    trimmedTokens: Math.max(0, trimmedTokens),
    warnings,
  }
}
