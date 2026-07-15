import { describe, expect, test } from "bun:test"
import { CompletionOrchestrator, checkNarrowEditCompletion } from "../src/agent/completion-orchestrator"
import { createEvidenceLedger, addEvidence } from "../src/agent/evidence-ledger"
import { FlashJudge, TestimonyLedger } from "../src/agent/flash-judge"
import { setActiveMode } from "../src/agent/mode-contract"
import { ConfidenceEvaluator } from "../src/evaluator/confidence"
import type { CompletionOrchestratorInput } from "../src/agent/completion-orchestrator"
import type { TaskTracker } from "../src/agent/task-tracker"
import type { LLMProvider, StreamEvent } from "../src/provider/types"
import { recordRuntimeFileWrite, resetRuntimeFileStateLedger } from "../src/file-state"

const quietProvider: LLMProvider = {
  async *streamChat(): AsyncGenerator<StreamEvent> {
    yield { type: "text", data: "{}" }
  },
}

function input(overrides: Partial<CompletionOrchestratorInput> = {}): CompletionOrchestratorInput {
  setActiveMode("coder")
  return {
    round: 0,
    finalText: "Done.",
    intentPolicy: { mode: "readonly", reason: "test" },
    taskTracker: null,
    pendingRippleObligations: [],
    verificationResults: [],
    changedFiles: [],
    taskHadWrite: false,
    taskToolErrors: 0,
    taskModifiedFiles: 0,
    lastRippleReports: [],
    planApproved: false,
    planningRejections: 0,
    maxRounds: 1,
    priorTools: [],
    priorFiles: new Set(),
    confidenceEvaluator: new ConfidenceEvaluator(),
    evidenceLedger: createEvidenceLedger(),
    testimonyLedger: new TestimonyLedger(),
    flashJudge: new FlashJudge(quietProvider, "test"),
    masterPlan: null,
    autoApprovePlan: false,
    ...overrides,
  }
}

function tracker(overrides: Partial<TaskTracker> = {}): TaskTracker {
  return {
    goal: "test goal",
    intent: "narrow_edit",
    phase: "building",
    requiredFiles: [],
    requiredVerificationKinds: ["typecheck"],
    verificationEvidence: {},
    verification: ["typecheck"],
    steps: [{ id: "s1", title: "apply edit", status: "done" }],
    ...overrides,
  }
}

describe("CompletionOrchestrator truthfulness gate", () => {
  test("blocks final completion when verification claim lacks evidence", async () => {
    const result = await new CompletionOrchestrator().evaluate(input({
      finalText: "Typecheck passed. Task complete.",
    }))

    expect(result.decision).toBe("break_blocked")
    expect(result.statusMessages.some(message => message.includes("truthfulness-gate: blocked"))).toBe(true)
    expect(result.yieldTexts.join("\n")).toContain("Completion blocked by truthfulness gate")
  })

  test("blocks implementation claims when no write evidence exists", async () => {
    const result = await new CompletionOrchestrator().evaluate(input({
      finalText: "\u5df2\u5b9e\u73b0\u7528\u6237\u8bf7\u6c42\u7684\u529f\u80fd\u3002",
    }))

    expect(result.decision).toBe("break_blocked")
    expect(result.yieldTexts.join("\n")).toContain("\u6ca1\u6709\u5199\u5165\u5de5\u5177\u6267\u884c\u8bb0\u5f55")
  })

  test("allows implementation and verification claims when backed by runtime evidence", async () => {
    const ledger = createEvidenceLedger()
    addEvidence(ledger, {
      id: "evi_typecheck",
      kind: "typecheck",
      command: "typecheck",
      output: "ok",
      passed: true,
      timestamp: Date.now(),
      generation: 0,
    })

    const result = await new CompletionOrchestrator().evaluate(input({
      finalText: "\u5df2\u5b9e\u73b0\u7528\u6237\u8bf7\u6c42\u7684\u529f\u80fd\u3002Typecheck passed.",
      taskHadWrite: true,
      taskModifiedFiles: 1,
      changedFiles: ["src/ok.ts"],
      verificationResults: [{ kind: "typecheck", command: "typecheck", passed: true, issues: 0, durationMs: 1, summary: "ok" }],
      lastTypecheck: { passed: true, issues: 0 },
      evidenceLedger: ledger,
    }))

    expect(result.decision).toBe("done")
    expect(result.statusMessages).toContain("evidence-gate: passed")
  })

  test("blocks verification claims backed only by evidence from an older write generation", async () => {
    resetRuntimeFileStateLedger()
    const ledger = createEvidenceLedger()
    addEvidence(ledger, {
      id: "evi_stale_typecheck",
      kind: "typecheck",
      command: "typecheck",
      output: "ok",
      passed: true,
      timestamp: Date.now(),
      generation: 0,
    })
    recordRuntimeFileWrite({ path: "src/after-verification.ts", content: "export const changed = true\n" })

    const result = await new CompletionOrchestrator().evaluate(input({
      finalText: "Typecheck passed.",
      evidenceLedger: ledger,
    }))

    expect(result.decision).toBe("break_blocked")
    expect(result.statusMessages).toContain("truthfulness-gate: blocked (1 contradictions)")
  })
})

describe("checkNarrowEditCompletion", () => {
  test("blocks stale evidence when narrow edit has no task tracker", () => {
    resetRuntimeFileStateLedger()
    const ledger = createEvidenceLedger()
    addEvidence(ledger, {
      id: "evi_stale",
      kind: "typecheck",
      command: "typecheck",
      output: "ok",
      passed: true,
      timestamp: Date.now(),
      generation: 0,
    })
    recordRuntimeFileWrite({ path: "src/after-typecheck.ts", content: "export const changed = true\n" })

    const result = checkNarrowEditCompletion({
      autoFinishOnVerifiedWrite: true,
      intentMode: "narrow_edit",
      hadTsWriteThisRound: true,
      blockingObligations: 0,
      lastTypecheckPassed: true,
      missingNarrowFiles: [],
      modifiedFilesThisRound: new Set(["src/after-typecheck.ts"]),
      taskTracker: null,
      evidenceLedger: ledger,
    })

    expect(result.completionText).toBeNull()
    expect(result.evidenceMissing).toContain("缺少验证证据: 类型检查")
  })

  test("blocks verified-write auto-complete when structured evidence is missing", () => {
    const result = checkNarrowEditCompletion({
      autoFinishOnVerifiedWrite: true,
      intentMode: "narrow_edit",
      hadTsWriteThisRound: true,
      blockingObligations: 0,
      lastTypecheckPassed: true,
      missingNarrowFiles: [],
      modifiedFilesThisRound: new Set(["src/ok.ts"]),
      taskTracker: tracker(),
      evidenceLedger: createEvidenceLedger(),
    })

    expect(result.completionText).toBeNull()
    expect(result.evidenceStatus).toBe("evidence-gate: narrow_edit blocked (1 missing)")
    expect(result.evidencePrompt).not.toBeNull()
    expect(result.evidenceMissing).toHaveLength(1)
  })

  test("allows verified-write auto-complete when structured evidence is present", () => {
    resetRuntimeFileStateLedger()
    const ledger = createEvidenceLedger()
    addEvidence(ledger, {
      id: "evi_typecheck",
      kind: "typecheck",
      command: "typecheck",
      output: "ok",
      passed: true,
      timestamp: Date.now(),
      generation: 0,
    })

    const result = checkNarrowEditCompletion({
      autoFinishOnVerifiedWrite: true,
      intentMode: "narrow_edit",
      hadTsWriteThisRound: true,
      blockingObligations: 0,
      lastTypecheckPassed: true,
      missingNarrowFiles: [],
      modifiedFilesThisRound: new Set(["src/ok.ts"]),
      taskTracker: null,
      evidenceLedger: ledger,
    })

    expect(result.completionText).toContain("Changed files: src/ok.ts")
    expect(result.evidencePrompt).toBeNull()
  })
})
