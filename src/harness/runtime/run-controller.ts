/** RunController (H2): drives one AgentRun through its lifecycle.
 *
 *  Owns the event stream for a single run:
 *    created → initializing → running → (bridge events) → terminal
 *
 *  The terminal is derived from the legacy kernel's final LoopDecision
 *  (mapDecisionToOutcome) — every exit becomes a structured RunOutcome and a
 *  run.* lifecycle event, and cleanupRun() runs exactly once per run (in the
 *  finally). Exceptions map to failed and still propagate to the caller.
 */

import { randomUUID } from "node:crypto"
import type { EventEnvelope, HarnessEvent } from "../contracts/events"
import { HARNESS_EVENT_SCHEMA_VERSION, HARNESS_EVENT_TYPES } from "../contracts/events"
import type { AgentRun } from "../contracts/run"
import type { AgentRunInput } from "../contracts/run"
import type { AgentSession } from "../contracts/session"
import type { LoopDecision } from "../../agent/kernel/types"
import type { RunOutcome } from "../contracts/outcome"
import { createInterruptForDecision } from "../interrupts/interrupt-manager"
import { cleanupRun } from "./cleanup"
import { failureOutcome, mapDecisionToOutcome } from "./outcome-mapper"
import { RunLifecycleMachine } from "./lifecycle-machine"
import { BudgetGuard } from "./budget-guard"
import { createRunCancellationWithTimeout } from "./cancellation"
import type { LegacyLoopAdapter } from "./legacy-loop-adapter"


export interface RunControllerInput {
  adapter: LegacyLoopAdapter
  run: AgentRun
  runInput: AgentRunInput
  session: AgentSession
  controller: AbortController
  /** H7: continuation input for a resume (waiting → resuming → running). */
  resumeInput?: AgentRunInput
}

export async function* runControlledRun(
  input: RunControllerInput,
): AsyncGenerator<HarnessEvent> {
  const { adapter, run, runInput, session, controller, resumeInput } = input
  const pending: HarnessEvent[] = []
  const machine = new RunLifecycleMachine(run, event => pending.push(event))
  // H4: wall-time watchdog + harness-layer budget guard (model/tool/token).
  const timed = createRunCancellationWithTimeout(controller, run.budget.limits.maxWallTimeMs)
  // IC04 §27/§55: AgentHarness production path —— model_call 由
  // RetryCoordinator source-counted（"source" 模式），usage 事件只做 token
  // accounting；budget.maxModelCalls 是 strict physical cap（§25）。
  const guard = new BudgetGuard(run.budget, reason => controller.abort(reason), { modelCallAuthority: "source" })
  // IC04 P0-4: 唯一 RetryCoordinator 在 Run 创建时确定（run-registry）；
  // 这里只 configure external budget consumer（BudgetGuard adapter），
  // 不 replace、不 reset —— identity 在 fresh/pause/resume 间保持不变。
  // production scope 恒有 coordinator（run-registry 创建时确定）。
  run.scope.retryCoordinator!.configureBudgetConsumer({
    tryConsume: () => guard.tryConsumeModelCall(),
  })

  if (resumeInput) {
    // H7 resume path: waiting → resuming → running (no initializing).
    machine.transition("resuming")
    machine.transition("running")
  } else {
    // Fresh run: created → initializing → running.
    machine.transition("initializing")
    machine.transition("running")
  }
  yield* traceAndYield(pending, run)
  pending.length = 0

  try {
    const decision = yield* runGuardedLoop(adapter, run, resumeInput ?? runInput, controller, guard)
    const mapped = mapDecisionToOutcome(decision, undefined, controller.signal.reason)
    // H7: waiting decisions create a real pending interrupt (plan_approval /
    // clarification) and surface interrupt.created.
    if (mapped.status === "waiting") {
      const kind = decision.kind === "return" && decision.reason === "clarification"
        ? "clarification"
        : "plan_approval"
      const interrupt = createInterruptForDecision(run, kind)
      run.interrupt = interrupt
      if (mapped.outcome.kind === "waiting") {
        mapped.outcome.interruptId = interrupt.interruptId
      }
      pending.push({
        schemaVersion: HARNESS_EVENT_SCHEMA_VERSION,
        eventId: randomUUID(),
        sequence: ++run.eventSequence,
        runId: run.runId,
        sessionId: run.sessionId,
        type: HARNESS_EVENT_TYPES.interruptCreated,
        timestamp: new Date().toISOString(),
        payload: { interrupt },
      } as HarnessEvent)
    }
    machine.transitionTo(mapped.status, lifecycleExtra(mapped))
    run.outcome = mapped.outcome
    // Lifecycle event (run.completed / run.waiting / run.blocked /
    // run.paused / run.cancelled) — appended before the trace closes.
    // NOTE (G0-1): waiting/blocked/paused are stopped-but-resumable states,
    // not terminal — terminal statuses are completed/failed/cancelled/
    // restart_required (contracts/run.ts TERMINAL_RUN_STATUSES).
    yield* traceAndYield(pending, run)
  } catch (error) {
    const mapped = failureOutcome(error)
    machine.transitionTo(mapped.status)
    run.outcome = mapped.outcome
    yield* traceAndYield(pending, run) // run.failed lifecycle event before the error propagates
    throw error
  } finally {
    timed.dispose()
    // H5: flush + close the typed trace (best-effort, never fails the run).
    await run.scope.trace.flush().catch(() => {})
    await run.scope.trace.close().catch(() => {})
    // G0-2: fail-loud — a failed trace write must never fail the run, but it
    // must not be silent either. Surface the gap once, then move on.
    const lost = run.scope.trace.writeFailures()
    if (lost > 0) {
      console.warn(
        `[orcana] trace integrity: run ${run.runId} had ${lost} event write failures — ` +
        "the JSONL trace may be incomplete (audit stream only, run state is not affected)",
      )
    }
    cleanupRun({ session, runId: run.runId, controller })
  }
}

/** Extract the TB2-1 Resume handle (checkpointId/reason) from a mapped
 *  outcome so the run.paused/run.blocked lifecycle event can carry it. */
function lifecycleExtra(mapped: { status: string; outcome: RunOutcome }): { checkpointId?: string; reason?: string } | undefined {
  if (mapped.outcome.kind === "paused") {
    return { checkpointId: mapped.outcome.checkpointId, reason: mapped.outcome.reason }
  }
  if (mapped.outcome.kind === "blocked") {
    return { reason: mapped.outcome.blocker.reason }
  }
  if (mapped.outcome.kind === "waiting") {
    return { checkpointId: mapped.outcome.checkpointId, reason: mapped.outcome.interruptId }
  }
  return undefined
}

/** Yield lifecycle events while appending each to the typed trace. */
async function* traceAndYield(
  events: HarnessEvent[],
  run: AgentRun,
): AsyncGenerator<HarnessEvent> {
  for (const event of events) {
    await run.scope.trace.append(event as EventEnvelope<unknown>).catch(() => {})
    yield event
  }
}

/** Adapter event loop wrapped by the budget guard: on exhaustion the abort
 *  fires and no further events are emitted (acceptance: no events after
 *  cancellation). The loop returns an aborted decision so the run maps to a
 *  cancelled outcome whose reason is the BudgetExhaustionReason. */
async function* runGuardedLoop(
  adapter: LegacyLoopAdapter,
  run: AgentRun,
  runInput: AgentRunInput,
  controller: AbortController,
  guard: BudgetGuard,
): AsyncGenerator<HarnessEvent, LoopDecision, unknown> {
  const iterator = adapter.execute(run, runInput, controller.signal)
  let closed = false
  try {
    while (true) {
      const step = await iterator.next()
      if (step.done) {
        closed = true
        return step.value as LoopDecision
      }
      if (!guard.observe(step.value)) {
        closed = true
        return { kind: "return", reason: "aborted" }
      }
      // H5: every bridged event lands in the typed trace (best-effort).
      await run.scope.trace.append(step.value as EventEnvelope<unknown>).catch(() => {})
      yield step.value
    }
  } finally {
    if (!closed) {
      try {
        await iterator.return(undefined as never)
      } catch {
        // Best-effort close.
      }
    }
  }
}
