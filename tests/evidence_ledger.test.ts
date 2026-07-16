/** Tests for Evidence Ledger (PR 6). */

import { describe, it, expect, beforeEach } from "bun:test"
import {
  createEvidenceLedger,
  addEvidence,
  hasEvidence,
  getEvidence,
  latestPassedEvidence,
  toEvidenceKind,
  evidenceKindLabel,
  requiredEvidenceKinds,
  canClaimDone,
  generateEvidenceId,
  resetEvidenceIdCounter,
  ingestVerificationResult,
  ingestVerificationResults,
  addManualEvidence,
  formatEvidenceLedgerStatus,
  formatCanClaimDoneBlocked,
  serializeLedger,
  deserializeLedger,
  type EvidenceLedger,
  type EvidenceEntry,
  type EvidenceKind,
} from "../src/agent/evidence-ledger"
import type { TransactionEvidenceBinding, VerificationResult } from "../src/verification/result"
import type { TaskTracker } from "../src/agent/task-tracker"

beforeEach(() => {
  resetEvidenceIdCounter()
})

function transactionBinding(
  stateId: string,
  transactionCount: number,
  latestTransactionId: string,
): TransactionEvidenceBinding {
  return { stateId, transactionCount, latestTransactionId }
}

// ── toEvidenceKind ──

describe("toEvidenceKind", () => {
  it("maps typecheck → typecheck", () => {
    expect(toEvidenceKind("typecheck")).toBe("typecheck")
  })

  it("maps lint → typecheck", () => {
    expect(toEvidenceKind("lint")).toBe("typecheck")
  })

  it("maps test → test", () => {
    expect(toEvidenceKind("test")).toBe("test")
  })

  it("maps smoke → test", () => {
    expect(toEvidenceKind("smoke")).toBe("test")
  })

  it("maps build → build", () => {
    expect(toEvidenceKind("build")).toBe("build")
  })

  it("maps unknown → null", () => {
    expect(toEvidenceKind("unknown")).toBeNull()
  })
})

// ── evidenceKindLabel ──

describe("evidenceKindLabel", () => {
  it("returns Chinese labels", () => {
    expect(evidenceKindLabel("typecheck")).toBe("类型检查")
    expect(evidenceKindLabel("test")).toBe("测试")
    expect(evidenceKindLabel("build")).toBe("构建")
    expect(evidenceKindLabel("manual")).toBe("人工验证")
  })
})

// ── createEvidenceLedger ──

describe("createEvidenceLedger", () => {
  it("creates empty ledger", () => {
    const ledger = createEvidenceLedger()
    expect(ledger.entries).toEqual([])
  })
})

// ── generateEvidenceId ──

describe("generateEvidenceId", () => {
  it("returns unique incrementing ids", () => {
    const id1 = generateEvidenceId()
    const id2 = generateEvidenceId()
    expect(id1).toMatch(/^evi_\d+_\d+$/)
    expect(id2).toMatch(/^evi_\d+_\d+$/)
    expect(id1).not.toBe(id2)
  })
})

// ── addEvidence / hasEvidence / getEvidence ──

describe("ledger CRUD", () => {
  let ledger: EvidenceLedger

  beforeEach(() => {
    ledger = createEvidenceLedger()
  })

  it("addEvidence adds entry", () => {
    const entry: EvidenceEntry = {
      id: "evi_1",
      kind: "typecheck",
      command: "tsc --noEmit",
      output: "0 errors",
      passed: true,
      timestamp: Date.now(),
    }
    addEvidence(ledger, entry)
    expect(ledger.entries).toHaveLength(1)
    expect(ledger.entries[0]!.id).toBe("evi_1")
  })

  it("hasEvidence returns true when passed evidence exists", () => {
    addEvidence(ledger, {
      id: "evi_1", kind: "test", command: "bun test", output: "5 passed",
      passed: true, timestamp: Date.now(),
    })
    expect(hasEvidence(ledger, "test")).toBe(true)
  })

  it("hasEvidence returns false when only failed evidence exists", () => {
    addEvidence(ledger, {
      id: "evi_1", kind: "test", command: "bun test", output: "3 failed",
      passed: false, timestamp: Date.now(),
    })
    expect(hasEvidence(ledger, "test")).toBe(false)
  })

  it("hasEvidence returns false for missing kind", () => {
    expect(hasEvidence(ledger, "build")).toBe(false)
  })

  it("getEvidence filters by kind", () => {
    addEvidence(ledger, {
      id: "evi_1", kind: "typecheck", command: "tsc", output: "ok",
      passed: true, timestamp: 1000,
    })
    addEvidence(ledger, {
      id: "evi_2", kind: "test", command: "bun test", output: "ok",
      passed: true, timestamp: 2000,
    })
    addEvidence(ledger, {
      id: "evi_3", kind: "typecheck", command: "tsc", output: "ok",
      passed: false, timestamp: 3000,
    })
    expect(getEvidence(ledger, "typecheck")).toHaveLength(2)
    expect(getEvidence(ledger, "test")).toHaveLength(1)
    expect(getEvidence(ledger, "build")).toHaveLength(0)
  })

  it("latestPassedEvidence returns most recent passed entry", () => {
    addEvidence(ledger, {
      id: "evi_1", kind: "typecheck", command: "tsc", output: "first",
      passed: true, timestamp: 1000,
    })
    addEvidence(ledger, {
      id: "evi_2", kind: "typecheck", command: "tsc", output: "second",
      passed: true, timestamp: 2000,
    })
    const latest = latestPassedEvidence(ledger, "typecheck")
    expect(latest).not.toBeNull()
    expect(latest!.id).toBe("evi_2")
  })

  it("latestPassedEvidence returns null when no passed evidence", () => {
    addEvidence(ledger, {
      id: "evi_1", kind: "typecheck", command: "tsc", output: "fail",
      passed: false, timestamp: 1000,
    })
    expect(latestPassedEvidence(ledger, "typecheck")).toBeNull()
  })
})

// ── ingestVerificationResult ──

describe("ingestVerificationResult", () => {
  let ledger: EvidenceLedger

  beforeEach(() => {
    ledger = createEvidenceLedger()
  })

  it("ingests passed typecheck result", () => {
    const vr: VerificationResult = {
      kind: "typecheck", command: "tsc --noEmit", passed: true,
      exitCode: 0, issues: 0, durationMs: 500, summary: "No errors",
    }
    const entry = ingestVerificationResult(ledger, vr)
    expect(entry).not.toBeNull()
    expect(entry!.kind).toBe("typecheck")
    expect(entry!.passed).toBe(true)
    expect(entry!.command).toBe("tsc --noEmit")
    expect(hasEvidence(ledger, "typecheck")).toBe(true)
  })

  it("ingests failed test result (not counted as passed evidence)", () => {
    const vr: VerificationResult = {
      kind: "test", command: "bun test", passed: false,
      exitCode: 1, issues: 3, durationMs: 1200, summary: "3 failed",
    }
    const entry = ingestVerificationResult(ledger, vr)
    expect(entry).not.toBeNull()
    expect(entry!.kind).toBe("test")
    expect(entry!.passed).toBe(false)
    expect(hasEvidence(ledger, "test")).toBe(false)
  })

  it("maps lint → typecheck evidence", () => {
    const vr: VerificationResult = {
      kind: "lint", command: "eslint .", passed: true,
      exitCode: 0, issues: 0, durationMs: 300, summary: "0 warnings",
    }
    const entry = ingestVerificationResult(ledger, vr)
    expect(entry).not.toBeNull()
    expect(entry!.kind).toBe("typecheck")
    expect(hasEvidence(ledger, "typecheck")).toBe(true)
  })

  it("maps smoke → test evidence", () => {
    const vr: VerificationResult = {
      kind: "smoke", command: "curl localhost:3000", passed: true,
      exitCode: 0, issues: 0, durationMs: 200, summary: "200 OK",
    }
    const entry = ingestVerificationResult(ledger, vr)
    expect(entry).not.toBeNull()
    expect(entry!.kind).toBe("test")
    expect(hasEvidence(ledger, "test")).toBe(true)
  })

  it("returns null for unknown kind", () => {
    const vr: VerificationResult = {
      kind: "unknown", command: "some-cmd", passed: true,
      exitCode: 0, issues: 0, durationMs: 100, summary: "ok",
    }
    expect(ingestVerificationResult(ledger, vr)).toBeNull()
  })

  it("attaches optional txId", () => {
    const vr: VerificationResult = {
      kind: "build", command: "bun run build", passed: true,
      exitCode: 0, issues: 0, durationMs: 2000, summary: "Build ok",
    }
    const entry = ingestVerificationResult(ledger, vr, "ptxn_abc123")
    expect(entry!.txId).toBe("ptxn_abc123")
  })

  it("preserves transaction evidence binding from verification results", () => {
    const vr: VerificationResult = {
      kind: "test", command: "bun test", passed: true,
      exitCode: 0, issues: 0, durationMs: 2000, summary: "Tests ok",
      transaction: transactionBinding("txstate_ab", 2, "ptxn_b"),
    }

    const entry = ingestVerificationResult(ledger, vr)

    expect(entry?.transaction).toEqual(vr.transaction)
    expect(entry?.transaction).not.toBe(vr.transaction)
  })
})

// ── ingestVerificationResults (batch) ──

describe("ingestVerificationResults", () => {
  it("batch ingests multiple results", () => {
    const ledger = createEvidenceLedger()
    const results: VerificationResult[] = [
      { kind: "typecheck", command: "tsc", passed: true, exitCode: 0, issues: 0, durationMs: 500, summary: "ok" },
      { kind: "test", command: "bun test", passed: true, exitCode: 0, issues: 0, durationMs: 1000, summary: "5 passed" },
      { kind: "build", command: "bun run build", passed: true, exitCode: 0, issues: 0, durationMs: 2000, summary: "built" },
    ]
    const entries = ingestVerificationResults(ledger, results)
    expect(entries).toHaveLength(3)
    expect(hasEvidence(ledger, "typecheck")).toBe(true)
    expect(hasEvidence(ledger, "test")).toBe(true)
    expect(hasEvidence(ledger, "build")).toBe(true)
  })
})

// ── addManualEvidence ──

describe("addManualEvidence", () => {
  it("adds manual evidence entry", () => {
    const ledger = createEvidenceLedger()
    const entry = addManualEvidence(ledger, {
      description: "代码审查通过",
      passed: true,
    })
    expect(entry.kind).toBe("manual")
    expect(entry.command).toBeUndefined()
    expect(entry.output).toBe("代码审查通过")
    expect(hasEvidence(ledger, "manual")).toBe(true)
  })

  it("failed manual evidence does not satisfy requirement", () => {
    const ledger = createEvidenceLedger()
    addManualEvidence(ledger, {
      description: "人工审查未通过",
      passed: false,
    })
    expect(hasEvidence(ledger, "manual")).toBe(false)
  })
})

// ── requiredEvidenceKinds ──

describe("requiredEvidenceKinds", () => {
  it("returns empty for null tracker", () => {
    expect(requiredEvidenceKinds(null)).toEqual([])
  })

  it("deduplicates lint+typecheck to single typecheck", () => {
    const tracker = {
      requiredVerificationKinds: ["typecheck", "lint", "build"] as Array<"typecheck" | "lint" | "build">,
    } as TaskTracker
    const kinds = requiredEvidenceKinds(tracker)
    expect(kinds).toContain("typecheck")
    expect(kinds).toContain("build")
    // lint maps to typecheck → should be deduped
    expect(kinds.filter(k => k === "typecheck")).toHaveLength(1)
  })

  it("deduplicates test+smoke to single test", () => {
    const tracker = {
      requiredVerificationKinds: ["test", "smoke"] as Array<"test" | "smoke">,
    } as TaskTracker
    const kinds = requiredEvidenceKinds(tracker)
    expect(kinds).toEqual(["test"])
  })
})

// ── canClaimDone ──

describe("canClaimDone", () => {
  let ledger: EvidenceLedger

  beforeEach(() => {
    ledger = createEvidenceLedger()
  })

  function makeTracker(overrides: Partial<TaskTracker> = {}): TaskTracker {
    return {
      goal: "test goal",
      intent: "long_task",
      phase: "building",
      requiredFiles: [],
      requiredVerificationKinds: [],
      verificationEvidence: {},
      verification: [],
      steps: [{ id: "s1", title: "step 1", status: "done" }],
      ...overrides,
    }
  }

  it("can claim when no tracker", () => {
    const result = canClaimDone({ tracker: null, evidence: ledger })
    expect(result.canClaim).toBe(true)
  })

  it("can claim when tracker is complete", () => {
    const tracker = makeTracker({ phase: "complete" })
    const result = canClaimDone({ tracker, evidence: ledger })
    expect(result.canClaim).toBe(true)
  })

  it("cannot claim when steps are not done", () => {
    const tracker = makeTracker({
      steps: [
        { id: "s1", title: "step 1", status: "done" },
        { id: "s2", title: "step 2", status: "running" },
      ],
    })
    const result = canClaimDone({ tracker, evidence: ledger })
    expect(result.canClaim).toBe(false)
    expect(result.blocked.some(b => b.includes("步骤未完成"))).toBe(true)
  })

  it("cannot claim when required typecheck evidence is missing", () => {
    const tracker = makeTracker({
      steps: [{ id: "s1", title: "step 1", status: "done" }],
      requiredVerificationKinds: ["typecheck"],
    })
    const result = canClaimDone({ tracker, evidence: ledger })
    expect(result.canClaim).toBe(false)
    expect(result.unsatisfiedKinds).toContain("typecheck")
    expect(result.blocked.some(b => b.includes("类型检查"))).toBe(true)
  })

  it("can claim when all required evidence is present", () => {
    const tracker = makeTracker({
      steps: [{ id: "s1", title: "step 1", status: "done" }],
      requiredVerificationKinds: ["typecheck", "test"],
    })
    addEvidence(ledger, {
      id: "evi_1", kind: "typecheck", command: "tsc", output: "ok",
      passed: true, timestamp: 1000,
    })
    addEvidence(ledger, {
      id: "evi_2", kind: "test", command: "bun test", output: "5 passed",
      passed: true, timestamp: 2000,
    })
    const result = canClaimDone({ tracker, evidence: ledger })
    expect(result.canClaim).toBe(true)
    expect(result.satisfiedKinds).toContain("typecheck")
    expect(result.satisfiedKinds).toContain("test")
    expect(result.unsatisfiedKinds).toHaveLength(0)
  })

  it("rejects current-generation evidence bound to a different patch transaction", () => {
    const tracker = makeTracker({
      steps: [{ id: "s1", title: "step 1", status: "done" }],
      requiredVerificationKinds: ["typecheck"],
    })
    addEvidence(ledger, {
      id: "evi_1", kind: "typecheck", command: "tsc", output: "ok",
      passed: true, timestamp: 1000, generation: 3,
      transaction: transactionBinding("txstate_other", 1, "ptxn_other"),
    })

    const result = canClaimDone({
      tracker,
      evidence: ledger,
      currentGeneration: 3,
      evidenceBinding: transactionBinding("txstate_current", 1, "ptxn_current"),
    })

    expect(result.canClaim).toBe(false)
    expect(result.unsatisfiedKinds).toContain("typecheck")
  })

  it("rejects unbound current-generation evidence when a transaction binding is required", () => {
    const tracker = makeTracker({
      steps: [{ id: "s1", title: "step 1", status: "done" }],
      requiredVerificationKinds: ["typecheck"],
    })
    addEvidence(ledger, {
      id: "evi_1", kind: "typecheck", command: "tsc", output: "ok",
      passed: true, timestamp: 1000, generation: 3,
    })

    const result = canClaimDone({
      tracker,
      evidence: ledger,
      currentGeneration: 3,
      evidenceBinding: transactionBinding("txstate_current", 1, "ptxn_current"),
    })

    expect(result.canClaim).toBe(false)
    expect(result.unsatisfiedKinds).toContain("typecheck")
  })

  it("fails closed after a write when the runtime has no transaction binding", () => {
    const tracker = makeTracker({
      steps: [{ id: "s1", title: "step 1", status: "done" }],
      requiredVerificationKinds: ["typecheck"],
    })
    addEvidence(ledger, {
      id: "evi_1", kind: "typecheck", command: "tsc", output: "ok",
      passed: true, timestamp: 1000, generation: 3,
    })

    const result = canClaimDone({
      tracker,
      evidence: ledger,
      currentGeneration: 3,
      requireEvidenceBinding: true,
    })

    expect(result.canClaim).toBe(false)
    expect(result.unsatisfiedKinds).toContain("typecheck")
  })

  it("accepts evidence bound to every required transaction", () => {
    const tracker = makeTracker({
      steps: [{ id: "s1", title: "step 1", status: "done" }],
      requiredVerificationKinds: ["typecheck"],
    })
    addEvidence(ledger, {
      id: "evi_1", kind: "typecheck", command: "tsc", output: "ok",
      passed: true, timestamp: 1000, generation: 3,
      transaction: transactionBinding("txstate_ab", 2, "ptxn_b"),
    })

    const result = canClaimDone({
      tracker,
      evidence: ledger,
      currentGeneration: 3,
      evidenceBinding: transactionBinding("txstate_ab", 2, "ptxn_b"),
    })

    expect(result.canClaim).toBe(true)
  })

  it("rejects evidence bound to a different commit-history snapshot", () => {
    const tracker = makeTracker({
      steps: [{ id: "s1", title: "step 1", status: "done" }],
      requiredVerificationKinds: ["typecheck"],
    })
    addEvidence(ledger, {
      id: "evi_1", kind: "typecheck", command: "tsc", output: "ok",
      passed: true, timestamp: 1000, generation: 3,
      transaction: transactionBinding("txstate_extra", 2, "ptxn_extra"),
    })

    const result = canClaimDone({
      tracker,
      evidence: ledger,
      currentGeneration: 3,
      evidenceBinding: transactionBinding("txstate_current", 1, "ptxn_current"),
    })

    expect(result.canClaim).toBe(false)
    expect(result.unsatisfiedKinds).toContain("typecheck")
  })

  it("rejects a legacy txId even for a matching single-transaction history", () => {
    const tracker = makeTracker({
      steps: [{ id: "s1", title: "step 1", status: "done" }],
      requiredVerificationKinds: ["typecheck"],
    })
    addEvidence(ledger, {
      id: "evi_legacy", kind: "typecheck", command: "tsc", output: "ok",
      passed: true, timestamp: 1000, generation: 3, txId: "ptxn_current",
    })

    const result = canClaimDone({
      tracker,
      evidence: ledger,
      currentGeneration: 3,
      evidenceBinding: transactionBinding("txstate_current", 1, "ptxn_current"),
    })

    expect(result.canClaim).toBe(false)
  })

  it("rejects a legacy txId for a multi-transaction history", () => {
    const tracker = makeTracker({
      steps: [{ id: "s1", title: "step 1", status: "done" }],
      requiredVerificationKinds: ["typecheck"],
    })
    addEvidence(ledger, {
      id: "evi_legacy", kind: "typecheck", command: "tsc", output: "ok",
      passed: true, timestamp: 1000, generation: 3, txId: "ptxn_latest",
    })

    const result = canClaimDone({
      tracker,
      evidence: ledger,
      currentGeneration: 3,
      evidenceBinding: transactionBinding("txstate_two", 2, "ptxn_latest"),
    })

    expect(result.canClaim).toBe(false)
  })

  it("cannot claim when evidence exists but all failed", () => {
    const tracker = makeTracker({
      steps: [{ id: "s1", title: "step 1", status: "done" }],
      requiredVerificationKinds: ["typecheck"],
    })
    addEvidence(ledger, {
      id: "evi_1", kind: "typecheck", command: "tsc", output: "5 errors",
      passed: false, timestamp: 1000,
    })
    const result = canClaimDone({ tracker, evidence: ledger })
    expect(result.canClaim).toBe(false)
    expect(result.unsatisfiedKinds).toContain("typecheck")
  })

  it("cannot claim when lint requirement unmet (maps to typecheck)", () => {
    const tracker = makeTracker({
      steps: [{ id: "s1", title: "step 1", status: "done" }],
      requiredVerificationKinds: ["lint"],
    })
    const result = canClaimDone({ tracker, evidence: ledger })
    expect(result.canClaim).toBe(false)
    expect(result.unsatisfiedKinds).toContain("typecheck")
  })

  it("reports satisfied and unsatisfied kinds correctly", () => {
    const tracker = makeTracker({
      steps: [{ id: "s1", title: "step 1", status: "done" }],
      requiredVerificationKinds: ["typecheck", "test", "build"],
    })
    addEvidence(ledger, {
      id: "evi_1", kind: "typecheck", command: "tsc", output: "ok",
      passed: true, timestamp: 1000,
    })
    const result = canClaimDone({ tracker, evidence: ledger })
    expect(result.satisfiedKinds).toContain("typecheck")
    expect(result.unsatisfiedKinds).toContain("test")
    expect(result.unsatisfiedKinds).toContain("build")
    expect(result.missing.length).toBeGreaterThan(0)
  })

  it("empty requiredVerificationKinds trivially passes", () => {
    const tracker = makeTracker({
      steps: [{ id: "s1", title: "step 1", status: "done" }],
      requiredVerificationKinds: [],
    })
    const result = canClaimDone({ tracker, evidence: ledger })
    expect(result.canClaim).toBe(true)
  })

  it("blocks on required file missing", () => {
    const tracker = makeTracker({
      steps: [{ id: "s1", title: "step 1", status: "done" }],
      requiredFiles: ["nonexistent/file/that/cannot/exist.ts"],
    })
    const result = canClaimDone({ tracker, evidence: ledger, cwd: "/tmp" })
    expect(result.canClaim).toBe(false)
    expect(result.missing.some(m => m.includes("缺少文件"))).toBe(true)
  })
})

// ── formatEvidenceLedgerStatus ──

describe("formatEvidenceLedgerStatus", () => {
  it("returns placeholder for empty ledger", () => {
    const ledger = createEvidenceLedger()
    expect(formatEvidenceLedgerStatus(ledger)).toBe("暂无验证证据")
  })

  it("formats entries with pass/fail counts", () => {
    const ledger = createEvidenceLedger()
    addEvidence(ledger, {
      id: "evi_1", kind: "typecheck", command: "tsc --noEmit", output: "0 errors",
      passed: true, timestamp: 1000,
    })
    addEvidence(ledger, {
      id: "evi_2", kind: "test", command: "bun test", output: "3 failed",
      passed: false, timestamp: 2000,
    })
    const status = formatEvidenceLedgerStatus(ledger)
    expect(status).toContain("类型检查")
    expect(status).toContain("1/1 通过")
    expect(status).toContain("测试")
    expect(status).toContain("0/1 通过")
    expect(status).toContain("tsc --noEmit")
    expect(status).toContain("bun test")
  })
})

// ── formatCanClaimDoneBlocked ──

describe("formatCanClaimDoneBlocked", () => {
  it("returns empty string when canClaim is true", () => {
    const result = { canClaim: true, missing: [], blocked: [], requiredKinds: [], satisfiedKinds: [], unsatisfiedKinds: [] }
    expect(formatCanClaimDoneBlocked(result)).toBe("")
  })

  it("formats blocked reasons", () => {
    const result = {
      canClaim: false,
      missing: ["步骤未完成: step 2", "缺少验证证据: 类型检查"],
      blocked: ["必需的验证证据缺失: 类型检查"],
      requiredKinds: ["typecheck"] as EvidenceKind[],
      satisfiedKinds: [] as EvidenceKind[],
      unsatisfiedKinds: ["typecheck"] as EvidenceKind[],
    }
    const formatted = formatCanClaimDoneBlocked(result)
    expect(formatted).toContain("完成被阻止")
    expect(formatted).toContain("必需的验证证据缺失")
    expect(formatted).toContain("step 2")
  })
})

// ── Serialization ──

describe("serialization", () => {
  it("round-trips through serialize/deserialize", () => {
    const ledger = createEvidenceLedger()
    addEvidence(ledger, {
      id: "evi_1", kind: "typecheck", command: "tsc", output: "ok",
      passed: true, timestamp: 1000, txId: "ptxn_abc",
      transaction: transactionBinding("txstate_abcdef", 2, "ptxn_def"),
    })
    addEvidence(ledger, {
      id: "evi_2", kind: "test", command: "bun test", output: "5 passed",
      passed: true, timestamp: 2000,
    })
    const serialized = serializeLedger(ledger)
    const restored = deserializeLedger(serialized)
    expect(restored.entries).toHaveLength(2)
    expect(restored.entries[0]!.id).toBe("evi_1")
    expect(restored.entries[0]!.txId).toBe("ptxn_abc")
    expect(restored.entries[0]!.transaction).toEqual({
      stateId: "txstate_abcdef",
      transactionCount: 2,
      latestTransactionId: "ptxn_def",
    })
    expect(restored.entries[1]!.kind).toBe("test")
    expect(hasEvidence(restored, "typecheck")).toBe(true)
    expect(hasEvidence(restored, "test")).toBe(true)
  })

  it("deserialized ledger is independent", () => {
    const ledger = createEvidenceLedger()
    addEvidence(ledger, { id: "evi_1", kind: "build", command: "build", output: "ok", passed: true, timestamp: 1000 })
    const serialized = serializeLedger(ledger)
    const restored = deserializeLedger(serialized)
    addEvidence(restored, { id: "evi_2", kind: "typecheck", command: "tsc", output: "ok", passed: true, timestamp: 2000 })
    // Original should still have 1 entry
    expect(ledger.entries).toHaveLength(1)
    expect(restored.entries).toHaveLength(2)
  })

  it("deserializes legacy entries without transaction history", () => {
    const restored = deserializeLedger({
      entries: [{
        id: "evi_legacy",
        kind: "typecheck",
        command: "tsc",
        output: "ok",
        passed: true,
        timestamp: 1000,
        txId: "ptxn_legacy",
        generation: 1,
      }],
    })

    expect(restored.entries[0]).toMatchObject({
      id: "evi_legacy",
      txId: "ptxn_legacy",
      generation: 1,
    })
    expect(restored.entries[0]?.transaction).toBeUndefined()
  })
})
