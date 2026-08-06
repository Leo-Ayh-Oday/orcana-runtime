/** Context budget allocation (H10, plan §16.5) — RC-18 K32/K33/K53.
 *
 *  Pure function over contributions:
 *    - Stable: fixed cap, non-required trimmed by descending priority
 *      (skills → context-map → kernel → stable-memory; stable-memory and
 *      plan-state/planning are required and never trimmed by default).
 *    - Plan: required parts never trimmed; non-required plan parts are only
 *      trimmed after volatile is exhausted.
 *    - Volatile: trimmed first, by descending priority (tail → mode →
 *      planning → knowledge → …).
 *    - maxTotalTokens backstop; if required still overruns, keep every
 *      required contribution and report budget_overrun_required.
 *
 *  RC-18 extensions (all opt-in via BudgetAllocatorOptions, so the default
 *  call is byte-for-byte the pre-RC-18 behavior):
 *    - K53: `protectedProviderIds` (coverage-gate carriers) are never cut;
 *      blocked attempts are recorded in `protectedHits`.
 *    - K32: `revalidateRequired` downgrades system-required contributions
 *      that overrun a cap to optional (REVALIDATE), then cuts them per the
 *      normal rules, marking the record `revalidated`. Protected
 *      contributions are exempt (user hard constraints never downgraded).
 *    - K33: `semanticTrim` tries to compress an over-budget contribution
 *      before dropping it whole; the compressed copy is kept and recorded in
 *      `compressed` with mode "semantic", while wholesale cuts are recorded
 *      with mode "wholesale".
 *
 *  When the policy is disabled every contribution survives (byte-frozen path).
 */

import type { ContextBudgetPolicy, ContextContribution, ContextTrimInfo } from "../contracts/context"
import { LAYER_ORDER } from "../contracts/context"

export interface TrimRecord extends ContextTrimInfo {
  /** K33: how the contribution was cut. */
  mode?: "semantic" | "wholesale"
  /** K32: system-required contribution downgraded via REVALIDATE. */
  revalidated?: boolean
  /** K33: token estimate after compression (mode === "semantic"). */
  compressedTokens?: number
}

export interface AllocationResult {
  kept: ContextContribution[]
  trimmed: TrimRecord[]
  /** K33: contributions kept in compressed form instead of dropped. */
  compressed: TrimRecord[]
  allocatedTokens: Partial<Record<ContextContribution["layer"], number>>
  totalTokens: number
  trimmedTokens: number
  warnings: string[]
  /** K53: trim attempts blocked by the coverage gate (providerIds). */
  protectedHits: string[]
}

export interface BudgetAllocatorOptions {
  /** K53: providerIds that must never be trimmed (coverage-gate protected). */
  protectedProviderIds?: ReadonlySet<string>
  /** K32: downgrade system-required contributions that overrun a cap to
   *  optional (REVALIDATE) instead of keeping them unconditionally.
   *  Protected contributions are exempt. Default false (legacy semantics). */
  revalidateRequired?: boolean
  /** K33: try to compress content before dropping. Return the compressed
   *  content (shorter, non-empty) or null to drop whole. */
  semanticTrim?: (content: string, providerId: string) => string | null
}

const EMPTY_PROTECTED: ReadonlySet<string> = new Set()

const layerOf = (contribution: ContextContribution) => contribution.layer

function estimatedTokens(contribution: ContextContribution): number {
  return contribution.estimatedTokens > 0 ? contribution.estimatedTokens : Math.ceil(contribution.content.length / 3)
}

/** K33: built-in semantic compressor — drop regenerable blank lines first,
 *  then keep head (50%) + tail (25%) of long blocks with an explicit
 *  compression marker. Returns null when no real reduction is possible
 *  (caller drops whole). */
export function semanticTrimContent(content: string): string | null {
  const lines = content.split("\n")
  const compact = lines.filter((line) => line.trim() !== "").join("\n")
  if (compact.length === 0) return null
  if (compact.length < content.length * 0.8) return compact
  const keep = Math.max(1, Math.floor(lines.length * 0.5))
  const tailCount = Math.max(1, Math.floor(lines.length * 0.25))
  const result = [
    ...lines.slice(0, keep),
    `…[context-compressed: ${lines.length} lines → ${keep + tailCount} retained]…`,
    ...lines.slice(-tailCount),
  ].join("\n")
  return result.length < content.length ? result : null
}

export function allocateContextBudget(
  contributions: ContextContribution[],
  policy: ContextBudgetPolicy,
  opts: BudgetAllocatorOptions = {},
): AllocationResult {
  const warnings: string[] = []
  const protectedProviderIds = opts.protectedProviderIds ?? EMPTY_PROTECTED
  const revalidateRequired = opts.revalidateRequired === true
  const semanticTrim = opts.semanticTrim

  if (!policy.enabled) {
    const totalTokens = contributions.reduce((sum, c) => sum + estimatedTokens(c), 0)
    return {
      kept: contributions,
      trimmed: [],
      compressed: [],
      allocatedTokens: { stable: 0, plan: 0, node: 0, volatile: 0 },
      totalTokens,
      trimmedTokens: 0,
      warnings,
      protectedHits: [],
    }
  }

  const trimmed: TrimRecord[] = []
  const compressed: TrimRecord[] = []
  const protectedHits: string[] = []
  const allocatedTokens: Partial<Record<ContextContribution["layer"], number>> = {
    stable: 0, plan: 0, node: 0, volatile: 0,
  }

  // ── Per-layer caps ──
  const keptByLayer = new Map<ContextContribution["layer"], ContextContribution[]>()
  for (const layer of LAYER_ORDER) keptByLayer.set(layer, [])

  /** K32/K33 cut decision for one over-budget contribution: try semantic
   *  compression first (K33), fall back to whole-block removal; marks the
   *  record with revalidated (K32) and mode. Returns the compressed copy to
   *  keep, or null when the contribution must be dropped whole. */
  const cut = (contribution: ContextContribution, detail: string): ContextContribution | null => {
    const base = {
      providerId: contribution.providerId,
      reason: "budget" as const,
      detail,
      revalidated: contribution.required && revalidateRequired,
    }
    if (semanticTrim) {
      const candidate = semanticTrim(contribution.content, contribution.providerId)
      if (candidate !== null && candidate.trim() !== "" && candidate.length < contribution.content.length) {
        const compressedTokens = Math.max(1, Math.ceil(candidate.length / 3))
        compressed.push({
          ...base,
          mode: "semantic",
          detail: `${detail}: compressed ${estimatedTokens(contribution)}→${compressedTokens}`,
          compressedTokens,
        })
        return { ...contribution, content: candidate, estimatedTokens: compressedTokens }
      }
    }
    trimmed.push({ ...base, mode: "wholesale" })
    return null
  }

  for (const contribution of contributions) {
    const layer = layerOf(contribution)
    const cap = policy.maxTokensByLayer?.[layer]
    const tokens = estimatedTokens(contribution)
    const protectedById = protectedProviderIds.has(contribution.providerId)

    if (cap !== undefined && (allocatedTokens[layer] ?? 0) + tokens > cap) {
      if (protectedById) {
        // K53: coverage-gate protection — never cut, record the intercept.
        protectedHits.push(contribution.providerId)
      } else if (!(contribution.required && !revalidateRequired)) {
        // Not required, or system-required with REVALIDATE (K32): compress-or-drop.
        const keptCompressed = cut(contribution, `${layer} layer cap`)
        if (keptCompressed) {
          keptByLayer.get(layer)!.push(keptCompressed)
          allocatedTokens[layer] = (allocatedTokens[layer] ?? 0) + estimatedTokens(keptCompressed)
        }
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
      const protectedById = protectedProviderIds.has(contribution.providerId)
      if (protectedById) {
        protectedHits.push(contribution.providerId)
        continue
      }
      if (contribution.required && !revalidateRequired) continue
      const keptCompressed = cut(contribution, "total cap")
      if (keptCompressed) {
        const index = kept.indexOf(contribution)
        if (index >= 0) kept[index] = keptCompressed
        totalTokens = kept.reduce((sum, c) => sum + estimatedTokens(c), 0)
      } else {
        kept = kept.filter((c) => c !== contribution)
        totalTokens -= estimatedTokens(contribution)
      }
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
    compressed,
    allocatedTokens,
    totalTokens,
    trimmedTokens: Math.max(0, trimmedTokens),
    warnings,
    protectedHits,
  }
}
