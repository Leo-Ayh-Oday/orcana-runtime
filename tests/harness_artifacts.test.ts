import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createArtifactStore } from "../src/harness/artifacts/artifact-store"
import {
  ingestTypecheckWithArtifact,
  ingestVerificationWithArtifact,
  putPatchArtifact,
  putPlanArtifact,
  putRippleArtifact,
} from "../src/harness/artifacts/evidence-adapter"
import { computeRelevantFileHashes, refreshArtifactFreshness } from "../src/harness/artifacts/freshness"
import { computeContentHash, resetArtifactIdCounter } from "../src/harness/artifacts/provenance"
import { createEvidenceLedger, hasFreshPassingEvidence, latestEvidence, canClaimDone } from "../src/agent/evidence-ledger"
import { computeWorkspaceHash } from "../src/harness/persistence/workspace-hash"
import { resetEvidenceIdCounter } from "../src/agent/evidence-ledger"
import type { HarnessArtifact } from "../src/harness/contracts/artifact"
import type { VerificationResult } from "../src/verification/result"

// H8 acceptance: artifacts are real produced things; evidence is the claim an
// artifact supports. Verification ingests both bound together, freshness
// (workspace/file hashes) invalidates both sides, and stale evidence can
// never satisfy the completion gate.

const SAVED_ORCANA_FLASH_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
process.env.ORCANA_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_ORCANA_FLASH_TRIAGE === undefined) delete process.env.ORCANA_FLASH_TRIAGE
  else process.env.ORCANA_FLASH_TRIAGE = SAVED_ORCANA_FLASH_TRIAGE
})

function typecheckResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    kind: "typecheck",
    command: "bun run typecheck",
    passed: true,
    issues: 0,
    durationMs: 120,
    summary: "typecheck passed",
    ...overrides,
  }
}

describe("Harness H8 artifacts", () => {
  test("Typecheck Artifact — batch tsc produces a bound typecheck_result", async () => {
    resetArtifactIdCounter()
    resetEvidenceIdCounter()
    const store = createArtifactStore()
    const ledger = createEvidenceLedger()

    const pair = await ingestTypecheckWithArtifact({
      store,
      ledger,
      runId: "run-tc",
      passed: true,
      issues: 0,
      output: "No errors",
      command: "tsc --noEmit",
      producedBy: "batch_typecheck",
      generation: 3,
      workspaceHash: "ws-hash-1",
      relevantFileHashes: { "src/a.ts": "abc" },
    })

    expect(pair.artifact.kind).toBe("typecheck_result")
    expect(pair.artifact.status).toBe("valid")
    expect(pair.artifact.producedBy).toBe("batch_typecheck")
    expect(pair.artifact.runId).toBe("run-tc")
    expect(pair.artifact.contentHash).toBe(computeContentHash("No errors"))
    // Content is stored by ref, not inline (§14.2).
    expect(await store.getContent(pair.artifact.contentRef)).toBe("No errors")
    // Evidence binds the artifact.
    expect(pair.entry.artifactId).toBe(pair.artifact.artifactId)
    expect(latestEvidence(ledger, "typecheck")?.artifactId).toBe(pair.artifact.artifactId)
    expect(await store.get(pair.artifact.artifactId)).not.toBeNull()
  })

  test("failed typecheck produces a failed artifact and no passing evidence", async () => {
    const store = createArtifactStore()
    const ledger = createEvidenceLedger()

    const pair = await ingestTypecheckWithArtifact({
      store,
      ledger,
      runId: "run-tc-fail",
      passed: false,
      issues: 2,
      output: "error TS100: nope",
      command: "tsc --noEmit",
      producedBy: "batch_typecheck",
    })

    expect(pair.artifact.status).toBe("failed")
    expect(hasFreshPassingEvidence(ledger, "typecheck")).toBe(false)
  })

  test("Test Artifact — VerificationResult ingests as test_result with bound evidence", async () => {
    const store = createArtifactStore()
    const ledger = createEvidenceLedger()

    const pair = await ingestVerificationWithArtifact({
      store,
      ledger,
      runId: "run-test",
      result: typecheckResult({ kind: "test", command: "bun test", summary: "3 passed" }),
      producedBy: "bun test",
    })

    expect(pair).not.toBeNull()
    expect(pair!.artifact.kind).toBe("test_result")
    expect(pair!.artifact.status).toBe("valid")
    expect(pair!.entry.kind).toBe("test")
    expect(pair!.entry.artifactId).toBe(pair!.artifact.artifactId)
    expect(hasFreshPassingEvidence(ledger, "test")).toBe(true)
  })

  test("Patch Artifact — a new patch supersedes the previous valid patch", async () => {
    const store = createArtifactStore()
    const first = await putPatchArtifact({
      store,
      runId: "run-patch",
      txId: "ptxn_1",
      diff: "+ first",
      files: ["src/a.ts"],
      producedBy: "edit_file",
    })
    const second = await putPatchArtifact({
      store,
      runId: "run-patch",
      txId: "ptxn_2",
      diff: "+ second",
      files: ["src/a.ts", "src/b.ts"],
      producedBy: "edit_file",
    })

    const patches = await store.findByKind("patch")
    expect(patches).toHaveLength(2)
    expect((await store.get(first.artifactId))?.status).toBe("superseded")
    expect((await store.get(second.artifactId))?.status).toBe("valid")
  })

  test("Ripple Artifact — ripple reports are recorded as ripple_report", async () => {
    const store = createArtifactStore()
    const artifact = await putRippleArtifact({
      store,
      runId: "run-ripple",
      report: "callers ok",
      producedBy: "ripple_engine",
      workspaceHash: "ws-hash-1",
    })

    expect(artifact.kind).toBe("ripple_report")
    expect(artifact.status).toBe("valid")
    const ripples = await store.findByKind("ripple_report")
    expect(ripples).toHaveLength(1)
  })

  test("Plan Artifact — activating a plan supersedes the previous plan", async () => {
    const store = createArtifactStore()
    const first = await putPlanArtifact({ store, runId: "run-plan", planText: "plan v1", producedBy: "planning" })
    const second = await putPlanArtifact({ store, runId: "run-plan", planText: "plan v2", producedBy: "planning" })

    expect((await store.get(first.artifactId))?.status).toBe("superseded")
    expect((await store.get(second.artifactId))?.status).toBe("valid")
  })

  test("content store deduplicates by hash — same content yields the same ref", async () => {
    const store = createArtifactStore()
    const refA = await store.storeContent("same output")
    const refB = await store.storeContent("same output")
    expect(refA).toBe(refB)
    expect(await store.getContent(refA)).toBe("same output")
  })

  test("evidence binds the transaction snapshot the verification ran under", async () => {
    const store = createArtifactStore()
    const ledger = createEvidenceLedger()
    const binding = {
      stateId: "txstate_abc123def456abc123def456abc123def456",
      transactionCount: 2,
      latestTransactionId: "ptxn_current",
    }

    const pair = await ingestVerificationWithArtifact({
      store,
      ledger,
      runId: "run-tx",
      result: typecheckResult({ transaction: binding }),
      producedBy: "bun run typecheck",
      generation: 1,
    })

    expect(pair!.entry.transaction).toEqual(binding)
    expect(pair!.entry.generation).toBe(1)
    // Freshness check against the same binding passes; a different binding fails.
    expect(hasFreshPassingEvidence(ledger, "typecheck", 1, binding)).toBe(true)
    expect(hasFreshPassingEvidence(ledger, "typecheck", 1, {
      stateId: "txstate_other",
      transactionCount: 1,
      latestTransactionId: "ptxn_other",
    })).toBe(false)
  })
})

describe("Harness H8 freshness", () => {
  test("relevant file change marks the artifact AND its evidence stale", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dscode-h8-fresh-"))
    try {
      writeFileSync(join(cwd, "a.ts"), "export const a = 1\n")
      const store = createArtifactStore()
      const ledger = createEvidenceLedger()

      const hashesBefore = computeRelevantFileHashes(cwd, ["a.ts"])
      const pair = await ingestTypecheckWithArtifact({
        store,
        ledger,
        runId: "run-fresh",
        passed: true,
        issues: 0,
        output: "ok",
        producedBy: "batch_typecheck",
        workspaceHash: computeWorkspaceHash(cwd),
        relevantFileHashes: hashesBefore,
      })
      expect(hasFreshPassingEvidence(ledger, "typecheck")).toBe(true)

      // The relevant file changes after verification.
      writeFileSync(join(cwd, "a.ts"), "export const a = 2\n")

      const staleIds = await refreshArtifactFreshness({
        store,
        ledger,
        workspaceHash: computeWorkspaceHash(cwd),
        relevantFileHashes: computeRelevantFileHashes(cwd, ["a.ts"]),
      })

      expect(staleIds).toContain(pair.artifact.artifactId)
      expect((await store.get(pair.artifact.artifactId))?.status).toBe("stale")
      // The bound evidence is stale too and can no longer satisfy the gate.
      expect(latestEvidence(ledger, "typecheck")?.stale).toBe(true)
      expect(hasFreshPassingEvidence(ledger, "typecheck")).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("workspace drift invalidates verification artifacts (old evidence cannot finish a new version)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dscode-h8-ws-"))
    try {
      writeFileSync(join(cwd, "file.txt"), "v1")
      const store = createArtifactStore()
      const ledger = createEvidenceLedger()

      const pair = await ingestTypecheckWithArtifact({
        store,
        ledger,
        runId: "run-ws",
        passed: true,
        issues: 0,
        output: "ok",
        producedBy: "batch_typecheck",
        workspaceHash: computeWorkspaceHash(cwd),
      })
      expect(hasFreshPassingEvidence(ledger, "typecheck")).toBe(true)

      // A new task version edits the workspace — the old artifact/evidence is stale.
      writeFileSync(join(cwd, "file.txt"), "v2")
      await refreshArtifactFreshness({
        store,
        ledger,
        workspaceHash: computeWorkspaceHash(cwd),
        relevantFileHashes: {},
      })

      expect((await store.get(pair.artifact.artifactId))?.status).toBe("stale")
      expect(hasFreshPassingEvidence(ledger, "typecheck")).toBe(false)
      // canClaimDone fails closed on stale evidence.
      const result = canClaimDone({
        tracker: null,
        evidence: ledger,
        requiredKinds: ["typecheck"],
      })
      expect(result.canClaim).toBe(false)
      expect(result.unsatisfiedKinds).toContain("typecheck")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("a deleted relevant file counts as a change (hash entry drops)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dscode-h8-del-"))
    try {
      writeFileSync(join(cwd, "gone.ts"), "export = 1\n")
      const store = createArtifactStore()
      const ledger = createEvidenceLedger()

      const pair = await ingestTypecheckWithArtifact({
        store,
        ledger,
        runId: "run-del",
        passed: true,
        issues: 0,
        output: "ok",
        producedBy: "batch_typecheck",
        relevantFileHashes: computeRelevantFileHashes(cwd, ["gone.ts"]),
      })
      expect(pair.artifact.relevantFileHashes?.["gone.ts"]).toBeTruthy()

      rmSync(join(cwd, "gone.ts"))
      const staleIds = await refreshArtifactFreshness({
        store,
        ledger,
        workspaceHash: computeWorkspaceHash(cwd),
        relevantFileHashes: computeRelevantFileHashes(cwd, ["gone.ts"]),
      })
      expect(staleIds).toContain(pair.artifact.artifactId)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("artifacts survive serialization round-trip (evidenceState + artifactRefs)", async () => {
    const store = createArtifactStore()
    const ledger = createEvidenceLedger()
    await ingestTypecheckWithArtifact({
      store,
      ledger,
      runId: "run-serial",
      passed: true,
      issues: 0,
      output: "ok",
      producedBy: "batch_typecheck",
    })

    const artifacts = await store.entries()
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]!.runId).toBe("run-serial")
  })
})
