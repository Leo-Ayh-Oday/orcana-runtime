/** [RFC #7 v2] Evidence Confidence Decay — pure computation layer.
 *
 *  evidence_confidence = base_confidence(kind) × freshness × scope_coverage × invalidation_factor
 *  freshness           = 2^(−Δt / halflife(kind))
 *
 *  v2 redesign per review of PR #8:
 *   - No parallel `EvidenceKind`: the canonical type from `./evidence-ledger`
 *     is reused, so `toEvidenceKind()` stays the single mapping authority and
 *     no `as` casts are needed anywhere.
 *   - This module owns ONLY the math. Ledger state, ingestion and the
 *     completion-gate threshold live in `./evidence-ledger`.
 *   - `calcScopeCoverage` takes genuinely distinct inputs: the files the
 *     evidence covered vs. the task's total affected scope (v1 passed the same
 *     array to both, so the factor was always 1.0).
 *   - `calcInvalidationFactor` distinguishes DIRECT changes (files the
 *     evidence itself verified) from INDIRECT drift (changed files in the
 *     surrounding scope it did not cover), so e.g. a test covering 10 source
 *     files with 5 of them changed is degraded, not voided (v1: 29%).
 */

import type { EvidenceKind } from "./evidence-ledger"

// ── Types ──

/** Confidence breakdown for one evidence entry. */
export interface EvidenceConfidence {
  /** The canonical evidence kind this confidence applies to. */
  kind: EvidenceKind
  /** When the evidence was collected (epoch ms). */
  collectedAt: number
  /** Base confidence for this evidence kind (0.0 - 1.0). */
  baseConfidence: number
  /** Time decay factor 2^(−Δt/halflife) (0.0 - 1.0). */
  freshness: number
  /** Share of the task's affected scope this evidence covers (0.0 - 1.0; 1.0 when scope is unknown). */
  scopeCoverage: number
  /** Structural invalidation factor (1.0 = nothing it verified changed). */
  invalidationFactor: number
  /** The final computed confidence (0.0 - 1.0). */
  confidence: number
  /** Whether this evidence is still above the configured threshold. */
  isValid: boolean
}

/** Configuration of the decay model. */
export interface EvidenceDecayConfig {
  /** Minimum confidence for evidence to count toward the completion gate (default: 0.5). */
  minConfidence: number
  /** Half-life per evidence kind, in milliseconds. */
  halflifeMs: Record<EvidenceKind, number>
  /** Base confidence per evidence kind. */
  baseConfidence: Record<EvidenceKind, number>
}

export const DEFAULT_EVIDENCE_DECAY_CONFIG: EvidenceDecayConfig = {
  minConfidence: 0.5,
  halflifeMs: {
    typecheck: 30 * 60 * 1000,        // 30 minutes
    test: 60 * 60 * 1000,             // 1 hour
    build: 60 * 60 * 1000,            // 1 hour
    manual: 24 * 60 * 60 * 1000,      // 24 hours
    sandbox_execution: 30 * 60 * 1000,   // 30 minutes
    sandbox_cleanup: 15 * 60 * 1000,     // 15 minutes
  },
  baseConfidence: {
    typecheck: 0.95,
    test: 0.90,
    build: 0.85,
    manual: 1.0,
    sandbox_execution: 0.90,
    sandbox_cleanup: 0.95,
  },
}

/** How hard direct and indirect changes each penalize confidence.
 *
 *  factor = exp(−λ_direct · directRatio) · exp(−λ_indirect · indirectRatio)
 *
 *  With the defaults: changing 5 of the 10 files a test covered leaves ≈0.61
 *  of its confidence (0.9 × 0.61 ≈ 0.55 — still above the 0.5 threshold);
 *  changing all 10 leaves ≈0.37 (0.9 × 0.37 ≈ 0.33 — below it, re-verify). */
export interface InvalidationWeights {
  directLambda: number
  indirectLambda: number
}

export const DEFAULT_INVALIDATION_WEIGHTS: InvalidationWeights = {
  directLambda: 1.0,
  indirectLambda: 0.4,
}

// ── Core factors (pure) ──

/** freshness = 2^(−Δt / halflife): 1.0 at collection, 0.5 after one half-life. */
export function calcFreshness(collectedAt: number, halflifeMs: number, now?: number): number {
  const currentTime = now ?? Date.now()
  const ageMs = Math.max(0, currentTime - collectedAt)
  if (halflifeMs <= 0) return 0
  if (ageMs === 0) return 1.0
  return Math.pow(2, -ageMs / halflifeMs)
}

/**
 * Share of the task's affected scope that this evidence actually covered.
 *
 * NOTE (v1 bug fix): `coveredFiles` and `totalAffectedFiles` are distinct
 * inputs. When either side is unknown (empty) the factor is neutral 1.0 —
 * absence of coverage information must not silently void evidence.
 */
export function calcScopeCoverage(coveredFiles: string[], totalAffectedFiles: string[]): number {
  if (totalAffectedFiles.length === 0) return 1.0
  if (coveredFiles.length === 0) return 1.0
  const scope = new Set(totalAffectedFiles)
  const covered = coveredFiles.filter(f => scope.has(f))
  return Math.min(1.0, covered.length / totalAffectedFiles.length)
}

/**
 * Structural invalidation from files changed since the evidence was collected.
 *
 * DIRECT: changed files the evidence itself covered — strong penalty.
 * INDIRECT: changed files in the task scope it did NOT cover — mild penalty
 * (surrounding drift, not a direct contradiction of what was verified).
 *
 * NOTE (v1 fix): v1 used `1 − √ratio`, which dropped a test covering 10 files
 * with 5 changed to 29% — effectively voiding it. The split model above keeps
 * such evidence alive (≈0.61) while still voiding fully-contradicted evidence.
 */
export function calcInvalidationFactor(
  coveredFiles: string[],
  changedFiles: string[],
  totalAffectedFiles?: string[],
  weights: InvalidationWeights = DEFAULT_INVALIDATION_WEIGHTS,
): number {
  if (coveredFiles.length === 0) return 1.0
  if (changedFiles.length === 0) return 1.0

  const covered = new Set(coveredFiles)
  const direct = changedFiles.filter(f => covered.has(f))
  const indirect = changedFiles.filter(f => !covered.has(f))

  const directRatio = direct.length / coveredFiles.length
  // Indirect drift is measured against the largest known scope it could affect.
  const indirectDenominator = Math.max(
    totalAffectedFiles !== undefined ? totalAffectedFiles.length : 0,
    indirect.length,
  )
  const indirectRatio = indirectDenominator > 0 ? indirect.length / indirectDenominator : 0

  return Math.max(0, Math.exp(-weights.directLambda * directRatio) * Math.exp(-weights.indirectLambda * indirectRatio))
}

/** Compute the full confidence breakdown for one piece of evidence. */
export function computeEvidenceConfidence(params: {
  kind: EvidenceKind
  collectedAt: number
  coveredFiles?: string[]
  changedFiles?: string[]
  totalAffectedFiles?: string[]
  config?: EvidenceDecayConfig
  now?: number
}): EvidenceConfidence {
  const config = params.config ?? DEFAULT_EVIDENCE_DECAY_CONFIG
  const kindConfig = configFor(config, params.kind)

  const freshness = calcFreshness(params.collectedAt, kindConfig.halflifeMs, params.now)
  const scopeCoverage = calcScopeCoverage(
    params.coveredFiles ?? [],
    params.totalAffectedFiles ?? [],
  )
  const invalidationFactor = calcInvalidationFactor(
    params.coveredFiles ?? [],
    params.changedFiles ?? [],
    params.totalAffectedFiles,
  )

  const confidence = kindConfig.baseConfidence * freshness * scopeCoverage * invalidationFactor
  return {
    kind: params.kind,
    collectedAt: params.collectedAt,
    baseConfidence: kindConfig.baseConfidence,
    freshness,
    scopeCoverage,
    invalidationFactor,
    confidence,
    isValid: confidence >= config.minConfidence,
  }
}

/** Entries whose computed confidence fell below the threshold. */
export function findDecayedEvidence(
  evidenceList: EvidenceConfidence[],
  minConfidence?: number,
): EvidenceConfidence[] {
  const threshold = minConfidence ?? DEFAULT_EVIDENCE_DECAY_CONFIG.minConfidence
  return evidenceList.filter(e => e.confidence < threshold)
}

/** Human-readable one-liner for model-facing status. */
export function summarizeConfidence(evidenceList: EvidenceConfidence[]): string {
  if (evidenceList.length === 0) return "No evidence collected"
  const valid = evidenceList.filter(e => e.isValid)
  const decayed = evidenceList.filter(e => !e.isValid)
  return [
    `${valid.length}/${evidenceList.length} evidence valid`,
    decayed.length > 0 ? `⚠️ ${decayed.length} decayed: ${decayed.map(e => e.kind).join(", ")}` : "",
  ].filter(Boolean).join(" | ")
}

// ── Internals ──

function configFor(config: EvidenceDecayConfig, kind: EvidenceKind): {
  halflifeMs: number
  baseConfidence: number
} {
  return {
    halflifeMs: config.halflifeMs[kind] ?? 5 * 60 * 1000,
    baseConfidence: config.baseConfidence[kind] ?? 0.5,
  }
}
