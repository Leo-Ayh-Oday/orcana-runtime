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
 */

import type { StreamEvent } from "../../provider/types"
import type { AgentRunLifecycleState } from "../run/types"
import { formatRoundBudgetExhausted } from "../round/helpers"
import { flushTelemetry } from "./effects"
import type { LoopDecision, RunPhaseContext } from "./types"

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

  ctx.runTrace?.record("agent_loop_finished", {
    apiCalls: ctx.usage.apiCalls,
    changedFiles: [...ctx.taskFiles],
    toolErrors: ctx.execution.toolErrors,
    modifiedFiles: ctx.execution.modifiedFileCount,
  })
  // ── Gate telemetry: yield summary + auto-save if configured ──
  if (ctx.gateTelemetry.gateNames().length > 0) {
    yield { type: "status", data: `gate-telemetry: ${ctx.gateTelemetry.gateNames().length} gates\n${ctx.gateTelemetry.report()}` }
  }
  await flushTelemetry(ctx)
  // GATE-03: ProgressGovernor STALLED 是独立终态（GS-01）——不是 completed。
  if (decision.reason === "progress_stalled") {
    lifecycle.stopReason = "stalled"
    return
  }
  lifecycle.stopReason = "completed"
}
