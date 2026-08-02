/**
 * H0: Run contract — a single agent run inside a session.
 *
 * AgentRun is the durable record; AgentRunScope carries the run-bound mutable
 * state and is the only way tools / gates / nodes reach run state.
 */

import type { BudgetLedger } from "./budget"
import type { HarnessInterrupt } from "./interrupt"
import type { RunOutcome } from "./outcome"

export type RunStatus =
  | "created"
  | "initializing"
  | "running"
  | "waiting"
  | "pausing"
  | "paused"
  | "resuming"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "restart_required"

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "restart_required",
] as const

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status)
}

export interface AgentRunInput {
  prompt: string
  tools?: Array<{ name: string; description?: string }>
  maxRounds?: number
  metadata?: Record<string, unknown>
}

export interface AgentRun {
  runId: string
  sessionId: string

  status: RunStatus
  input: AgentRunInput

  scope: AgentRunScope
  budget: BudgetLedger

  createdAt: number
  startedAt?: number
  finishedAt?: number

  interrupt?: HarnessInterrupt
  outcome?: RunOutcome

  eventSequence: number
  schemaVersion: number
}

/**
 * Run-bound state. Every tool, gate or node reads run state only from an
 * explicit scope reference — never from module-level variables.
 */
export interface AgentRunScope {
  runId: string
  sessionId: string
  projectRoot: string

  planStore: unknown
  modeStore: unknown
  patchContext: unknown

  sandbox: unknown
  rippleSession: unknown

  evidenceLedger: unknown
  artifactStore: unknown

  cancellation: unknown
  trace: unknown
}
