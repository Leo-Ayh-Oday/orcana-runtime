/**
 * H0: Snapshot contract.
 *
 * A serializable, dependency-free picture of a run at a point in time. Provider
 * instances, tool functions, AbortControllers, sandbox instances and file
 * handles are never serialized; the runtime re-injects them on resume.
 */

import type { RunStatus, AgentRunInput } from "./run"
import type { HarnessInterrupt } from "./interrupt"
import type { RunOutcome } from "./outcome"

export interface RunSnapshot {
  schemaVersion: number
  runId: string
  sessionId: string
  sequence: number

  status: RunStatus
  input: AgentRunInput

  planState: unknown
  modeState: unknown
  budgetState: unknown

  evidenceState: unknown
  artifactRefs: string[]

  conversationRef: string
  workspaceHash?: string

  interrupt?: HarnessInterrupt
  outcome?: RunOutcome

  createdAt: number
}
