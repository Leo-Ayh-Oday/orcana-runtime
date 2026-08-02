/**
 * H0: Typed event contract.
 *
 * Every event emitted by a run is an EventEnvelope carrying a schema version and
 * a run-unique increasing sequence. Trace consumers must read `payload` through
 * shared types, never by guessing field positions.
 */

import type { RunStatus } from "./run"

export const HARNESS_EVENT_SCHEMA_VERSION = 1 as const

export interface EventEnvelope<T = unknown> {
  schemaVersion: typeof HARNESS_EVENT_SCHEMA_VERSION

  eventId: string
  sequence: number

  runId: string
  sessionId: string
  nodeRunId?: string
  parentEventId?: string

  type: string
  timestamp: string
  payload: T
}

/** Standard event type names — the stable protocol surface. */
export const HARNESS_EVENT_TYPES = {
  runCreated: "run.created",
  runInitializing: "run.initializing",
  runStarted: "run.started",
  runWaiting: "run.waiting",
  runResumed: "run.resumed",
  runPaused: "run.paused",
  runBlocked: "run.blocked",
  runCompleted: "run.completed",
  runFailed: "run.failed",
  runCancelled: "run.cancelled",

  roundStarted: "round.started",
  roundCompleted: "round.completed",

  modelCallStarted: "model.call.started",
  modelCallCompleted: "model.call.completed",
  modelCallFailed: "model.call.failed",
  modelUsage: "model.usage",

  toolCallRequested: "tool.call.requested",
  toolPolicyAllowed: "tool.policy.allowed",
  toolPolicyBlocked: "tool.policy.blocked",
  toolCallStarted: "tool.call.started",
  toolCallCompleted: "tool.call.completed",
  toolCallFailed: "tool.call.failed",

  artifactCreated: "artifact.created",
  artifactStale: "artifact.stale",
  evidenceRecorded: "evidence.recorded",

  transactionStarted: "transaction.started",
  transactionCommitted: "transaction.committed",
  transactionRolledBack: "transaction.rolled_back",

  interruptCreated: "interrupt.created",
  interruptAnswered: "interrupt.answered",
  checkpointSaved: "checkpoint.saved",

  // H1: legacy-loop bridge surface (transparent UI/flow events; the
  // plan/clarification variants become real interrupts in H7).
  textEmitted: "text.emitted",
  displayChanged: "display.changed",
  errorRaised: "error.raised",
  planReady: "plan.ready",
  clarificationReady: "clarification.ready",
} as const

export type HarnessEventType = (typeof HARNESS_EVENT_TYPES)[keyof typeof HARNESS_EVENT_TYPES]

/** UI-facing display payload carried by the "display" bridge variant. */
export type HarnessDisplayKind =
  | "status"
  | "task_progress"
  | "thinking_blocks"
  | "confirm"
  | "user_question"

/** The event union surfaced by AgentHarness.run()/resume(). */
export type HarnessEvent =
  | EventEnvelope<{ status: RunStatus }>
  | EventEnvelope<{ text: string }>
  | EventEnvelope<{ toolName: string; content: string; success: boolean }>
  | EventEnvelope<{ usage: unknown }>
  | EventEnvelope<{ error: string }>
  | EventEnvelope<{ interrupt: unknown }>
  // H1 bridge variants — kept independent of the legacy StreamEvent type so
  // the contract stays free of provider/loop dependencies.
  | EventEnvelope<{ toolCall: { id: string; name: string; input: unknown } }>
  | EventEnvelope<{ display: { kind: HarnessDisplayKind; data: unknown } }>
  // plan/clarification payloads are opaque in H1 (the legacy loop's own plan
  // artifact shape) and get formal schemas when they become real interrupts
  // in H7.
  | EventEnvelope<{ planReady: { plan: unknown } }>
  | EventEnvelope<{ clarification: { questions: unknown } }>
