/** [command-to-file coverage] — v1.0 evidence-chain gap.
 *
 *  Shell/run_process writes are observed as "unmanaged": they used to poison
 *  the transaction binding (currentTransactionEvidenceBinding → undefined)
 *  and force the completion gate to require a binding forever — a deadlock
 *  for any run that legitimately used a command after editing.
 *
 *  Fixed behavior:
 *   - the exact unmanaged write paths are recorded (sandbox diff paths);
 *   - a PASSING run_targeted_verification records the files it verified
 *     (it runs against the CURRENT disk state);
 *   - when every unmanaged path is covered, the completion gate relaxes the
 *     binding requirement — L1/L2 freshness still apply hard;
 *   - partial coverage keeps the requirement (no relaxation).
 */

import { describe, expect, test } from "bun:test"
import {
  createRuntimeFileStateContext,
  runWithRuntimeFileStateContext,
  recordRuntimeObservedWrites,
  getUnmanagedWritePaths,
  hasCoveredUnmanagedWrites,
  recordVerificationCoverage,
  getWriteGeneration,
  hasRuntimeUnmanagedWrites,
} from "../src/file-state"
import { createEvidenceLedger, addEvidence, canClaimDone, hasFreshPassingEvidence } from "../src/agent/evidence-ledger"
import type { TaskTracker } from "../src/agent/task-tracker"
import type { TransactionEvidenceBinding } from "../src/verification/result"

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

describe("command-to-file coverage", () => {
  test("unmanaged writes record exact paths and poison the binding", () => {
    runWithRuntimeFileStateContext(createRuntimeFileStateContext(), () => {
      recordRuntimeObservedWrites(["src/a.ts", "src/b.ts"])
      expect(hasRuntimeUnmanagedWrites()).toBe(true)
      expect(getUnmanagedWritePaths()).toEqual([expect.stringContaining("a.ts"), expect.stringContaining("b.ts")])
      expect(hasCoveredUnmanagedWrites()).toBe(false)
    })
  })

  test("partial verification coverage does NOT relax the requirement", () => {
    runWithRuntimeFileStateContext(createRuntimeFileStateContext(), () => {
      recordRuntimeObservedWrites(["src/a.ts", "src/b.ts"])
      recordVerificationCoverage(["src/a.ts"])
      expect(hasCoveredUnmanagedWrites()).toBe(false)
      expect(getUnmanagedWritePaths()).toHaveLength(1)
    })
  })

  test("full coverage relaxes the binding requirement", () => {
    runWithRuntimeFileStateContext(createRuntimeFileStateContext(), () => {
      recordRuntimeObservedWrites(["src/a.ts", "src/b.ts"])
      recordVerificationCoverage(["src/a.ts", "src/b.ts"])
      expect(hasCoveredUnmanagedWrites()).toBe(true)
    })
  })

  test("a new unmanaged write after coverage resets the guarantee", () => {
    runWithRuntimeFileStateContext(createRuntimeFileStateContext(), () => {
      recordRuntimeObservedWrites(["src/a.ts"])
      recordVerificationCoverage(["src/a.ts"])
      expect(hasCoveredUnmanagedWrites()).toBe(true)
      recordRuntimeObservedWrites(["src/c.ts"])
      expect(hasCoveredUnmanagedWrites()).toBe(false)
    })
  })

  test("completion gate: covered unmanaged writes pass without a binding", () => {
    runWithRuntimeFileStateContext(createRuntimeFileStateContext(), () => {
      const ledger = createEvidenceLedger()
      recordRuntimeObservedWrites(["src/a.ts"])
      const generation = getWriteGeneration()
      addEvidence(ledger, {
        id: "evi", kind: "typecheck", command: "tsc --noEmit",
        output: "0 errors", passed: true, timestamp: 1000, generation,
      })
      // Without coverage, no binding → blocked.
      expect(hasFreshPassingEvidence(ledger, "typecheck", generation, undefined, true)).toBe(false)
      expect(canClaimDone({ tracker: makeTracker(), evidence: ledger, currentGeneration: generation, evidenceBinding: undefined, requireEvidenceBinding: true }).canClaim).toBe(false)
      // With full coverage, L1/L2 alone decide (orchestrator relaxes the
      // binding requirement — shouldRequireEvidenceBinding returns false).
      recordVerificationCoverage(["src/a.ts"])
      expect(hasCoveredUnmanagedWrites()).toBe(true)
      expect(hasFreshPassingEvidence(ledger, "typecheck", generation, undefined, true)).toBe(false)
      const result = canClaimDone({ tracker: makeTracker(), evidence: ledger, currentGeneration: generation, evidenceBinding: undefined, requireEvidenceBinding: false })
      expect(result.canClaim).toBe(true)
      expect(result.blocked).toEqual([])
    })
  })

  test("covered state never bypasses freshness (L2 still hard)", () => {
    runWithRuntimeFileStateContext(createRuntimeFileStateContext(), () => {
      const ledger = createEvidenceLedger()
      recordRuntimeObservedWrites(["src/a.ts"])
      recordVerificationCoverage(["src/a.ts"])
      addEvidence(ledger, {
        id: "evi_old", kind: "typecheck", command: "tsc --noEmit",
        output: "0 errors", passed: true, timestamp: 1000, generation: 0,
      })
      recordRuntimeObservedWrites(["src/a.ts"]) // new write, coverage reset
      const generation = getWriteGeneration()
      const result = canClaimDone({ tracker: makeTracker(), evidence: ledger, currentGeneration: generation, evidenceBinding: undefined, requireEvidenceBinding: true })
      expect(result.canClaim).toBe(false)
      expect(result.unsatisfiedKinds).toEqual(["typecheck"])
    })
  })

  test("managed-only run still requires a binding (no relaxation)", () => {
    runWithRuntimeFileStateContext(createRuntimeFileStateContext(), () => {
      const ledger = createEvidenceLedger()
      const binding: TransactionEvidenceBinding = { stateId: "txstate_x", transactionCount: 1, latestTransactionId: "tx1" }
      addEvidence(ledger, {
        id: "evi", kind: "typecheck", command: "tsc --noEmit",
        output: "0 errors", passed: true, timestamp: 1000, generation: 0, transaction: binding,
      })
      const noCoverage = hasCoveredUnmanagedWrites()
      expect(noCoverage).toBe(false)
      expect(canClaimDone({ tracker: makeTracker(), evidence: ledger, currentGeneration: 0, evidenceBinding: binding, requireEvidenceBinding: true }).canClaim).toBe(true)
      expect(canClaimDone({ tracker: makeTracker(), evidence: ledger, currentGeneration: 0, evidenceBinding: undefined, requireEvidenceBinding: true }).canClaim).toBe(false)
    })
  })
})
