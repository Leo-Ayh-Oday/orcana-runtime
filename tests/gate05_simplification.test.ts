/**
 * GATE-05 — Gate Simplification（GS-07 + §五/§十三）
 *
 * 1. Quality heuristic 不再是 completion blocker（GS-07）：CSS 量级、
 *    @media、hero 结构、测试结构等移出 missingTaskRequirements；
 *    QualityGate 降级 advisory，不得阻止结束。
 * 2. GateOverflow 删除（断环职责并入 ProgressGovernor——GATE-03）。
 * 3. ContextBudget 60% 硬切 → 分级：degraded/compact/aggressive/
 *    CONTEXT_EXHAUSTED（§十三）。
 */

import { describe, expect, test } from "bun:test"
import { ContextBudgetGate } from "../src/agent/gates/context-budget"
import { QualityGate } from "../src/agent/gates/sync-completion-chain"
import type { CompletionContext } from "../src/agent/gates/contexts"
import { createTaskTracker, markPlanAccepted, missingTaskRequirements } from "../src/agent/task-tracker"
import { ConfidenceEvaluator } from "../src/evaluator/confidence"

// ── §十三：ContextBudget 分级 ──

function budgetCtx(roundInputTokens: number, contextMax: number) {
  const ctx: any = {
    roundInputTokens,
    contextMax,
    contextBudgetPercent: 0,
    contextBudgetMode: "normal" as string,
    budgetMessage: null as { role: string; content: string } | null,
  }
  return ctx
}

describe("ContextBudget 分级（§十三，GATE-05）", () => {
  test("60% 不再硬切 —— degraded/compact/aggressive 都是建议而非 block", () => {
    const gate = new ContextBudgetGate()
    // 60%：旧行为是硬 block；现在只是 degraded 建议（0.5-0.65 区间）
    const c60 = budgetCtx(Math.round(0.6 * 100_000), 100_000)
    const r60 = gate.evaluate(c60)
    expect(r60.pass).toBe(true)
    expect(c60.contextBudgetMode).toBe("degraded")
    // 70%：compact 建议（0.65-0.8 区间）
    const c70 = budgetCtx(70_000, 100_000)
    const r70 = gate.evaluate(c70)
    expect(r70.pass).toBe(true)
    expect(c70.contextBudgetMode).toBe("compact")
    expect(c70.budgetMessage.content).toContain("主动压缩")
  })

  test("分级边界：0.5-0.65 degraded / 0.65-0.8 compact / 0.8-0.9 aggressive / >=0.9 block", () => {
    const gate = new ContextBudgetGate()
    const c50 = budgetCtx(50_000, 100_000)
    gate.evaluate(c50)
    expect(c50.contextBudgetMode).toBe("degraded")

    const c65 = budgetCtx(65_000, 100_000)
    gate.evaluate(c65)
    expect(c65.contextBudgetMode).toBe("compact")

    const c80 = budgetCtx(80_000, 100_000)
    gate.evaluate(c80)
    expect(c80.contextBudgetMode).toBe("aggressive")
    expect(c80.budgetMessage.content).toContain("激进削减")

    // 硬门只存在于安全线（默认 0.9）：下一次调用无法保证最小动作空间
    const c90 = budgetCtx(90_000, 100_000)
    const r90 = gate.evaluate(c90)
    expect(r90.pass).toBe(false)
    expect(c90.contextBudgetMode).toBe("block")
  })

  test("env 覆盖 blockRatio 仍可强制提前 block（测试/降级用）", () => {
    const gate = new ContextBudgetGate(0.5, 0.000002)
    const ctx = budgetCtx(1_000, 100_000)
    const result = gate.evaluate(ctx)
    expect(result.pass).toBe(false)
    expect(ctx.contextBudgetMode).toBe("block")
  })
})

// ── GS-07：quality 启发式不再 block ──

describe("GS-07 — quality heuristic 不是 completion blocker", () => {
  test("missingTaskRequirements 不再包含 frontend/backend 质量发现", () => {
    const tracker = createTaskTracker("Build a React Vite frontend page", "long_task")!
    markPlanAccepted(tracker)
    // 未提供任何前端文件 —— 旧行为会产生"CSS 太薄"等发现
    const missing = missingTaskRequirements(tracker)
    expect(missing.some(item => item.includes("设计不足"))).toBe(false)
    expect(missing.some(item => item.includes("质量不足"))).toBe(false)
  })
})

// ── QualityGate → advisory ──

describe("QualityGate 降级 advisory（§六）", () => {
  function ctx(overrides: Partial<CompletionContext>): CompletionContext {
    return {
      round: 5,
      finalText: "done",
      intentPolicy: { mode: "coder", reason: "t" },
      taskTracker: null,
      pendingRippleObligations: [],
      taskHadWrite: true,
      taskToolErrors: 2,
      taskModifiedFiles: 1,
      lastTypecheck: { passed: false, issues: 5 },
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
  }

  test("typecheck 失败 + 错误多 → 只记 advisory，不阻断完成", () => {
    const c = ctx({})
    const result = new QualityGate().evaluate(c)
    // 旧行为：shouldContinue → continue_（注入消息阻止结束）
    // 新行为：pass + advisory status（验证失败由 EvidenceGate 裁决）
    expect(result.pass).toBe(true)
    expect(c.injectMessages).toHaveLength(0)
    expect(c.statusMessage).toContain("quality-advisory")
  })

  test("健康状态 → pass 且无 advisory", () => {
    const c = ctx({
      taskToolErrors: 0,
      lastTypecheck: { passed: true, issues: 0 },
    })
    const result = new QualityGate().evaluate(c)
    expect(result.pass).toBe(true)
    expect(c.statusMessage).toBe("")
  })
})
