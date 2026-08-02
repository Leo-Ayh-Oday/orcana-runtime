/** Run lifecycle machine (H2): the single driver of run.status.
 *
 *  Wraps the H0 contract (contracts/lifecycle.ts: LEGAL_TRANSITIONS,
 *  assertTransition) with runtime behavior: every transition updates the
 *  canonical AgentRun.status and emits a typed run.* lifecycle event. Direct
 *  `run.status = ...` is forbidden outside this machine.
 */

import { randomUUID } from "node:crypto"
import { assertTransition, canTransition } from "../contracts/lifecycle"
import { HARNESS_EVENT_SCHEMA_VERSION, HARNESS_EVENT_TYPES } from "../contracts/events"
import type { HarnessEvent } from "../contracts/events"
import type { AgentRun, RunStatus } from "../contracts/run"
import { InvalidStateTransitionError } from "../contracts/errors"

export type LifecycleEventSink = (event: HarnessEvent) => void

export class RunLifecycleMachine {
  constructor(
    private readonly run: AgentRun,
    private readonly emit: LifecycleEventSink,
  ) {}

  get status(): RunStatus {
    return this.run.status
  }

  can(to: RunStatus): boolean {
    return canTransition(this.run.status, to)
  }

  /** Validate + update + emit. Idempotent for same-status; illegal transitions throw. */
  transition(to: RunStatus): void {
    if (this.run.status === to) return
    if (!canTransition(this.run.status, to)) {
      throw new InvalidStateTransitionError(this.run.runId, this.run.status, to)
    }
    this.run.status = to
    if (to === "running" && !this.run.startedAt) {
      this.run.startedAt = Date.now()
    }
    if (isTerminal(to)) {
      this.run.finishedAt ??= Date.now()
    }
    this.emit(lifecycleEvent(this.run, to))
  }

  /** Transition honoring the pausing intermediate (running → pausing → paused). */
  transitionTo(to: RunStatus): void {
    if (to === "paused" && this.run.status === "running") {
      this.transition("pausing")
    }
    this.transition(to)
  }
}

export function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "restart_required"
}

/** Map a RunStatus to its run.* event name (contracts/events.ts). */
export function lifecycleEventName(status: RunStatus): string {
  switch (status) {
    case "initializing": return HARNESS_EVENT_TYPES.runInitializing
    case "running": return HARNESS_EVENT_TYPES.runStarted
    case "waiting": return HARNESS_EVENT_TYPES.runWaiting
    case "resuming": return HARNESS_EVENT_TYPES.runResumed
    case "pausing": return HARNESS_EVENT_TYPES.runPausing
    case "paused": return HARNESS_EVENT_TYPES.runPaused
    case "blocked": return HARNESS_EVENT_TYPES.runBlocked
    case "completed": return HARNESS_EVENT_TYPES.runCompleted
    case "failed": return HARNESS_EVENT_TYPES.runFailed
    case "cancelled": return HARNESS_EVENT_TYPES.runCancelled
    default: return HARNESS_EVENT_TYPES.runCreated
  }
}

/** Build a lifecycle EventEnvelope<{status: RunStatus}> for the run. */
export function lifecycleEvent(run: AgentRun, status: RunStatus): HarnessEvent {
  const event = {
    schemaVersion: HARNESS_EVENT_SCHEMA_VERSION,
    eventId: randomUUID(),
    sequence: ++run.eventSequence,
    runId: run.runId,
    sessionId: run.sessionId,
    type: lifecycleEventName(status),
    timestamp: new Date().toISOString(),
    payload: { status },
  }
  return event as HarnessEvent
}
