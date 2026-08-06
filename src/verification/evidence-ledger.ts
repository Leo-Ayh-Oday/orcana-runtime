/**
 * EvidenceLedger — Structured evidence storage with confidence tracking.
 *
 * Phase 1: Basic evidence recording, confidence computation, decay detection.
 * Part of RFC #7 — Evidence Confidence Decay.
 */

import {
  computeConfidence,
  DEFAULT_CONFIDENCE_CONFIG,
  findDecayedEvidence,
  summarizeConfidence,
} from "./confidence"
import type { ConfidenceConfig, EvidenceConfidence, EvidenceKind } from "./confidence"
import type { VerificationResult } from "./result"

export interface LedgerEntry {
  /** Unique identifier for this evidence entry */
  id: string
  /** The verification result this evidence is based on */
  result: VerificationResult
  /** Computed confidence for this evidence */
  confidence: EvidenceConfidence
  /** Files that were covered by this evidence */
  coveredFiles: string[]
  /** When this entry was created (epoch ms) */
  createdAt: number
}

export interface LedgerSummary {
  /** Total number of evidence entries */
  totalEntries: number
  /** Number of entries that are still valid */
  validEntries: number
  /** Number of entries that have decayed below threshold */
  decayedEntries: number
  /** Overall confidence level (0.0 - 1.0) — average of all valid entries */
  overallConfidence: number
  /** Whether the ledger passes the minimum confidence threshold */
  isHealthy: boolean
  /** Human-readable summary */
  summary: string
}

export class EvidenceLedger {
  private entries: LedgerEntry[] = []
  private config: ConfidenceConfig
  private changedFiles: Set<string> = new Set()
  private entryCounter = 0

  constructor(config?: Partial<ConfidenceConfig>) {
    this.config = { ...DEFAULT_CONFIDENCE_CONFIG, ...config }
  }

  /**
   * Record a new verification result as evidence in the ledger.
   */
  recordEvidence(
    result: VerificationResult,
    coveredFiles: string[] = [],
    totalAffectedFiles: string[] = [],
  ): LedgerEntry {
    const id = `evidence-${++this.entryCounter}-${result.kind}`

    const confidence = computeConfidence({
      kind: result.kind as EvidenceKind,
      collectedAt: Date.now(),
      filesInEvidenceScope: coveredFiles,
      changedFiles: [...this.changedFiles],
      totalAffectedFiles,
      config: this.config,
    })

    const entry: LedgerEntry = {
      id,
      result,
      confidence,
      coveredFiles,
      createdAt: Date.now(),
    }

    this.entries.push(entry)
    return entry
  }

  /**
   * Mark files as changed — this will affect confidence of existing evidence.
   */
  markFilesChanged(files: string[]): void {
    for (const file of files) {
      this.changedFiles.add(file)
    }
    // Recompute confidence for all existing entries
    this.recomputeAllConfidence()
  }

  /**
   * Get all entries in the ledger.
   */
  getAllEntries(): LedgerEntry[] {
    return [...this.entries]
  }

  /**
   * Get only entries that are still valid (above confidence threshold).
   */
  getValidEntries(): LedgerEntry[] {
    return this.entries.filter(e => e.confidence.isValid)
  }

  /**
   * Get entries that have decayed below the confidence threshold.
   */
  getDecayedEntries(): LedgerEntry[] {
    return this.entries.filter(e => !e.confidence.isValid)
  }

  /**
   * Get a summary of the ledger state for CompletionGate.
   */
  getSummary(): LedgerSummary {
    const valid = this.getValidEntries()
    const decayed = this.getDecayedEntries()
    const overallConfidence =
      valid.length > 0
        ? valid.reduce((sum, e) => sum + e.confidence.confidence, 0) / valid.length
        : 0
    const isHealthy = decayed.length === 0 || overallConfidence >= this.config.minConfidence

    return {
      totalEntries: this.entries.length,
      validEntries: valid.length,
      decayedEntries: decayed.length,
      overallConfidence,
      isHealthy,
      summary: summarizeConfidence(this.entries.map(e => e.confidence)),
    }
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.entries = []
    this.changedFiles.clear()
  }

  /**
   * Recompute confidence for all entries based on current state.
   */
  private recomputeAllConfidence(): void {
    const changedFilesArray = [...this.changedFiles]
    for (const entry of this.entries) {
      const confidence = computeConfidence({
        kind: entry.result.kind as EvidenceKind,
        collectedAt: entry.createdAt,
        filesInEvidenceScope: entry.coveredFiles,
        changedFiles: changedFilesArray,
        totalAffectedFiles: entry.coveredFiles, // Use covered files as scope if not specified
        config: this.config,
      })
      entry.confidence = confidence
    }
  }

  /**
   * Recalculate confidence for all entries at the current time.
   * This should be called periodically or before CompletionGate checks.
   */
  refreshConfidence(): void {
    this.recomputeAllConfidence()
  }
}