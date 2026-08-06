/** RC-02 故障矩阵：completion 三态语义（A3 未来时态按句 / A4 末轮 incomplete）。 */

import { afterEach, describe, expect, test } from "bun:test"
import { CompletionOrchestrator } from "../src/agent/completion-orchestrator"
import { createEvidenceLedger, addEvidence } from "../src/agent/evidence-ledger"
import { FlashJudge, TestimonyLedger } from "../src/agent/flash-judge"
import { setActiveMode } from "../src/agent/mode-contract"
import { ConfidenceEvaluator } from "../src/evaluator/confidence"
import type { CompletionOrchestratorInput } from "../src/agent/completion-orchestrator"
import type { LLMProvider, StreamEvent } from "../src/provider/types"
import { resetRuntimeFileStateLedger } from "../src/file-state"

afterEach(() => {
  resetRuntimeFileStateLedger()
})

const quietProvider: LLMProvider = {
  async *streamChat(): AsyncGenerator<StreamEvent> {
    yield { type: "text", data: '{"verdict":"SATISFIED","gaps":[],"evidence_found":["tsc evidence"]}' }
  },
}

function input(overrides: Partial<CompletionOrchestratorInput> = {}): CompletionOrchestratorInput {
  setActiveMode("coder")
  return {
    round: 0,
    finalText: "Done.",
    intentPolicy: { mode: "building", reason: "test" },
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

describe("RC-02 A3 truth claims per-sentence", () => {
  test("future-tense sentence does not skip completed claims in other sentences", async () => {
    const orch = new CompletionOrchestrator()
    const ledger = createEvidenceLedger()
    // 有通过证据：类型检查确实通过
    addEvidence(ledger, {
      id: "e1",
      kind: "typecheck",
      output: "tsc ok",
      passed: true,
      issues: 0,
      timestamp: Date.now(),
    })
    const text = "我已修复类型错误并运行了 tsc，类型检查通过。下一步我会补充文档。"
    const result = await orch.evaluate(input({
      round: 0,
      maxRounds: 10,
      finalText: text,
      evidenceLedger: ledger,
      taskHadWrite: false,
      changedFiles: [],
    }))
    // 已完成声明（typecheck 通过）被检查且有证据支撑 → 不 block
    expect(result.decision).not.toBe("break_blocked")
  })

  test("false completion claim still blocked despite future-tense sentence", async () => {
    const orch = new CompletionOrchestrator()
    const ledger = createEvidenceLedger()
    // 无 typecheck 通过证据
    const text = "类型检查通过。下一步准备打包发布。"
    const result = await orch.evaluate(input({
      round: 9,
      maxRounds: 10,
      finalText: text,
      evidenceLedger: ledger,
      taskHadWrite: false,
      changedFiles: [],
    }))
    // 完成的 tsc 声明无证据 → 必须 block（旧实现因"下一步"整段跳过）
    expect(result.decision).toBe("break_blocked")
  })
})

describe("RC-02 A4 budget exhausted ≠ completed", () => {
  test("final round with no passing evidence → incomplete, not continue", async () => {
    const orch = new CompletionOrchestrator()
    const ledger = createEvidenceLedger()
    addEvidence(ledger, {
      id: "e2",
      kind: "typecheck",
      output: "tsc found 3 errors",
      passed: false,
      issues: 3,
      timestamp: Date.now(),
    })
    const result = await orch.evaluate(input({
      round: 9,
      maxRounds: 10,
      finalText: "I couldn't finish.",
      evidenceLedger: ledger,
      taskHadWrite: true,
      taskToolErrors: 2,
      taskModifiedFiles: 1,
      changedFiles: ["a.ts"],
    }))
    // 末轮无通过证据：incomplete → break_blocked（不再注入"继续修复"消息）
    expect(result.decision).toBe("break_blocked")
    const status = result.statusMessages.join(" ")
    expect(status).toContain("budget_exhausted")
  })

  test("final round with passing evidence → completes normally", async () => {
    const orch = new CompletionOrchestrator()
    const ledger = createEvidenceLedger()
    addEvidence(ledger, {
      id: "e3",
      kind: "typecheck",
      output: "tsc ok",
      passed: true,
      issues: 0,
      timestamp: Date.now(),
    })
    const result = await orch.evaluate(input({
      round: 9,
      maxRounds: 10,
      finalText: "All done.",
      evidenceLedger: ledger,
      taskHadWrite: false,
      taskToolErrors: 0,
      taskModifiedFiles: 0,
      changedFiles: [],
    }))
    expect(result.decision).not.toBe("break_blocked")
  })
})
