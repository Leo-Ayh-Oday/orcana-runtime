/**
 * H0: RunOutcome contract — the single, structured completion exit.
 *
 * UI must never decide task completion by parsing text. Every run terminates in
 * exactly one structured outcome.
 */

export interface RunBlocker {
  gate: string
  reason: string
  blockCount: number
}

export interface RunFailure {
  kind: string
  message: string
  retryable: boolean
  cause?: unknown
}

export type RunOutcome =
  | {
      kind: "completed"
      reportArtifactId: string
      evidenceIds: string[]
    }
  | {
      kind: "waiting"
      interruptId: string
      checkpointId: string
    }
  | {
      kind: "paused"
      checkpointId: string
      reason: string
    }
  | {
      kind: "blocked"
      blocker: RunBlocker
    }
  | {
      kind: "cancelled"
      reason: string
    }
  | {
      kind: "failed"
      failure: RunFailure
    }
  | {
      kind: "restart_required"
      files: string[]
      verificationEvidenceIds: string[]
    }

export type RunOutcomeKind = RunOutcome["kind"]

/** Narrow a RunOutcome to its kind. Pure runtime helper for callers. */
export function outcomeKind(outcome: RunOutcome): RunOutcomeKind {
  return outcome.kind
}
