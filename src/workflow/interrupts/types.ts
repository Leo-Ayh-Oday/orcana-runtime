/** MACP-M4: persistent interrupts — a workflow run may pause at a human
 *  node instead of blocking the process (PROCESS_BOUND_WAITING: 0).
 */

export type WorkflowInterruptKind =
  | "approval"
  | "user_input"
  | "conflict_resolution"
  | "plan_amendment"
  | "external_uncertainty"

/** M10: "resuming" is the atomic post-consume state — a token is consumed
 *  exactly once (waiting → resuming → resolved); a crash during resume
 *  leaves a clearly recoverable state. */
export type WorkflowInterruptStatus = "waiting" | "resuming" | "resolved" | "cancelled" | "expired"

export interface WorkflowInterruptRecord {
  interruptId: string
  runId: string
  specId: string
  /** Deterministic digest of the workflow spec (graph version check). */
  specDigest: string
  nodeId: string
  nodeRunId: string

  kind: WorkflowInterruptKind
  prompt: string
  responseSchema: unknown

  createdAt: number
  expiresAt?: number

  /** Workspace content hash when the interrupt was created — resume
   *  re-checks freshness before continuing (MACP-M4 task 10). */
  workspaceHash: string

  status: WorkflowInterruptStatus
}

/** Raised when a human node has no answer: the run pauses, the record is
 *  persisted, and the scheduler returns a waiting result with a resume
 *  token instead of blocking. */
export class WorkflowInterruptError extends Error {
  constructor(public readonly record: WorkflowInterruptRecord) {
    super(`workflow interrupted at node "${record.nodeId}" (${record.kind})`)
    this.name = "WorkflowInterruptError"
  }
}
