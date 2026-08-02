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
import { cleanupRun } from "./cleanup"
import { failureOutcome, mapDecisionToOutcome } from "./outcome-mapper"
import { RunLifecycleMachine } from "./lifecycle-machine"
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

  // created → initializing → running (with run.* lifecycle events).
  machine.transition("initializing")
  machine.transition("running")
  yield* pending
  pending.length = 0

  try {
    const decision = yield* adapter.execute(run, runInput, controller.signal)
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
    cleanupRun({ session, runId: run.runId, controller })
  }

  // Terminal lifecycle event (run.completed / run.waiting / run.blocked /
  // run.paused / run.cancelled) emitted after the bridge events.
  yield* pending
}
