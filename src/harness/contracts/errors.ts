/**
 * H0: Harness error taxonomy.
 *
 * Every failure that escapes a run carries a typed kind so callers can branch
 * without string-matching. These are the only error types the Harness API
 * surfaces to CLI / TUI / future Graph.
 */

export type HarnessErrorKind =
  | "session_not_found"
  | "run_not_found"
  | "run_already_active"
  | "invalid_state_transition"
  | "invalid_interrupt_response"
  | "interrupt_expired"
  | "interrupt_not_pending"
  | "workspace_changed"
  | "snapshot_corrupt"
  | "storage_failure"
  | "budget_exhausted"
  | "capability_not_found"
  | "capability_already_registered"
  | "internal"

export class HarnessError extends Error {
  readonly kind: HarnessErrorKind
  readonly runId?: string

  constructor(kind: HarnessErrorKind, message: string, runId?: string) {
    super(message)
    this.name = "HarnessError"
    this.kind = kind
    this.runId = runId
  }
}

export class SessionNotFoundError extends HarnessError {
  constructor(sessionId: string) {
    super("session_not_found", `Harness session not found: ${sessionId}`)
    this.name = "SessionNotFoundError"
  }
}

export class RunNotFoundError extends HarnessError {
  constructor(runId: string) {
    super("run_not_found", `Harness run not found: ${runId}`, runId)
    this.name = "RunNotFoundError"
  }
}

export class InvalidStateTransitionError extends HarnessError {
  constructor(runId: string, from: string, to: string) {
    super("invalid_state_transition", `Illegal run transition ${from} → ${to}`, runId)
    this.name = "InvalidStateTransitionError"
  }
}

export class InvalidInterruptResponseError extends HarnessError {
  constructor(runId: string, message: string) {
    super("invalid_interrupt_response", `Interrupt response rejected: ${message}`, runId)
    this.name = "InvalidInterruptResponseError"
  }
}
