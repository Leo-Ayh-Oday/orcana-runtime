/**
 * H0: Run contract — a single agent run inside a session.
 *
 * AgentRun is the durable record; AgentRunScope carries the run-bound mutable
 * state and is the only way tools / gates / nodes reach run state.
 */

import type { BudgetLedger } from "./budget"
import type { HarnessInterrupt } from "./interrupt"
import type { RunOutcome } from "./outcome"
// H3: typed run-scope owners (contracts/scope.ts) + stable L2/agent types.
import type { PlanStore } from "../../agent/run/plan-store"
import type { EvidenceLedger } from "../../agent/evidence-ledger"
import type { SandboxManager } from "../../sandbox/sandbox"
import type { ArtifactStore } from "./artifact"
import type {
  ModeStore,
  PatchContextStore,
  RippleSession,
  RunCancellation,
  TraceWriter,
} from "./scope"

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
  /** H4: per-run budget limits (fields default to unlimited; maxRounds maps to maxModelCalls). */
  budget?: Partial<import("./budget").RunBudget>
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
 *
 * H3: the H0 `unknown` placeholders are replaced with real, typed owners.
 * The harness creates these instances per run; the legacy kernel is wired to
 * the same planStore/sandbox so a run has a single source of truth (§3.1).
 */
export interface AgentRunScope {
  runId: string
  sessionId: string
  projectRoot: string

  planStore: PlanStore
  modeStore: ModeStore
  patchContext: PatchContextStore

  sandbox: SandboxManager
  rippleSession: RippleSession

  evidenceLedger: EvidenceLedger
  artifactStore: ArtifactStore

  cancellation: RunCancellation
  trace: TraceWriter
}
