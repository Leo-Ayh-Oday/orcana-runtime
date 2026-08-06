/** R5: Sandbox Receipt → Evidence 接入（审计 §26）。 */

import { describe, expect, test } from "bun:test"
import { createEvidenceLedger, ingestSandboxReceipt, hasEvidence, getEvidence } from "../../src/agent/evidence-ledger"
import type { SandboxReceipt } from "../../src/runtime/linux/contracts"

function receipt(overrides: Partial<SandboxReceipt> = {}): SandboxReceipt {
  return {
    schemaVersion: "1.0",
    receiptDigest: "f".repeat(16),
    cellId: "c1",
    runId: "r1",
    nodeRunId: "r1:n",
    attempt: 1,
    backend: "host-audit",
    profile: "inspect",
    capabilitiesDigest: "a".repeat(16),
    cellSpecDigest: "b".repeat(16),
    filesystemPolicyDigest: "c".repeat(16),
    networkPolicyDigest: "d".repeat(16),
    resourcePolicyDigest: "e".repeat(16),
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    oomKilled: false,
    pidLimitHit: false,
    outputLimitHit: false,
    tempLimitHit: false,
    metrics: {},
    observedWrites: [],
    observedDeletes: [],
    unexpectedWrites: [],
    networkMode: "none",
    secretBindingIds: [],
    violations: [],
    degradationReasons: [],
    cleanup: { processesRemaining: 0, mountsReleased: true, cgroupRemoved: true, worktreeRetained: false },
    ...overrides,
  }
}

describe("R5 evidence binding", () => {
  test("complete receipt ingests sandbox_execution + sandbox_cleanup evidence", () => {
    const ledger = createEvidenceLedger()
    const entry = ingestSandboxReceipt(ledger, receipt())
    expect(entry).not.toBeNull()
    expect(hasEvidence(ledger, "sandbox_execution")).toBe(true)
    expect(hasEvidence(ledger, "sandbox_cleanup")).toBe(true)
    const exec = getEvidence(ledger, "sandbox_execution")[0]!
    expect(exec.backend).toBe("host-audit")
    expect(exec.receiptDigest).toBe("f".repeat(16))
    expect(exec.networkMode).toBe("none")
    expect(exec.degraded).toBe(false)
  })

  test("incomplete receipt (no digest / not finished) is rejected", () => {
    const ledger = createEvidenceLedger()
    const entry = ingestSandboxReceipt(ledger, receipt({ cellSpecDigest: "" }))
    expect(entry).toBeNull()
    expect(hasEvidence(ledger, "sandbox_execution")).toBe(false)
  })

  test("failed execution does not produce passing sandbox_execution evidence", () => {
    const ledger = createEvidenceLedger()
    const entry = ingestSandboxReceipt(ledger, receipt({ exitCode: 1, cleanup: { processesRemaining: 3, mountsReleased: false, cgroupRemoved: false, worktreeRetained: false } }))
    expect(entry?.passed).toBe(false)
    expect(hasEvidence(ledger, "sandbox_execution")).toBe(false)
    expect(hasEvidence(ledger, "sandbox_cleanup")).toBe(false)
  })

  test("cleanup unverified → no sandbox_cleanup evidence (unknown is not safe)", () => {
    const ledger = createEvidenceLedger()
    ingestSandboxReceipt(ledger, receipt({ cleanup: { processesRemaining: 1, mountsReleased: false, cgroupRemoved: false, worktreeRetained: false } }))
    expect(hasEvidence(ledger, "sandbox_cleanup")).toBe(false)
  })
})
