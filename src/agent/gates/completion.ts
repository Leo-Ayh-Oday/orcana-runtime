/** Completion gates: evaluated in sequence when agent has no tool calls + finalText.
 *
 *  Each gate can:
 *    - PASS (action="pass"): proceed to next gate
 *    - CONTINUE (action="continue"): inject messages into rawMessages, yield status, restart while loop
 *    - BREAK (action="break"): exit the agent loop
 *
 *  The orchestration layer (loop.ts) reads ctx.injectMessages, ctx.statusMessage,
 *  ctx.traceEvent, and ctx.breakEvent and performs the side effects.
 *
 *  Gates NOT included (kept inline in loop.ts due to async/complex yield):
 *    - CompletionEvidenceGate + FlashJudge (async, complex yield/break)
 *    - Plan approval yield/break (yields plan_ready with structured data)
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

// ── Gate: Ripple Exit ──

export class RippleExitGate implements Gate<CompletionContext> {
  readonly name = "semantic:ripple_exit"

  evaluate(ctx: CompletionContext) {
    if (ctx.intentPolicy.mode === "readonly") return pass(ctx), { pass: true }
    const blocking = getBlockingObligations(ctx.pendingRippleObligations)
    if (blocking.length === 0) return pass(ctx), { pass: true }
    if (ctx.round + 1 >= ctx.maxRounds) return pass(ctx), { pass: true }

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
    if (ctx.round + 1 >= ctx.maxRounds) return pass(ctx), { pass: true }

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

    const planningGate = evaluatePlanningArtifact(ctx.finalText, ctx.taskTracker)
    const assistantMsg = compactAssistantContext(ctx.finalText)

    if (!planningGate.ok) {
      // PR 3: use evaluatePlanForcePass instead of bare forcePlanningPassAfterLimit
      const forceResult = evaluatePlanForcePass({
        rejections: ctx.planningRejections,
        planText: ctx.finalText,
        goal: ctx.taskTracker.goal,
      })

      if (!forceResult.allow) {
        // Still within retry budget — revision needed
        const userMsg = formatPlanningGatePrompt(planningGate, ctx.taskTracker)
        continue_(ctx, "semantic:planning_revise", assistantMsg, userMsg,
          `planning-gate: revise plan (${planningGate.missing.length} missing)`,
          { missing: planningGate.missing, score: planningGate.score })
        ctx.completionBlockMessage = userMsg
        ;(ctx as unknown as Record<string, unknown>)._planningRejected = true
        return { pass: false, reason: "semantic:planning_revise" }
      }

      // Force-pass with minimal viable packet
      ;(ctx as unknown as Record<string, unknown>)._planningForcePass = true
      ;(ctx as unknown as Record<string, unknown>)._planningForcePassPacket = forceResult.fallbackPacket
    }

    // Plan passed (or force-passed with packet)
    ;(ctx as unknown as Record<string, unknown>)._planningPassed = true
    ;(ctx as unknown as Record<string, unknown>)._planningScore = planningGate.score
    ;(ctx as unknown as Record<string, unknown>)._planningSignals = planningGate.signals
    ;(ctx as unknown as Record<string, unknown>)._planningMissing = planningGate.missing

    // Plan ready — yield plan_ready, break for user approval
    // loop.ts handles the yield + break after chain returns
    ctx.shouldBreak = true
    ctx.breakEvent = {
      type: "plan_ready",
      data: {
        planText: ctx.finalText.slice(0, 3000),
        score: planningGate.score,
        signals: planningGate.signals,
        goal: ctx.taskTracker.goal,
        steps: ctx.taskTracker.steps.map(s => ({ id: s.id, title: s.title })),
        requiredFiles: ctx.taskTracker.requiredFiles,
        requiredVerificationKinds: ctx.taskTracker.requiredVerificationKinds,
        missingItems: planningGate.missing,
      },
    }
    ctx.statusMessage = "plan-mode: awaiting user approval"
    ctx.traceEvent = { gate: "planning", decision: "plan_ready", score: planningGate.score }
    return { pass: false, reason: "semantic:planning_ready" }
  }
}

// ── Gate: Task Tracker Completion ──

export class TaskTrackerCompletionGate implements Gate<CompletionContext> {
  readonly name = "semantic:task_tracker"

  evaluate(ctx: CompletionContext) {
    const missing = missingTaskRequirements(ctx.taskTracker)
    if (!ctx.taskTracker || taskTrackerComplete(ctx.taskTracker) || missing.length === 0) return pass(ctx), { pass: true }
    if (ctx.round + 1 >= ctx.maxRounds) return pass(ctx), { pass: true }

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
    if (ctx.round + 1 >= ctx.maxRounds) return pass(ctx), { pass: true }

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

    if (!shouldContinue) return pass(ctx), { pass: true }

    const assistantMsg = compactAssistantContext(ctx.finalText)
    const userMsg = formatQualityGatePrompt({ confidence, contractMessages, signals })
    continue_(ctx, "semantic:quality", assistantMsg, userMsg,
      `quality-gate: ${confidence.recommendation} ${Math.round(confidence.confidence * 100)}%`,
      { confidence: confidence.recommendation })
    ctx.completionBlockMessage = userMsg
    return { pass: false, reason: "semantic:quality" }
  }
}

// ── Convenience: default completion chain (without Flash Judge — handled inline) ──

import { GateChain } from "./chain"

export function createCompletionChain(): GateChain<CompletionContext> {
  return GateChain.pipe([
    new RippleExitGate(),
    new PlanningArtifactGate(),
    new TaskTrackerCompletionGate(),
    new QualityGate(),
  ])
}
