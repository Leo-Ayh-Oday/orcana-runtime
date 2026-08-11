/**
 * Evidence Confidence Decay System
 * 
 * Implements: evidence_confidence = base_confidence * freshness * scope_coverage * invalidation_factor
 * freshness = 2^(-Δt / halflife)
 * 
 * Part of RFC #7 — Evidence Confidence Decay
 */

// ─── Types ───────────────────────────────────────────────

export type EvidenceKind = "typecheck" | "test" | "build" | "lint" | "smoke" | "manual" | "unknown";

export interface EvidenceConfidence {
  /** The kind of evidence this confidence applies to */
  kind: EvidenceKind;
  /** When the evidence was collected (epoch ms) */
  collectedAt: number;
  /** Base confidence for this evidence kind (0.0 - 1.0) */
  baseConfidence: number;
  /** Current freshness factor (0.0 - 1.0) */
  freshness: number;
  /** How much of the affected scope this evidence covers (0.0 - 1.0) */
  scopeCoverage: number;
  /** Whether structural changes have invalidated this evidence (1.0 = valid, <1.0 = partially invalid) */
  invalidationFactor: number;
  /** The final computed confidence (0.0 - 1.0) */
  confidence: number;
  /** Whether this evidence is still considered valid */
  isValid: boolean;
}

export interface ConfidenceConfig {
  /** Minimum confidence threshold for evidence to be considered valid (default: 0.5) */
  minConfidence: number;
  /** Halflife for each evidence kind in milliseconds */
  halflifeMs: Record<EvidenceKind, number>;
  /** Base confidence for each evidence kind */
  baseConfidence: Record<EvidenceKind, number>;
}

// ─── Default Configuration ───────────────────────────────

export const DEFAULT_CONFIDENCE_CONFIG: ConfidenceConfig = {
  minConfidence: 0.5,
  halflifeMs: {
    typecheck: 30 * 60 * 1000,    // 30 minutes
    test: 60 * 60 * 1000,         // 1 hour
    build: 60 * 60 * 1000,        // 1 hour
    lint: 15 * 60 * 1000,         // 15 minutes
    smoke: 10 * 60 * 1000,        // 10 minutes
    manual: 24 * 60 * 60 * 1000,  // 24 hours
    unknown: 5 * 60 * 1000,       // 5 minutes
  },
  baseConfidence: {
    typecheck: 0.95,
    test: 0.90,
    build: 0.85,
    lint: 0.70,
    smoke: 0.60,
    manual: 1.0,
    unknown: 0.30,
  },
};

// ─── Core Functions ──────────────────────────────────────

/**
 * Calculate freshness based on time elapsed since evidence collection.
 * 
 * freshness = 2^(-Δt / halflife)
 * 
 * - Returns 1.0 at t=0 (just collected)
 * - Returns 0.5 at t=halflife
 * - Returns ~0.0 after several halflives
 */
export function calcFreshness(collectedAt: number, halflifeMs: number, now?: number): number {
  const currentTime = now ?? Date.now();
  const ageMs = Math.max(0, currentTime - collectedAt);
  
  if (halflifeMs <= 0) return 0;
  if (ageMs === 0) return 1.0;
  
  return Math.pow(2, -ageMs / halflifeMs);
}

/**
 * Calculate structural invalidation factor based on file changes.
 * 
 * @param filesInEvidenceScope - Files that were covered by this evidence
 * @param changedFiles - Files that have been modified since evidence collection
 * @returns 1.0 if no files changed, decreasing as more evidence-covered files change
 */
export function calcInvalidationFactor(
  filesInEvidenceScope: string[],
  changedFiles: string[],
): number {
  if (filesInEvidenceScope.length === 0) return 1.0;
  if (changedFiles.length === 0) return 1.0;
  
  const changedScopeFiles = filesInEvidenceScope.filter(f => changedFiles.includes(f));
  const ratio = changedScopeFiles.length / filesInEvidenceScope.length;
  
  // Exponential decay: more files changed = faster confidence loss
  return Math.max(0, 1 - Math.pow(ratio, 0.5));
}

/**
 * Calculate scope coverage — how much of the affected codebase this evidence covers.
 * 
 * @param filesInEvidenceScope - Files covered by this evidence
 * @param totalAffectedFiles - Total files in the affected scope
 * @returns Ratio of covered files to total affected files
 */
export function calcScopeCoverage(
  filesInEvidenceScope: string[],
  totalAffectedFiles: string[],
): number {
  if (totalAffectedFiles.length === 0) return 1.0;
  if (filesInEvidenceScope.length === 0) return 0;
  
  const covered = filesInEvidenceScope.filter(f => totalAffectedFiles.includes(f));
  return Math.min(1.0, covered.length / totalAffectedFiles.length);
}

/**
 * Compute the full evidence confidence for a single piece of evidence.
 * 
 * evidence_confidence = base_confidence * freshness * scope_coverage * invalidation_factor
 */
export function computeConfidence(params: {
  kind: EvidenceKind;
  collectedAt: number;
  filesInEvidenceScope?: string[];
  changedFiles?: string[];
  totalAffectedFiles?: string[];
  config?: ConfidenceConfig;
  now?: number;
}): EvidenceConfidence {
  const config = params.config ?? DEFAULT_CONFIDENCE_CONFIG;
  const baseConfidence = config.baseConfidence[params.kind] ?? 0.5;
  const halflifeMs = config.halflifeMs[params.kind] ?? 5 * 60 * 1000;
  
  const freshness = calcFreshness(params.collectedAt, halflifeMs, params.now);
  const scopeCoverage = calcScopeCoverage(
    params.filesInEvidenceScope ?? [],
    params.totalAffectedFiles ?? [],
  );
  const invalidationFactor = calcInvalidationFactor(
    params.filesInEvidenceScope ?? [],
    params.changedFiles ?? [],
  );
  
  const confidence = baseConfidence * freshness * scopeCoverage * invalidationFactor;
  const isValid = confidence >= config.minConfidence;
  
  return {
    kind: params.kind,
    collectedAt: params.collectedAt,
    baseConfidence,
    freshness,
    scopeCoverage,
    invalidationFactor,
    confidence,
    isValid,
  };
}

/**
 * Check if any evidence has decayed below the minimum confidence threshold.
 * This is the main entry point for CompletionGate.
 * 
 * @returns Array of evidence that is no longer valid
 */
export function findDecayedEvidence(
  evidenceList: EvidenceConfidence[],
  minConfidence?: number,
): EvidenceConfidence[] {
  const threshold = minConfidence ?? DEFAULT_CONFIDENCE_CONFIG.minConfidence;
  return evidenceList.filter(e => e.confidence < threshold);
}

/**
 * Get a human-readable summary of evidence confidence state.
 */
export function summarizeConfidence(evidenceList: EvidenceConfidence[]): string {
  if (evidenceList.length === 0) return "No evidence collected";
  
  const valid = evidenceList.filter(e => e.isValid);
  const decayed = evidenceList.filter(e => !e.isValid);
  
  return [
    `${valid.length}/${evidenceList.length} evidence valid`,
    decayed.length > 0 ? `⚠️ ${decayed.length} decayed: ${decayed.map(e => e.kind).join(", ")}` : "",
  ].filter(Boolean).join(" | ");
}