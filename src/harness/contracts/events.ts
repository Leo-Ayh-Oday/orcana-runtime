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
} as const

export type HarnessEventType = (typeof HARNESS_EVENT_TYPES)[keyof typeof HARNESS_EVENT_TYPES]

/** The event union surfaced by AgentHarness.run()/resume(). */
export type HarnessEvent =
  | EventEnvelope<{ status: RunStatus }>
  | EventEnvelope<{ text: string }>
  | EventEnvelope<{ toolName: string; content: string; success: boolean }>
  | EventEnvelope<{ usage: unknown }>
  | EventEnvelope<{ error: string }>
  | EventEnvelope<{ interrupt: unknown }>
