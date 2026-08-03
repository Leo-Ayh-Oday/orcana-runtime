/** Contribution deduplication (H10, plan §16.3 step 2).
 *
 *  Two channels: cacheKey equality and overlapping sourceRefs. The survivor
 *  is the contribution in the more stable layer, then lower priority, then
 *  earlier registration order — all three keys are part of the contribution
 *  itself, so the rule is pure and testable.
 */

import type { ContextContribution, ContextTrimInfo } from "../contracts/context"
import { LAYER_ORDER } from "../contracts/context"

function layerStability(layer: ContextContribution["layer"]): number {
  return LAYER_ORDER.indexOf(layer)
}

/** Pick the survivor of two duplicates (null = impossible; inputs are unique by construction). */
function survivor(a: ContextContribution, b: ContextContribution): ContextContribution {
  const byLayer = layerStability(a.layer) - layerStability(b.layer)
  if (byLayer !== 0) return byLayer < 0 ? a : b
  if (a.priority !== b.priority) return a.priority < b.priority ? a : b
  return a // earlier registration order (input order preserved)
}

export interface DedupeResult {
  kept: ContextContribution[]
  dropped: ContextTrimInfo[]
}

/** Dedupe contributions by cacheKey, then by overlapping sourceRefs. */
export function dedupeContributions(contributions: ContextContribution[]): DedupeResult {
  const kept: ContextContribution[] = []
  const dropped: ContextTrimInfo[] = []

  const byCacheKey = new Map<string, ContextContribution>()
  const claimedRefs = new Map<string, ContextContribution>()

  for (const contribution of contributions) {
    // Channel 1: cacheKey equality.
    if (contribution.cacheKey) {
      const existing = byCacheKey.get(contribution.cacheKey)
      if (existing) {
        const winner = survivor(existing, contribution)
        if (winner === contribution) {
          // Replace the earlier one.
          const index = kept.indexOf(existing)
          kept[index] = contribution
          byCacheKey.set(contribution.cacheKey, contribution)
          releaseRefs(claimedRefs, existing)
          claimRefs(claimedRefs, contribution)
          dropped.push({ providerId: existing.providerId, reason: "duplicate", detail: `same cacheKey ${contribution.cacheKey}` })
        } else {
          dropped.push({ providerId: contribution.providerId, reason: "duplicate", detail: `same cacheKey ${contribution.cacheKey}` })
        }
        continue
      }
      byCacheKey.set(contribution.cacheKey, contribution)
    }

    // Channel 2: overlapping sourceRefs.
    const overlap = contribution.sourceRefs.find((ref) => claimedRefs.has(ref))
    if (overlap) {
      const existing = claimedRefs.get(overlap)!
      const winner = survivor(existing, contribution)
      if (winner === contribution) {
        const index = kept.indexOf(existing)
        kept[index] = contribution
        byCacheKey.delete(existing.cacheKey ?? "")
        releaseRefs(claimedRefs, existing)
        claimRefs(claimedRefs, contribution)
        dropped.push({ providerId: existing.providerId, reason: "duplicate", detail: `sourceRef ${overlap}` })
      } else {
        dropped.push({ providerId: contribution.providerId, reason: "duplicate", detail: `sourceRef ${overlap}` })
      }
      continue
    }

    claimRefs(claimedRefs, contribution)
    kept.push(contribution)
  }

  return { kept, dropped }
}

function claimRefs(claimedRefs: Map<string, ContextContribution>, contribution: ContextContribution): void {
  for (const ref of contribution.sourceRefs) {
    if (!claimedRefs.has(ref)) claimedRefs.set(ref, contribution)
  }
}

function releaseRefs(claimedRefs: Map<string, ContextContribution>, contribution: ContextContribution): void {
  for (const ref of contribution.sourceRefs) {
    if (claimedRefs.get(ref) === contribution) claimedRefs.delete(ref)
  }
}
