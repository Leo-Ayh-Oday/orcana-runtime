/** [SS-Next-2B] rollback-aware evidence invalidation.
 *
 *  Pins the v1.0 gap: rollback_transaction used to revert files without
 *  advancing the write-generation (L2) or the commit-history binding (L3),
 *  so evidence collected for the pre-rollback (committed) code state stayed
 *  "fresh" and the completion gate could be satisfied by verification of
 *  code that no longer exists.
 *
 *  Fixed behavior:
 *   - rollback advances the write-generation → pre-rollback evidence fails L2;
 *   - rollback advances the committed-transaction evidence state → the
 *     pre-rollback binding fails L3;
 *   - rollback does NOT mark the run as having unmanaged writes → the
 *     binding stays authoritative and a re-verification after rollback can
 *     produce fresh, passable evidence (no deadlock).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createEvidenceLedger, addEvidence, canClaimDone, hasFreshPassingEvidence } from "./evidence-ledger"
import { initManagedTransaction, applyToTemp, verifyManagedTransaction, commitManagedTransaction, rollbackCommittedTransaction, recordRollbackInEvidenceState, currentTransactionEvidenceBinding } from "./patch-transaction"
import { getWriteGeneration, hasRuntimeUnmanagedWrites, createRuntimeFileStateContext, runWithRuntimeFileStateContext } from "../file-state"
import type { TaskTracker } from "./task-tracker"
import type { TransactionEvidenceBinding } from "../verification/result"

const PROJECT = resolve("tmp-ss-rollback")
const A = join(PROJECT, "a.ts")

beforeAll(() => {
  mkdirSync(PROJECT, { recursive: true })
  writeFileSync(A, "export const a = 1\n")
})

afterAll(() => {
  rmSync(PROJECT, { recursive: true, force: true })
})

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

describe("SS-Next-2B rollback-aware invalidation", () => {
  test("L3 — recordRollbackInEvidenceState changes the binding, failing the match", () => {
    runWithRuntimeFileStateContext(createRuntimeFileStateContext(), () => {
      const ledger = createEvidenceLedger()
      const bindingA: TransactionEvidenceBinding = {
        stateId: "txstate_before",
        transactionCount: 1,
        latestTransactionId: "tx_a",
      }
      addEvidence(ledger, {
        id: "evi_a", kind: "typecheck", command: "tsc --noEmit",
        output: "0 errors", passed: true, timestamp: 1000, generation: 0,
        transaction: bindingA,
      })
      recordRollbackInEvidenceState("tx_a")
      const bindingB = currentTransactionEvidenceBinding()
      expect(bindingB).not.toBeNull()
      expect(bindingB!.stateId).not.toBe(bindingA.stateId)
      expect(bindingB!.latestTransactionId).toBe("tx_a")
      expect(hasFreshPassingEvidence(ledger, "typecheck", 0, bindingB)).toBe(false)
      addEvidence(ledger, {
        id: "evi_b", kind: "typecheck", command: "tsc --noEmit",
        output: "0 errors", passed: true, timestamp: 2000, generation: 0,
        transaction: bindingB,
      })
      expect(hasFreshPassingEvidence(ledger, "typecheck", 0, bindingB)).toBe(true)
    })
  })

  test("rollback advances generation + binding, keeps binding usable, reverts files", () => {
    runWithRuntimeFileStateContext(createRuntimeFileStateContext(), () => {
      expect(getWriteGeneration()).toBe(0)
      const mpt = initManagedTransaction({
        tool: "write_file",
        cwd: PROJECT,
        files: [{ relativePath: "a.ts", oldContent: "export const a = 1\n", newContent: "export const a = 2\n" }],
      })
      applyToTemp(mpt)
      verifyManagedTransaction(mpt)
      commitManagedTransaction(mpt)
      const bindingBefore = currentTransactionEvidenceBinding()
      expect(bindingBefore).not.toBeNull()
      rollbackCommittedTransaction(mpt.patch!.fileTransaction.id, PROJECT)
      expect(getWriteGeneration()).toBeGreaterThan(0)
      expect(hasRuntimeUnmanagedWrites()).toBe(false)
      const bindingAfter = currentTransactionEvidenceBinding()
      expect(bindingAfter).not.toBeNull()
      expect(bindingAfter!.stateId).not.toBe(bindingBefore!.stateId)
      expect(readFileSync(A, "utf-8")).toContain("a = 1")
    })
  })

  test("completion gate rejects pre-rollback evidence end-to-end", () => {
    runWithRuntimeFileStateContext(createRuntimeFileStateContext(), () => {
      const ledger = createEvidenceLedger()
      addEvidence(ledger, {
        id: "evi_pre", kind: "typecheck", command: "tsc --noEmit",
        output: "0 errors", passed: true, timestamp: 1000, generation: 0,
      })
      const mpt = initManagedTransaction({
        tool: "write_file",
        cwd: PROJECT,
        files: [{ relativePath: "a.ts", oldContent: "export const a = 1\n", newContent: "export const a = 3\n" }],
      })
      applyToTemp(mpt)
      verifyManagedTransaction(mpt)
      commitManagedTransaction(mpt)
      const bindingBefore = currentTransactionEvidenceBinding()
      expect(bindingBefore).not.toBeNull()
      addEvidence(ledger, {
        id: "evi_ok", kind: "typecheck", command: "tsc --noEmit",
        output: "0 errors", passed: true, timestamp: 2000, generation: 1,
        transaction: bindingBefore,
      })
      expect(canClaimDone({ tracker: makeTracker(), evidence: ledger, currentGeneration: 1, evidenceBinding: bindingBefore }).canClaim).toBe(true)
      rollbackCommittedTransaction(mpt.patch!.fileTransaction.id, PROJECT)
      const generationAfter = getWriteGeneration()
      expect(generationAfter).toBeGreaterThanOrEqual(1)
      const result = canClaimDone({ tracker: makeTracker(), evidence: ledger, currentGeneration: generationAfter, evidenceBinding: currentTransactionEvidenceBinding() })
      expect(result.canClaim).toBe(false)
      expect(result.blocked.length).toBeGreaterThan(0)
    })
  })
})
