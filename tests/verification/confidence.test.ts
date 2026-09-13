/** [RFC #7 v2] Evidence confidence decay — unit tests.
 *
 *  Covers the pure computation layer (src/agent/evidence-decay.ts) and its
 *  integration into the existing EvidenceLedger (src/agent/evidence-ledger.ts):
 *  threshold gating in canClaimDone, toEvidenceKind mapping (no casts),
 *  backward compatibility for legacy ledgers, and serialization round-trips.
 */

import { describe, expect, test } from "bun:test"
import {
  calcFreshness,
  calcInvalidationFactor,
  calcScopeCoverage,
  computeEvidenceConfidence,
  DEFAULT_EVIDENCE_DECAY_CONFIG,
  findDecayedEvidence,
} from "../../src/agent/evidence-decay"
import {
  addManualEvidence,
  canClaimDone,
  createEvidenceLedger,
  decayedEvidence,
  deserializeLedger,
  enableEvidenceDecay,
  ingestTypecheck,
  ingestVerificationResult,
  recordFilesChanged,
  serializeLedger,
  toEvidenceKind,
} from "../../src/agent/evidence-ledger"
import type { EvidenceLedger } from "../../src/agent/evidence-ledger"
import type { VerificationResult } from "../../src/verification/result"

const NOW = 1_700_000_000_000
const FILES = (n: number) => Array.from({ length: n }, (_, i) => `src/file${i}.ts`)

function makeResult(kind: VerificationResult["kind"], passed = true): VerificationResult {
  return { kind, command: `${kind} --run`, passed, issues: passed ? 0 : 1, durationMs: 10, summary: "ok" }
}

// ── Pure layer ──

describe("calcFreshness", () => {
  test("1.0 at collection, 0.5 after one half-life, 0.25 after two", () => {
    const halflife = 60 * 60 * 1000
    expect(calcFreshness(NOW, halflife, NOW)).toBe(1.0)
    expect(calcFreshness(NOW, halflife, NOW + halflife)).toBeCloseTo(0.5, 6)
    expect(calcFreshness(NOW, halflife, NOW + 2 * halflife)).toBeCloseTo(0.25, 6)
  })

  test("non-positive half-life decays to 0 (misconfiguration fails closed)", () => {
    expect(calcFreshness(NOW, 0, NOW)).toBe(0)
  })
})

describe("calcScopeCoverage (v1 bug fix: distinct numerator/denominator)", () => {
  test("3 covered of 10 affected files → 0.3", () => {
    expect(calcScopeCoverage(FILES(3), FILES(10))).toBeCloseTo(0.3, 6)
  })

  test("unknown scope is neutral 1.0, not a false zero", () => {
    expect(calcScopeCoverage(FILES(3), [])).toBe(1.0)
  })

  test("unknown coverage is neutral 1.0 (legacy entries must not be voided)", () => {
    expect(calcScopeCoverage([], FILES(10))).toBe(1.0)
  })

  test("covered files outside the scope do not count", () => {
    expect(calcScopeCoverage(["other/x.ts", "src/file0.ts"], FILES(10))).toBeCloseTo(0.1, 6)
  })
})

describe("calcInvalidationFactor (v1 fix: direct vs indirect, no more √ cliff)", () => {
  test("no changes → 1.0", () => {
    expect(calcInvalidationFactor(FILES(10), [], FILES(10))).toBe(1.0)
  })

  test("review example: test covers 10 files, 5 changed → degraded, not voided (≥0.5)", () => {
    const covered = FILES(10)
    const changed = FILES(5)
    const factor = calcInvalidationFactor(covered, changed, covered)
    expect(factor).toBeGreaterThanOrEqual(0.5)
    expect(factor).toBeLessThanOrEqual(0.7) // v1 gave 0.29 here
  })

  test("all covered files changed → below 0.4 (re-verify)", () => {
    const covered = FILES(10)
    expect(calcInvalidationFactor(covered, covered, covered)).toBeLessThan(0.4)
  })

  test("indirect-only drift is a mild penalty", () => {
    const covered = FILES(5)
    const indirect = Array.from({ length: 2 }, (_, i) => `src/other${i}.ts`)
    expect(calcInvalidationFactor(covered, indirect, FILES(10))).toBeGreaterThanOrEqual(0.9)
  })

  test("unknown coverage is neutral 1.0", () => {
    expect(calcInvalidationFactor([], FILES(5), FILES(10))).toBe(1.0)
  })
})

describe("computeEvidenceConfidence", () => {
  test("fresh, full-coverage test evidence stays high", () => {
    const c = computeEvidenceConfidence({
      kind: "test", collectedAt: NOW, coveredFiles: FILES(10), totalAffectedFiles: FILES(10), now: NOW,
    })
    expect(c.confidence).toBeCloseTo(0.9, 6)
    expect(c.isValid).toBe(true)
  })

  test("stale evidence decays below the default threshold after one half-life", () => {
    const halflife = DEFAULT_EVIDENCE_DECAY_CONFIG.halflifeMs.test
    const c = computeEvidenceConfidence({
      kind: "test", collectedAt: NOW, coveredFiles: FILES(10), totalAffectedFiles: FILES(10), now: NOW + halflife,
    })
    expect(c.confidence).toBeLessThan(DEFAULT_EVIDENCE_DECAY_CONFIG.minConfidence)
    expect(c.isValid).toBe(false)
  })

  test("findDecayedEvidence filters by threshold", () => {
    const good = computeEvidenceConfidence({ kind: "build", collectedAt: NOW, now: NOW })
    const bad = computeEvidenceConfidence({
      kind: "test", collectedAt: NOW, now: NOW + 3 * DEFAULT_EVIDENCE_DECAY_CONFIG.halflifeMs.test,
    })
    expect(findDecayedEvidence([good, bad])).toEqual([bad])
  })
})

// ── Integration into the existing EvidenceLedger ──

describe("ledger integration", () => {
  test("toEvidenceKind mapping is used — no as-casts, no parallel EvidenceKind", () => {
    expect(toEvidenceKind("lint")).toBe("typecheck")
    expect(toEvidenceKind("smoke")).toBe("test")
    expect(toEvidenceKind("unknown")).toBeNull()

    const ledger = createEvidenceLedger()
    expect(ingestVerificationResult(ledger, makeResult("unknown"))).toBeNull()
    expect(ledger.entries).toHaveLength(0)
  })

  test("confidence is stamped on ingest while decay tracking is active", () => {
    const ledger = createEvidenceLedger()
    enableEvidenceDecay(ledger, { totalAffectedFiles: FILES(10) })
    const entry = ingestVerificationResult(ledger, makeResult("test"), undefined, undefined, FILES(10))
    expect(entry?.confidence).toBeDefined()
    expect(entry?.confidence?.confidence).toBeCloseTo(0.9, 6)
    expect(entry?.kind).toBe("test")
  })

  test("review example end-to-end: 5 of 10 covered files changed → still valid; all 10 → blocked", () => {
    const ledger = createEvidenceLedger()
    enableEvidenceDecay(ledger, { totalAffectedFiles: FILES(10) })
    ingestVerificationResult(ledger, makeResult("test"), undefined, undefined, FILES(10))

    recordFilesChanged(ledger, FILES(5))
    expect(decayedEvidence(ledger)).toHaveLength(0)
    let gate = canClaimDone({ tracker: null, evidence: ledger, requiredKinds: ["test"] })
    expect(gate.canClaim).toBe(true)

    recordFilesChanged(ledger, FILES(10))
    expect(decayedEvidence(ledger)).toHaveLength(1)
    gate = canClaimDone({ tracker: null, evidence: ledger, requiredKinds: ["test"] })
    expect(gate.canClaim).toBe(false)
    expect(gate.missing.some(m => m.includes("证据置信度过低"))).toBe(true)
  })

  test("minConfidence override tightens or relaxes the gate", () => {
    const ledger = createEvidenceLedger()
    enableEvidenceDecay(ledger, { totalAffectedFiles: FILES(10) })
    ingestVerificationResult(ledger, makeResult("test"), undefined, undefined, FILES(10))
    recordFilesChanged(ledger, FILES(5)) // ≈0.55

    expect(canClaimDone({ tracker: null, evidence: ledger, requiredKinds: ["test"], minConfidence: 0.9 }).canClaim).toBe(false)
    expect(canClaimDone({ tracker: null, evidence: ledger, requiredKinds: ["test"], minConfidence: 0.4 }).canClaim).toBe(true)
  })

  test("legacy ledgers without decay tracking are unaffected", () => {
    const ledger = createEvidenceLedger()
    ingestVerificationResult(ledger, makeResult("test"))
    ingestTypecheck(ledger, { passed: true, issues: 0, output: "clean" })
    addManualEvidence(ledger, { description: "reviewed", passed: true })

    for (const entry of ledger.entries) expect(entry.confidence).toBeUndefined()
    expect(decayedEvidence(ledger)).toHaveLength(0)
    const gate = canClaimDone({ tracker: null, evidence: ledger, requiredKinds: ["test"] })
    expect(gate.canClaim).toBe(true)
  })

  test("serialization round-trip preserves confidence, coverage and decay state", () => {
    const ledger = createEvidenceLedger()
    enableEvidenceDecay(ledger, { totalAffectedFiles: FILES(10) })
    ingestVerificationResult(ledger, makeResult("test"), undefined, undefined, FILES(10))
    recordFilesChanged(ledger, FILES(5))

    const restored: EvidenceLedger = deserializeLedger(JSON.parse(JSON.stringify(serializeLedger(ledger))))
    expect(restored.decay?.changedFiles).toEqual(FILES(5))
    expect(restored.decay?.totalAffectedFiles).toEqual(FILES(10))
    expect(restored.entries[0]?.coveredFiles).toEqual(FILES(10))
    expect(restored.entries[0]?.confidence?.confidence).toBeCloseTo(ledger.entries[0]!.confidence!.confidence, 10)
    expect(canClaimDone({ tracker: null, evidence: restored, requiredKinds: ["test"] }).canClaim).toBe(true)
  })

  test("legacy serialized ledgers (no new fields) still deserialize and gate cleanly", () => {
    const legacy = {
      entries: [
        { id: "evi_1", kind: "test" as const, output: "ok", passed: true, timestamp: NOW },
      ],
    }
    const restored = deserializeLedger(legacy)
    expect(restored.decay).toBeUndefined()
    expect(canClaimDone({ tracker: null, evidence: restored, requiredKinds: ["test"] }).canClaim).toBe(true)
  })
})
