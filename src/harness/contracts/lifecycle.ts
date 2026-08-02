/**
 * H0: Run lifecycle contract.
 *
 * All status transitions are governed here. Direct `run.status = ...` is
 * forbidden in the runtime; every transition goes through the machine and
 * produces an event. Terminal states never transition again.
 */

import type { RunStatus } from "./run"
import { isTerminalRunStatus } from "./run"

export const LEGAL_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  created: ["initializing", "failed", "cancelled"],
  initializing: ["failed", "running", "cancelled"],
  running: ["waiting", "pausing", "blocked", "completed", "failed", "cancelled", "restart_required"],
  waiting: ["resuming", "cancelled", "failed"],
  resuming: ["running", "failed"],
  pausing: ["paused"],
  paused: ["resuming", "cancelled"],
  blocked: ["cancelled", "failed", "running"],
  completed: [],
  failed: [],
  cancelled: [],
  restart_required: [],
}

/** Pure transition validator — shared by the runtime machine and tests. */
export function canTransition(from: RunStatus, to: RunStatus): boolean {
  if (from === to) return true
  if (isTerminalRunStatus(from)) return false
  return LEGAL_TRANSITIONS[from].includes(to)
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal run transition ${from} → ${to}`)
  }
}
