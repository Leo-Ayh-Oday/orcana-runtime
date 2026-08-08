/** LR2-0I（ADR-LR2-001/003）：Node Completion Gate 验收 —— 写节点完成
 *  链条件（ToolResult + Receipt 完整 + 无未批准写入 + Cleanup 满足 +
 *  Verification 通过）与 SERVICE_READY 语义。 */

import { describe, expect, test } from "bun:test"
import { evaluateNodeCompletion, evaluateServiceReady, bindReceiptEvidence } from "../../../src/runtime/execution/completion-gate"
import { createEvidenceLedger } from "../../../src/agent/evidence-ledger"
import type { SandboxReceipt } from "../../../src/runtime/linux/contracts"

function receipt(overrides: Partial<SandboxReceipt> = {}): SandboxReceipt {
  return {
    schemaVersion: "1.0",
    receiptDigest: "a".repeat(64),
    cellId: "c1",
    runId: "r1",
    nodeRunId: "r1:n1",
    attempt: 1,
    backend: "host-audit",
    profile: "build",
    capabilitiesDigest: "b".repeat(64),
    cellSpecDigest: "c".repeat(64),
    filesystemPolicyDigest: "d".repeat(64),
    networkPolicyDigest: "e".repeat(64),
    resourcePolicyDigest: "f".repeat(64),
    startedAt: 0,
    finishedAt: 100,
    durationMs: 100,
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    oomKilled: false,
    pidLimitHit: false,
    outputLimitHit: false,
    tempLimitHit: false,
    metrics: { status: "unknown", reason: "fixture" },
    observedWrites: [],
    observedDeletes: [],
    unexpectedWrites: [],
    networkMode: "none",
    secretBindingIds: [],
    violations: [],
    degradationReasons: [],
    cleanup: {
      processesRemaining: 0,
      mountsReleased: true,
      cgroupRemoved: true,
      worktreeRetained: false,
      cleanupVerified: true,
    },
    ...overrides,
  }
}

describe("Node Completion Gate (LR2-0I)", () => {
  test("complete evidence chain completes the node", () => {
    const verdict = evaluateNodeCompletion({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      receipt: receipt(),
      unexpectedWrites: [],
      verificationPassed: true,
      ownershipConfirmed: true,
    })
    expect(verdict.completed).toBe(true)
  })

  test("missing receipt blocks completion (no ToolResult-only shortcut)", () => {
    const verdict = evaluateNodeCompletion({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      verificationPassed: true,
      ownershipConfirmed: true,
    })
    expect(verdict.completed).toBe(false)
    if (!verdict.completed) expect(verdict.reasons).toContain("missing execution receipt")
  })

  test("incomplete receipt blocks completion", () => {
    const verdict = evaluateNodeCompletion({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      receipt: receipt({ cleanup: { processesRemaining: 2, mountsReleased: false, cgroupRemoved: false, worktreeRetained: false, cleanupVerified: false } }),
      verificationPassed: true,
      ownershipConfirmed: true,
    })
    expect(verdict.completed).toBe(false)
    if (!verdict.completed) expect(verdict.reasons).toContain("receipt incomplete")
  })

  test("unexpected writes block completion", () => {
    const verdict = evaluateNodeCompletion({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      receipt: receipt(),
      unexpectedWrites: ["/workspace/untracked.txt"],
      verificationPassed: true,
      ownershipConfirmed: true,
    })
    expect(verdict.completed).toBe(false)
  })

  test("verification must have run and passed", () => {
    const notRun = evaluateNodeCompletion({
      exitCode: 0, signal: null, timedOut: false, aborted: false,
      receipt: receipt(), unexpectedWrites: [], ownershipConfirmed: true,
    })
    expect(notRun.completed).toBe(false)
    const failed = evaluateNodeCompletion({
      exitCode: 0, signal: null, timedOut: false, aborted: false,
      receipt: receipt(), unexpectedWrites: [], verificationPassed: false, ownershipConfirmed: true,
    })
    expect(failed.completed).toBe(false)
  })

  test("timed out / non-zero exit block completion", () => {
    const timed = evaluateNodeCompletion({
      exitCode: null, signal: "timeout", timedOut: true, aborted: false,
      receipt: receipt({ exitCode: null, signal: "timeout", timedOut: true }),
      verificationPassed: true, ownershipConfirmed: true,
    })
    expect(timed.completed).toBe(false)
    const nonZero = evaluateNodeCompletion({
      exitCode: 3, signal: null, timedOut: false, aborted: false,
      receipt: receipt({ exitCode: 3 }),
      verificationPassed: true, ownershipConfirmed: true,
    })
    expect(nonZero.completed).toBe(false)
  })

  test("service readiness uses SERVICE_READY semantics (not short-task completion)", () => {
    const ready = evaluateServiceReady({ processRunning: true, ready: true, healthOk: true, leaseHeld: true })
    expect(ready.completed).toBe(true)
    const leaseLost = evaluateServiceReady({ processRunning: true, ready: true, healthOk: true, leaseHeld: false })
    expect(leaseLost.completed).toBe(false)
    const notReady = evaluateServiceReady({ processRunning: true, ready: false, healthOk: true, leaseHeld: true })
    expect(notReady.completed).toBe(false)
  })

  test("receipt evidence binds to the ledger with its digest", () => {
    const ledger = createEvidenceLedger()
    const r = receipt()
    const entry = bindReceiptEvidence(ledger, r)
    expect(entry).not.toBeNull()
    expect(entry!.kind).toBe("sandbox_execution")
    expect(entry!.receiptDigest).toBe(r.receiptDigest)
  })
})
