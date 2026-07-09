import { describe, expect, test } from "bun:test"
import { CompletionOrchestrator } from "../src/agent/completion-orchestrator"
import { createEvidenceLedger, addEvidence } from "../src/agent/evidence-ledger"
import { FlashJudge, TestimonyLedger } from "../src/agent/flash-judge"
import { setActiveMode } from "../src/agent/mode-contract"
import { ConfidenceEvaluator } from "../src/evaluator/confidence"
import type { CompletionOrchestratorInput } from "../src/agent/completion-orchestrator"
import type { LLMProvider, StreamEvent } from "../src/provider/types"

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
})
