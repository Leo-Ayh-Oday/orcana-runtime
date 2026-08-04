/** HarnessStore contract (H6, plan §13.2).
 *
 *  A run/session can be persisted and re-assembled: saveRun stores a
 *  SerializableRun (projection of AgentRun — never sandbox/provider/trace
 *  instances), snapshots capture inspectable state, events append the typed
 *  trace. loadX returns null for missing or corrupt files; callers never
 *  crash on storage problems.
 */

import type { RunBudget, BudgetUsage } from "../contracts/budget"
import type { HarnessEvent } from "../contracts/events"
import type { HarnessInterrupt } from "../contracts/interrupt"
import type { RunOutcome } from "../contracts/outcome"
import type { AgentRunInput, RunStatus } from "../contracts/run"
import type { RunSnapshot } from "../contracts/snapshot"
import type { ModeName } from "../../agent/mode-contract"
import type { SerializedEvidenceEntry } from "../../agent/evidence-ledger"

export interface SerializableSession {
  sessionId: string
  createdAt: number
  updatedAt: number
  activeRunIds: string[]
  projectRoot: string
  conversationRef?: string
  stableMemoryRef?: string
  metadata: Record<string, unknown>
}

/** Rebuildable plan state — node statuses (done/blocked/...) survive so a
 *  restored run never repeats completed work. Trackers/_packet are rebuilt
 *  as placeholders (H7 resume completes them). */
export interface SerializablePlanState {
  goal: string
  intent: string
  current: string
  nodes: Array<{
    id: string
    title: string
    status: string
    dependsOn: string[]
    blockedBy: string[]
    evidence?: string
    reactCount: number
  }>
}

export interface SerializableRun {
  schemaVersion: number
  runId: string
  sessionId: string
  status: RunStatus
  input: AgentRunInput
  outcome?: RunOutcome
  interrupt?: HarnessInterrupt
  eventSequence: number
  createdAt: number
  startedAt?: number
  finishedAt?: number
  planState: SerializablePlanState
  modeState: { mode: ModeName }
  budgetState: { limits: RunBudget; used: BudgetUsage }
  /** H8: serialized evidence ledger entries (was a count in H6). */
  evidenceState: { entries: SerializedEvidenceEntry[] }
  /** H8: artifact ids produced by the run (content lives in the run's store). */
  artifactRefs: string[]
  workspaceHash?: string
}

export const HARNESS_STORE_SCHEMA_VERSION = 1 as const

export interface HarnessStore {
  saveSession(session: SerializableSession): Promise<void>
  loadSession(sessionId: string): Promise<SerializableSession | null>

  saveRun(run: SerializableRun): Promise<void>
  loadRun(runId: string): Promise<SerializableRun | null>

  appendEvent(event: HarnessEvent): Promise<void>

  saveSnapshot(snapshot: RunSnapshot): Promise<void>
  loadLatestSnapshot(runId: string): Promise<RunSnapshot | null>

  /** G0-2: event trace file integrity for a run — used on restore to surface
   *  a missing/incomplete audit stream (never blocks the restore). */
  traceIntegrity(runId: string): Promise<{ eventFileExists: boolean; eventCount: number }>
}
