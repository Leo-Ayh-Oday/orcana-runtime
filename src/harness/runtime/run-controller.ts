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

import type { HarnessEvent } from "../contracts/events"
import type { AgentRun } from "../contracts/run"
import type { AgentRunInput } from "../contracts/run"
import type { AgentSession } from "../contracts/session"
import type { LoopDecision } from "../../agent/kernel/types"
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
}

export async function* runControlledRun(
  input: RunControllerInput,
): AsyncGenerator<HarnessEvent> {
  const { adapter, run, runInput, session, controller } = input
  const pending: HarnessEvent[] = []
  const machine = new RunLifecycleMachine(run, event => pending.push(event))
  // H4: wall-time watchdog + harness-layer budget guard (model/tool/token).
  const timed = createRunCancellationWithTimeout(controller, run.budget.limits.maxWallTimeMs)
  const guard = new BudgetGuard(run.budget, reason => controller.abort(reason))

  // created → initializing → running (with run.* lifecycle events).
  machine.transition("initializing")
  machine.transition("running")
  yield* pending
  pending.length = 0

  try {
    const decision = yield* runGuardedLoop(adapter, run, runInput, controller, guard)
    const mapped = mapDecisionToOutcome(decision, undefined, controller.signal.reason)
    machine.transitionTo(mapped.status)
    run.outcome = mapped.outcome
  } catch (error) {
    const mapped = failureOutcome(error)
    machine.transitionTo(mapped.status)
    run.outcome = mapped.outcome
    yield* pending // run.failed lifecycle event before the error propagates
    throw error
  } finally {
    timed.dispose()
    cleanupRun({ session, runId: run.runId, controller })
  }

  // Terminal lifecycle event (run.completed / run.waiting / run.blocked /
  // run.paused / run.cancelled) emitted after the bridge events.
  yield* pending
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
