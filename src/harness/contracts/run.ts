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
import type { RetryLedger } from "../../runtime/retry-ledger"
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

/**
 * Stopped-but-resumable run states (G0-1): the run is no longer advancing on
 * its own, but the state is NOT terminal — an external action (resume /
 * user decision) may move it back to `running`. `pausing` is a transient
 * intermediate, not a stopped state.
 *
 * This separates two meanings that `TERMINAL_RUN_STATUSES` alone conflates:
 *  - terminal  → finished forever, no transitions out
 *  - stopped   → not advancing, resumable (blocked/waiting/paused)
 * Replay/HR invariants must check "stopped", not "terminal".
 */
export const STOPPED_RUN_STATUSES: readonly RunStatus[] = [
  "blocked",
  "waiting",
  "paused",
] as const

/** Whether the run is no longer auto-advancing (terminal OR stopped-resumable). */
export function isStoppedRunStatus(status: RunStatus): boolean {
  return isTerminalRunStatus(status) || STOPPED_RUN_STATUSES.includes(status)
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
  /** PR-GATE-06：Run 级统一重试预算（provider/capability/repair 层共享，
   *  禁止各层独立无限重试的乘法爆炸）。 */
  retryLedger: RetryLedger
}
