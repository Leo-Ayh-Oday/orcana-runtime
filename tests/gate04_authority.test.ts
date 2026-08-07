/**
 * GATE-04 — Completion Authority Collapse（GS-06）
 *
 * 1. missingTaskRequirements 每轮只构造一次，TaskTracker gate /
 *    ExternalCompletionGate / FlashJudge 全部读取同一份快照——
 *    同一 obligation 每轮只能由一个 authority 裁决。
 * 2. Truthfulness gate 确定性降级：矛盾 → INCOMPLETE 终止，
 *    不再花一轮 LLM token 让模型"诚实一点"（§十二）。
 */

import { describe, expect, test } from "bun:test"
import { CompletionOrchestrator } from "../src/agent/completion-orchestrator"
import { TaskTrackerCompletionGate } from "../src/agent/gates/sync-completion-chain"
import type { CompletionContext } from "../src/agent/gates/contexts"
import { createEvidenceLedger, addEvidence } from "../src/agent/evidence-ledger"
import { FlashJudge, TestimonyLedger } from "../src/agent/flash-judge"
import { ConfidenceEvaluator } from "../src/evaluator/confidence"
import type { TaskTracker } from "../src/agent/task-tracker"

// ── GS-06：TaskTracker gate 读取 orchestrator 快照 ──

function completionContext(overrides: Partial<CompletionContext>): CompletionContext {
  const base: CompletionContext = {
    round: 0,
    finalText: "done",
    intentPolicy: { mode: "coder", reason: "test" },
    taskTracker: null,
    pendingRippleObligations: [],
    taskHadWrite: true,
    taskToolErrors: 0,
    taskModifiedFiles: 0,
    lastTypecheck: undefined,
    lastRippleReports: [],
    lastVerificationResults: [],
    planApproved: false,
    planningRejections: 0,
    maxRounds: 10,
    priorTools: [],
    priorFiles: new Set(),
    confidenceEvaluator: new ConfidenceEvaluator(),
    completionBlockMessage: null,
    shouldBreak: false,
    breakEvent: null,
    statusMessage: "",
    injectMessages: [],
    traceEvent: null,
    ...overrides,
  }
  return base
}

describe("GS-06 — 同一 obligation 每轮只有一个 authority", () => {
  test("TaskTrackerCompletionGate 使用 ctx 快照，不重新推导", () => {
    // tracker 本身完全完成（重新推导会是空缺失）——但快照说还有缺失项。
    // 快照是权威：gate 必须按快照 continue。
    const tracker: TaskTracker = {
      goal: "g",
      intent: "long_task",
      phase: "building",
      requiredFiles: [],
      requiredVerificationKinds: [],
      verificationEvidence: {},
      verification: [],
      steps: [{ id: "s1", title: "done step", status: "done" }],
    }
    const ctx = completionContext({
      taskTracker: tracker,
      missingTaskRequirements: ["快照声称的缺失项：外部注入"],
    })
    const result = new TaskTrackerCompletionGate().evaluate(ctx)
    expect(result.pass).toBe(false)
    expect(result.reason).toBe("semantic:task_tracker")
    const injected = ctx.injectMessages.map(m => m.content).join(" ")
    expect(injected).toContain("快照声称的缺失项：外部注入")
  })

  test("orchestrator 全流程在同一快照下裁决（external + flash 共享）", async () => {
    const ledger = createEvidenceLedger()
    addEvidence(ledger, {
      id: "e1", kind: "typecheck", output: "ok", passed: true, issues: 0, timestamp: Date.now(),
    })
    const orch = new CompletionOrchestrator()
    // tracker 有未完成步骤 + 有 typecheck 证据 —— external gate 的 missing
    // 与 TaskTracker gate 的 missing 必须一致（同一快照），先被 TaskTracker
    // 拦截 → continue（而不是 evidence accepted → done）。
    const tracker: TaskTracker = {
      goal: "g",
      intent: "long_task",
      phase: "building",
      requiredFiles: [],
      requiredVerificationKinds: ["typecheck"],
      verificationEvidence: { typecheck: "tsc ok" },
      verification: ["typecheck"],
      steps: [
        { id: "s1", title: "unfinished step", status: "pending" },
      ],
    }
    const result = await orch.evaluate({
      round: 0,
      finalText: "类型检查通过。",
      intentPolicy: { mode: "coder", reason: "test" },
      taskTracker: tracker,
      pendingRippleObligations: [],
      verificationResults: [],
      changedFiles: [],
      taskHadWrite: true,
      taskToolErrors: 0,
      taskModifiedFiles: 1,
      lastRippleReports: [],
      planApproved: false,
      planningRejections: 0,
      maxRounds: 10,
      priorTools: [],
      priorFiles: new Set(),
      confidenceEvaluator: new ConfidenceEvaluator(),
      evidenceLedger: ledger,
      testimonyLedger: new TestimonyLedger(),
      flashJudge: new FlashJudge(undefined as never, "test"),
      masterPlan: null,
      autoApprovePlan: false,
    })
    // TaskTracker 阻止（未完成步骤）——同一快照下 external gate 不会先放行
    expect(result.decision).toBe("continue")
    expect(result.statusMessages.join(" ")).toContain("任务追踪")
  })
})

// ── §十二：Truthfulness 确定性降级 ──

describe("Truthfulness gate 确定性降级（§十二）", () => {
  test("非末轮矛盾也直接 INCOMPLETE 终止，不再注入提示重跑", async () => {
    const ledger = createEvidenceLedger() // 无 typecheck 证据
    const orch = new CompletionOrchestrator()
    const result = await orch.evaluate({
      round: 0, // 大量轮次剩余——旧行为会 continue 让模型"诚实一点"
      maxRounds: 10,
      finalText: "Typecheck passed.",
      intentPolicy: { mode: "coder", reason: "test" },
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
      priorTools: [],
      priorFiles: new Set(),
      confidenceEvaluator: new ConfidenceEvaluator(),
      evidenceLedger: ledger,
      testimonyLedger: new TestimonyLedger(),
      flashJudge: new FlashJudge(undefined as never, "test"),
      masterPlan: null,
      autoApprovePlan: false,
    })
    expect(result.decision).toBe("break_blocked")
    expect(result.injectMessages).toHaveLength(0) // 不注入修复提示
    expect(result.yieldTexts.join("\n")).toContain("INCOMPLETE")
    expect(result.traceEvents.some(t => t.gate === "semantic:truthfulness" && t.decision === "incomplete")).toBe(true)
  })
})
