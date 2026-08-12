/** Sync Completion Chain (Phase 1) — synchronous gates evaluated in sequence
 *  when agent has no tool calls + finalText.
 *
 *  Each gate can:
 *    - PASS (action="pass"): proceed to next gate
 *    - CONTINUE (action="continue"): inject messages into rawMessages, yield status, restart while loop
 *    - BREAK (action="break"): exit the agent loop
 *
 *  The orchestration layer (CompletionOrchestrator) reads ctx.injectMessages,
 *  ctx.statusMessage, ctx.traceEvent, and ctx.breakEvent and performs the side effects.
 *
 *  Gates NOT included (kept in CompletionOrchestrator due to async/complex yield):
 *    - CompletionEvidenceGate + FlashJudge (async, complex yield/break)
 *    - Plan approval yield/break (yields plan_ready with structured data)
 *
 *  Renamed from gates/completion.ts to distinguish from completion-gate.ts
 *  (which is now external-completion-gate.ts).
 */

import type { Gate } from "./types"
import type { CompletionContext } from "./contexts"
import { compactAssistantContext, buildAgentContractContext, formatQualityGatePrompt } from "../round/helpers"
import { evaluatePlanningArtifact, forcePlanningPassAfterLimit, formatPlanningGatePrompt } from "../planning-gate"
import { evaluatePlanForcePass } from "../plan-validator"
import type { TaskPacket } from "../task-packet"
import { markPlanAccepted, missingTaskRequirements, taskTrackerComplete, formatTaskTrackerPrompt } from "../task-tracker"
import { formatRippleExitGateCallers } from "../../ripple/engine"
import { getBlockingObligations } from "../../ripple/obligations"
import { validateContracts } from "../contracts"
import { AgentState } from "../state-machine"
import type { ObjectiveSignals } from "../../evaluator/types"

// ── Result helpers (mutate ctx + return GateResult) ──

function pass(ctx: CompletionContext): void {
  ctx.injectMessages = []
}

function continue_(ctx: CompletionContext, reason: string, assistantMsg: string, userMsg: string, status: string, trace?: Record<string, unknown>): void {
  ctx.injectMessages = [
    { role: "assistant", content: assistantMsg },
    { role: "user", content: userMsg },
  ]
  ctx.statusMessage = status
  ctx.traceEvent = trace ? { gate: reason, decision: "continue", ...trace } : null
}


// ── RC-02: 末轮语义 — BUDGET_EXHAUSTED ≠ COMPLETED ──

/** 末轮且无通过证据 → incomplete（不能继续 ≠ 已经完成）。 */
function finalRoundNoEvidence(ctx: CompletionContext): { pass: true } | { pass: false; reason: string; incomplete: true } {
  const hasPassingEvidence =
    ctx.lastTypecheck?.passed === true ||
    (ctx.lastVerificationResults?.some(r => r.passed) ?? false)
  if (hasPassingEvidence) return { pass: true }
  ctx.injectMessages = []
  return { pass: false, reason: "budget_exhausted_no_evidence", incomplete: true }
}

// ── Gate: Ripple Exit ──

export class RippleExitGate implements Gate<CompletionContext> {
  readonly name = "semantic:ripple_exit"

  evaluate(ctx: CompletionContext) {
    if (ctx.intentPolicy.mode === "readonly") return pass(ctx), { pass: true }
    const blocking = getBlockingObligations(ctx.pendingRippleObligations)
    if (blocking.length === 0) return pass(ctx), { pass: true }
    if (ctx.round + 1 >= ctx.maxRounds) return finalRoundNoEvidence(ctx)

    const assistantMsg = compactAssistantContext(ctx.finalText)
    const userMsg = formatRippleExitGateCallers(
      blocking.map(o => ({ caller: o.caller, symbol: o.symbol }))
    )
    continue_(ctx, "semantic:ripple_exit", assistantMsg, userMsg,
      `ripple-exit-gate: pending ${blocking.length}`,
      { pending: blocking.length })
    ctx.completionBlockMessage = userMsg
    return { pass: false, reason: "semantic:ripple_exit" }
  }
}

// ── Gate: Planning Artifact (handles revision + plan_ready) ──

export class PlanningArtifactGate implements Gate<CompletionContext> {
  readonly name = "semantic:planning_artifact"

  evaluate(ctx: CompletionContext) {
    if (!ctx.taskTracker || ctx.taskTracker.phase !== "planning") return pass(ctx), { pass: true }
    if (ctx.round + 1 >= ctx.maxRounds) return finalRoundNoEvidence(ctx)

    // User already confirmed — skip gate, enter execution directly
    if (ctx.planApproved) {
      markPlanAccepted(ctx.taskTracker)
      const assistantMsg = compactAssistantContext(ctx.finalText)
      const userMsg = formatTaskTrackerPrompt(ctx.taskTracker)
      continue_(ctx, "semantic:planning_accepted", assistantMsg, userMsg,
        "任务追踪: 用户已确认规划，进入执行阶段",
        { decision: "accepted" })
      ctx.completionBlockMessage = userMsg
      // Signal loop.ts to reset planApproved + planningRejections
      ctx.shouldBreak = false  // continue, not break
      return { pass: false, reason: "semantic:planning_accepted" }
    }

    // IC05 Correction P0-B: planning quality 是 advisory，不是 execution
    // authorization。普通 execution intent（mode != readonly）下：
    //  - 评估计划只做 advisory telemetry（score/missing/signals）
    //  - 计划 artifact 消费 → transition building
    //  - 绝不 semantic:planning_revise（无强制修订循环）
    //  - 绝不 plan_ready / mandatory approval pause（Flash heuristic 不能
    //    触发 plan_ready；approval 只由显式 planApproved user state 触发）
    const planningGate = evaluatePlanningArtifact(ctx.finalText, ctx.taskTracker)
    markPlanAccepted(ctx.taskTracker)
    ;(ctx as unknown as Record<string, unknown>)._planningPassed = true
    ;(ctx as unknown as Record<string, unknown>)._planningScore = planningGate.score
    ;(ctx as unknown as Record<string, unknown>)._planningSignals = planningGate.signals
    ;(ctx as unknown as Record<string, unknown>)._planningMissing = planningGate.missing

    ctx.shouldBreak = false
    ctx.statusMessage = `planning-advisory: score ${planningGate.score}/8${planningGate.missing.length ? ` (${planningGate.missing.length} missing)` : ""}`
    ctx.traceEvent = {
      gate: "planning",
      authority: "advisory",
      decision: "advisory",
      score: planningGate.score,
      missing: planningGate.missing,
      signals: planningGate.signals,
    }
    // 直接继续执行（不 block completion；后续 TaskTracker/Evidence gate
    // 决定完成）。
    return { pass: true }
  }
}

// ── Gate: ContextDebt（IC05 P6: obligation —— open debt 禁止 DONE）──

export class ContextDebtCompletionGate implements Gate<CompletionContext> {
  readonly name = "semantic:context_debt"

  evaluate(ctx: CompletionContext) {
    const debts = ctx.contextDebts
    const open = debts?.filter(d => d.status === "open") ?? []
    if (open.length === 0) return { pass: true }
    // IC05 Correction P0-C: open ContextDebt 时 DONE 永远不可能 —— 无论
    // typecheck/tests/build 等 evidence 是否通过。最后一轮也必须
    // pass=false / incomplete（绝不复用 finalRoundNoEvidence —— 它可能
    // 因其他 evidence PASS 而放行）。CONTEXT_DEBT_COMPLETION_BYPASS=0。
    if (ctx.round + 1 >= ctx.maxRounds) {
      return { pass: false, reason: "semantic:context_debt", incomplete: true }
    }
    const lines = open.map(d => `${d.id} (${d.kind}): ${d.requiredAction}`).join("\n")
    const userMsg = `## ContextDebt 未偿还\nDONE 前需要以下客观上下文证据（advisory 不阻断写，但完成前必须偿还）：\n\n${lines}`
    continue_(ctx, "semantic:context_debt", compactAssistantContext(ctx.finalText), userMsg,
      `context-debt: ${open.length} open (${open.map(d => d.kind).join(", ")})`,
      { openDebts: open.map(d => d.kind), authority: "obligation" })
    ctx.completionBlockMessage = userMsg
    return { pass: false, reason: "semantic:context_debt" }
  }
}

// ── Gate: Task Tracker Completion ──

export class TaskTrackerCompletionGate implements Gate<CompletionContext> {
  readonly name = "semantic:task_tracker"

  evaluate(ctx: CompletionContext) {
    // GATE-04 (GS-06)：同一 obligation 每轮只由一个 authority 裁决——
    // 使用 orchestrator 构造的快照，不再自行重新推导。
    const missing = ctx.missingTaskRequirements ?? missingTaskRequirements(ctx.taskTracker)
    if (!ctx.taskTracker || taskTrackerComplete(ctx.taskTracker) || missing.length === 0) return pass(ctx), { pass: true }
    if (ctx.round + 1 >= ctx.maxRounds) return finalRoundNoEvidence(ctx)

    const assistantMsg = compactAssistantContext(ctx.finalText)
    const userMsg = [
      "## 任务追踪未完成",
      "你现在不能结束。下面这些项目仍然没有完成：",
      ...missing.slice(0, 12).map(item => `- ${item}`),
      "",
      "请继续执行第一个未完成项。不要输出最终总结，除非清单全部完成并完成验证。",
    ].join("\n")

    continue_(ctx, "semantic:task_tracker", assistantMsg, userMsg,
      `任务追踪: 仍有 ${missing.length} 项未完成，继续执行`,
      { missing: missing.length })
    ctx.completionBlockMessage = userMsg
    return { pass: false, reason: "semantic:task_tracker" }
  }
}

// ── Gate: Quality (Confidence + Contracts) ──

export class QualityGate implements Gate<CompletionContext> {
  readonly name = "semantic:quality"

  evaluate(ctx: CompletionContext) {
    if (ctx.intentPolicy.mode === "readonly") return pass(ctx), { pass: true }
    if (!ctx.taskHadWrite && ctx.taskToolErrors === 0) return pass(ctx), { pass: true }
    if (ctx.round + 1 >= ctx.maxRounds) return finalRoundNoEvidence(ctx)

    // Build signals from context
    const rippleDecision = ctx.lastRippleReports.some(r => r.decision === "block") ? "block" as const
      : ctx.lastRippleReports.some(r => r.decision === "warn") ? "warn" as const
      : ctx.lastRippleReports.length > 0 ? "allow" as const
      : undefined

    const latestTest = [...ctx.lastVerificationResults].reverse().find(r => r.kind === "test")
    const signals: ObjectiveSignals = {
      testResults: latestTest ? {
        passed: latestTest.passed ? 1 : 0,
        failed: latestTest.passed ? 0 : Math.max(1, latestTest.issues),
        total: latestTest.passed ? 1 : Math.max(1, latestTest.issues),
        output: latestTest.summary,
      } : undefined,
      typecheck: ctx.lastTypecheck,
      rippleDecision,
      toolErrors: ctx.taskToolErrors,
      filesChanged: ctx.taskModifiedFiles,
    }

    const confidence = ctx.confidenceEvaluator.evaluateSync(signals)
    const contractContext = buildAgentContractContext({
      round: ctx.round,
      priorTools: ctx.priorTools,
      priorFiles: ctx.priorFiles,
      toolErrors: ctx.taskToolErrors,
      modifiedFiles: ctx.taskModifiedFiles,
    })
    const contractResult = validateContracts(contractContext, AgentState.DONE)
    const contractMessages = contractResult.violations.map(v => v.message)

    const shouldContinue =
      confidence.recommendation === "retry" ||
      contractResult.fatal.length > 0 ||
      Boolean(ctx.lastTypecheck && !ctx.lastTypecheck.passed)

    // GATE-05 (GS-07): QualityGate 降级为 advisory——confidence 推荐、契约
    // 违反、typecheck 失败都不再阻断完成（那是 EvidenceGate/验证门的职责，
    // 此处重复裁决同一事实）。只记录 advisory 状态，永不让"质量启发式"拥有
    // 阻止结束的权力。
    if (shouldContinue) {
      ctx.statusMessage = `quality-advisory: ${confidence.recommendation} ${Math.round(confidence.confidence * 100)}%${contractMessages.length > 0 ? ` · ${contractMessages[0]}` : ""}`
    }
    return pass(ctx), { pass: true }
  }
}

// ── Convenience: default completion chain (without Flash Judge — handled inline) ──

import { GateChain } from "./chain"

export function createCompletionChain(): GateChain<CompletionContext> {
  return GateChain.pipe([
    new RippleExitGate(),
    new PlanningArtifactGate(),
    new TaskTrackerCompletionGate(),
    new ContextDebtCompletionGate(),
    new QualityGate(),
  ])
}
