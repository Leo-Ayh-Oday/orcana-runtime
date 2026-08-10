/** Terminal switch (ALK PR-L7): the single place that consumes a LoopDecision.
 *
 *  Every exit of the agent run routes here — through the unified `finally`
 *  in loop.ts — so no path can skip stopReason mapping, telemetry flush or
 *  cleanup. "break" decisions share the completed terminal (round budget
 *  message first, then finished trace, gate telemetry report, flush);
 *  "return" decisions only flush telemetry for the paths that historically
 *  did so (clarification, gate overflow) and never emit the telemetry report.
 *
 *  `ctx` may be null only for the pre-state prompt-blocked exit (no run state
 *  existed yet); the error event and stop reason are still mapped here.
 *
 *  TB2-1: 轮次耗尽 ≠ 完成。round_budget / orchestrator_plan_ready 映射为
 *  paused，context_budget / orchestrator_blocked / empty_round / self_edit
 *  映射为 blocked，provider_failure 映射为 error——只有 completion 门确认
 *  （orchestrator_done / verified_write）才是 completed。paused/blocked/
 *  stalled 终态强制保存 checkpoint（不依赖上下文阈值），checkpointId 随
 *  decision 返回给 harness/CLI 用于 Resume。
 */

import type { StreamEvent } from "../../provider/types"
import type { AgentRunLifecycleState, AgentRunStopReason } from "../run/types"
import { formatRoundBudgetExhausted } from "../round/helpers"
import { flushTelemetry } from "./effects"
import type { LoopDecision, RunPhaseContext } from "./types"
import { buildSessionCheckpoint, formatCheckpointSummary, saveCheckpoint } from "../../session/checkpoint"
import { planProgress } from "../master-plan"

/** TB2-1: 这些终态强制保存 checkpoint（暂停/阻塞/停滞，可恢复）。 */
const FORCE_CHECKPOINT_REASONS: ReadonlySet<string> = new Set([
  "round_budget",
  "orchestrator_plan_ready",
  "context_budget",
  "orchestrator_blocked",
  "empty_round",
  "self_edit",
  "progress_stalled",
])

type BreakReason = Extract<LoopDecision, { kind: "break" }>["reason"]

function stopReasonForBreak(reason: BreakReason): AgentRunStopReason {
  switch (reason) {
    case "orchestrator_done":
    case "verified_write":
      return "completed"
    case "round_budget":
    case "orchestrator_plan_ready":
      return "paused"
    case "progress_stalled":
      return "stalled"
    case "provider_failure":
      return "error"
    default:
      // context_budget / orchestrator_blocked / empty_round / self_edit
      return "blocked"
  }
}

function shouldForceCheckpoint(reason: string): boolean {
  return FORCE_CHECKPOINT_REASONS.has(reason)
}

/** 强制保存一次 recoverable checkpoint，返回 checkpointId（失败返回 null）。 */
function saveForcedRunCheckpoint(ctx: RunPhaseContext): string | null {
  try {
    const sessionId = ctx.runState.identity.sessionId ?? process.env.ORCANA_SESSION_ID ?? "ds-default"
    const round = ctx.lifecycle.finalRound
    const masterPlan = ctx.planStore.current ? {
      goal: ctx.planStore.current.goal,
      nodes: ctx.planStore.current.nodes.map(n => ({ id: n.id, title: n.title, status: n.status })),
      current: ctx.planStore.current.current,
      progress: planProgress(ctx.planStore.current),
    } : (ctx.planning.taskTracker ? { goal: ctx.planning.taskTracker.goal, steps: ctx.planning.taskTracker.steps.map(s => ({ id: s.id, status: s.status, title: s.title })) } : {})
    const taskSteps = ctx.planning.taskTracker?.steps.map(s => ({ id: s.id, status: s.status, title: s.title })) ?? []
    // TB2-1: checkpoint 变更文件只含真正修改的文件（写工具成功），不含只读观察。
    const changedFiles = [...ctx.execution.modifiedFiles]
    const coldMemorySHA = ctx.runState.conversation.stablePrefixHash
    const lastVerification = ctx.verificationState.lastTypecheck
      ? { kind: "typecheck", passed: ctx.verificationState.lastTypecheck.passed, command: "tsc --noEmit" }
      : null
    const conversationTokens = Math.round(ctx.usage.estimatedInputTokens / 1000)
    const cp = buildSessionCheckpoint({
      sessionId,
      round,
      masterPlan,
      taskSteps,
      changedFiles,
      coldMemorySHA,
      lastVerification,
      conversationTokens,
      summary: "",
    })
    cp.summary = formatCheckpointSummary(cp)
    saveCheckpoint(cp)
    ctx.runTrace?.record("checkpoint", { label: "forced", round, checkpointId: cp.checkpointId, reason: "terminal" })
    return cp.checkpointId
  } catch {
    return null
  }
}

export async function* finalizeRun(
  ctx: RunPhaseContext | null,
  decision: LoopDecision,
  lifecycle: AgentRunLifecycleState,
): AsyncGenerator<StreamEvent, void, unknown> {
  if (decision.kind === "return") {
    // Historical per-path side effects, in the same order as pre-L7.
    if (decision.reason === "prompt_blocked") {
      yield { type: "error", data: `Prompt blocked by hook: ${decision.blockReason ?? "unknown"}` }
    }
    if (ctx && decision.reason === "clarification") {
      await flushTelemetry(ctx)
    }
    lifecycle.stopReason =
      decision.reason === "prompt_blocked"
        ? "blocked"
        : decision.reason === "clarification"
          ? "paused"
          : "aborted"
    return
  }

  // "continue" must never reach the terminal; normalize defensively.
  if (decision.kind === "continue") {
    decision = { kind: "break", reason: "round_budget" }
  }
  // A "break" decision always carries a run context; guard for type safety.
  if (!ctx) {
    lifecycle.stopReason = "completed"
    return
  }

  // "break" and the natural round-budget end share the completed terminal.
  if (decision.reason === "round_budget" && ctx.lifecycle.reachedRoundBudget) {
    const message = formatRoundBudgetExhausted(ctx.maxRounds)
    yield { type: "status", data: `round-budget: exhausted ${ctx.maxRounds}` }
    yield { type: "text", data: message }
    ctx.runTrace?.record("gate_decision", { gate: "round_budget", decision: "paused", maxRounds: ctx.maxRounds })
  }

  // TB2-1: paused/blocked/stalled 终态强制保存 checkpoint（不依赖上下文
  // 占用阈值），Resume 由此恢复而不是静默新建任务。
  if (shouldForceCheckpoint(decision.reason)) {
    const checkpointId = saveForcedRunCheckpoint(ctx)
    if (checkpointId) decision.checkpointId = checkpointId
  }

  ctx.runTrace?.record("agent_loop_finished", {
    apiCalls: ctx.usage.apiCalls,
    // TB2-1: changedFiles 只含真正修改的文件（写工具成功），只读观察不算。
    changedFiles: [...ctx.execution.modifiedFiles],
    toolErrors: ctx.execution.toolErrors,
    modifiedFiles: ctx.execution.modifiedFileCount,
  })
  // ── Gate telemetry: yield summary + auto-save if configured ──
  if (ctx.gateTelemetry.gateNames().length > 0) {
    yield { type: "status", data: `gate-telemetry: ${ctx.gateTelemetry.gateNames().length} gates\n${ctx.gateTelemetry.report()}` }
  }
  await flushTelemetry(ctx)
  // TB2-1: 唯一映射表——轮次耗尽/阻塞/停滞不再落入 completed。
  lifecycle.stopReason = stopReasonForBreak(decision.reason)
}
