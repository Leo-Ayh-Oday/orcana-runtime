/** REGRESSION (PR-2, invariant I-2) — evidence must be bound to code state.
 *
 *  Pins the biggest live hole from the 2026-07-10 full-source read: the completion
 *  gate used to treat "any passed entry EVER" as satisfaction, ignoring both a later
 *  failed re-verification (L1) and writes since the evidence was collected (L2).
 *
 *  These now assert the fixed behavior:
 *    - hasFreshPassingEvidence / canClaimDone require the MOST RECENT entry of a
 *      required kind to be passed (L1), and — when a currentGeneration is supplied —
 *      its collection generation to match (no writes since) (L2).
 *  The positive control guards against over-blocking (route's "partial-baseline
 *  false-block" risk): fresh, current, passing evidence must still allow completion.
 */

import { describe, test, expect } from "bun:test"
import { createEvidenceLedger, addEvidence, canClaimDone } from "./evidence-ledger"
import type { TaskTracker } from "./task-tracker"

/** Minimal valid tracker: not complete, all steps done, requires a typecheck,
 *  no required files (cwd omitted → file-existence check is skipped). */
function makeTracker(): TaskTracker {
  return {
    goal: "edit foo.ts",
    intent: "narrow_edit",
    phase: "building",
    requiredFiles: [],
    requiredVerificationKinds: ["typecheck"],
    verificationEvidence: {},
    verification: [],
    steps: [{ id: "s1", title: "apply edit", status: "done" }],
  }
}

describe("Evidence staleness (I-2)", () => {
  test("L1 — a later FAILED re-verification invalidates an earlier PASS", () => {
    const ledger = createEvidenceLedger()
    // round 2: typecheck passed
    addEvidence(ledger, {
      id: "evi_r2", kind: "typecheck", command: "tsc --noEmit",
      output: "0 errors", passed: true, timestamp: 1000, txId: "tx_r2",
    })
    // round 9: code broke; re-running typecheck FAILED (latest entry of the kind)
    addEvidence(ledger, {
      id: "evi_r9", kind: "typecheck", command: "tsc --noEmit",
      output: "3 errors", passed: false, timestamp: 9000, txId: "tx_r9",
    })

    const result = canClaimDone({ tracker: makeTracker(), evidence: ledger })
    expect(result.canClaim).toBe(false)
  })

  test("L2 — a write after verification (generation mismatch) marks evidence stale", () => {
    const ledger = createEvidenceLedger()
    // typecheck passed, collected at write-generation 0
    addEvidence(ledger, {
      id: "evi_g0", kind: "typecheck", command: "tsc --noEmit",
      output: "0 errors", passed: true, timestamp: 1000, generation: 0,
    })
    // a later edit bumped the runtime write-generation to 1 with no re-verification
    const result = canClaimDone({ tracker: makeTracker(), evidence: ledger, currentGeneration: 1 })
    expect(result.canClaim).toBe(false)
  })

  test("L2 — evidence without a generation cannot prove freshness against current code", () => {
    const ledger = createEvidenceLedger()
    addEvidence(ledger, {
      id: "evi_legacy", kind: "typecheck", command: "tsc --noEmit",
      output: "0 errors", passed: true, timestamp: 1000,
    })

    const result = canClaimDone({ tracker: makeTracker(), evidence: ledger, currentGeneration: 0 })

    expect(result.canClaim).toBe(false)
    expect(result.unsatisfiedKinds).toEqual(["typecheck"])
  })

  test("complete phase still enforces required evidence freshness", () => {
    const ledger = createEvidenceLedger()
    addEvidence(ledger, {
      id: "evi_old", kind: "typecheck", command: "tsc --noEmit",
      output: "0 errors", passed: true, timestamp: 1000, generation: 1,
    })
    const tracker = { ...makeTracker(), phase: "complete" as const }

    const result = canClaimDone({ tracker, evidence: ledger, currentGeneration: 2 })

    expect(result.canClaim).toBe(false)
    expect(result.unsatisfiedKinds).toEqual(["typecheck"])
  })

  test("positive control — fresh, current, passing evidence still allows completion", () => {
    const ledger = createEvidenceLedger()
    addEvidence(ledger, {
      id: "evi_ok", kind: "typecheck", command: "tsc --noEmit",
      output: "0 errors", passed: true, timestamp: 1000, generation: 2,
    })
    // no writes since (currentGeneration matches the evidence's generation)
    const result = canClaimDone({ tracker: makeTracker(), evidence: ledger, currentGeneration: 2 })
    expect(result.canClaim).toBe(true)
  })
})
