/** Run serialization / restore (H6, plan §13.4).
 *
 *  serializeRun projects an AgentRun into a SerializableRun (scope instances
 *  are replaced by snapshots; budget by limits+used). restoreAgentRun
 *  rebuilds an AgentRun from a SerializableRun: the scope is re-assembled
 *  (fresh instances — dependencies are re-injected by the caller per §13.4),
 *  the plan is rebuilt with node statuses preserved so a restored run never
 *  repeats completed work, and outcome/status/eventSequence are kept.
 */

import { createMasterPlan } from "../../agent/master-plan"
import { createTaskTracker } from "../../agent/task-tracker"
import { createPlanStore, setCurrentPlan } from "../../agent/run/plan-store"
import { deserializeLedger, serializeLedger } from "../../agent/evidence-ledger"
import type { AgentRun, AgentRunInput } from "../contracts/run"
import type { RunSnapshot } from "../contracts/snapshot"
import type { ModeName } from "../../agent/mode-contract"
import { assembleRunScope } from "../runtime/run-scope"
import { createBudgetLedger } from "../runtime/budget-ledger"
import { createArtifactStore } from "../artifacts/artifact-store"
import { HARNESS_STORE_SCHEMA_VERSION, type SerializablePlanState, type SerializableRun, type SerializedArtifactState } from "./harness-store"

export function serializePlanState(planStore: { current: { goal: string; intent: string; current: string; nodes: Array<{ id: string; title: string; status: string; dependsOn: string[]; blockedBy: string[]; evidence?: string; reactCount: number }> } | null }): SerializablePlanState {
  const plan = planStore.current
  if (!plan) {
    return { goal: "", intent: "", current: "", nodes: [] }
  }
  return {
    goal: plan.goal,
    intent: plan.intent,
    current: plan.current,
    nodes: plan.nodes.map(n => ({
      id: n.id,
      title: n.title,
      status: n.status,
      dependsOn: n.dependsOn,
      blockedBy: n.blockedBy,
      evidence: n.evidence,
      reactCount: n.reactCount,
    })),
  }
}

/** Rebuild a MasterPlan with preserved node statuses (trackers as placeholders). */
export function deserializePlanState(state: SerializablePlanState) {
  if (!state.goal || state.nodes.length === 0) return null
  const plan = createMasterPlan(
    state.goal,
    state.intent as never,
    state.nodes.map(n => n.title),
  )
  for (let i = 0; i < plan.nodes.length; i++) {
    const source = state.nodes[i]
    const node = plan.nodes[i]
    if (!source || !node) continue
    node.status = source.status as typeof node.status
    node.dependsOn = [...source.dependsOn]
    node.blockedBy = [...source.blockedBy]
    node.evidence = source.evidence
    node.reactCount = source.reactCount
    // Tracker placeholder (H7 resume completes); keep the node's default
    // tracker when the intent is not long_task.
    const tracker = createTaskTracker(source.title, state.intent as never)
    if (tracker) node.tracker = tracker
  }
  plan.current = state.current || plan.nodes[0]!.id
  return plan
}

export interface SerializeRunInput {
  run: AgentRun
  workspaceHash?: string
  /** H8: artifact ids produced by the run (collected by the caller — the
   *  store interface is async and serializeRun stays synchronous). */
  artifactRefs?: string[]
  /** G0-3: artifact entities + resolved content (collected by the caller).
   *  Restored runs can then read artifact content back, not just refs. */
  artifactState?: SerializedArtifactState
}

export function serializeRun(input: SerializeRunInput): SerializableRun {
  const { run, workspaceHash, artifactRefs, artifactState } = input
  return {
    schemaVersion: HARNESS_STORE_SCHEMA_VERSION,
    runId: run.runId,
    sessionId: run.sessionId,
    status: run.status,
    input: run.input,
    outcome: run.outcome,
    interrupt: run.interrupt,
    eventSequence: run.eventSequence,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    planState: serializePlanState(run.scope.planStore),
    modeState: { mode: run.scope.modeStore.mode },
    budgetState: { limits: run.budget.limits, used: run.budget.used },
    evidenceState: { entries: serializeLedger(run.scope.evidenceLedger).entries },
    artifactRefs: artifactRefs ?? [],
    artifactState,
    workspaceHash,
  }
}

export interface RestoreAgentRunInput {
  serializable: SerializableRun
  projectRoot: string
}

/** Rebuild an AgentRun from its serialized form (fresh scope, deps injected by caller). */
export function restoreAgentRun(input: RestoreAgentRunInput): AgentRun {
  const { serializable, projectRoot } = input
  const controller = new AbortController()
  const scope = assembleRunScope({
    runId: serializable.runId,
    sessionId: serializable.sessionId,
    projectRoot,
    controller,
    activeMode: serializable.modeState.mode as ModeName,
  })
  // Restore plan with preserved node statuses (done work stays done).
  const plan = deserializePlanState(serializable.planState)
  if (plan) setCurrentPlan(scope.planStore, plan)

  // H8: restore the evidence ledger; H6 files carried only a count — treat
  // those as an empty ledger.
  const entries = serializable.evidenceState?.entries
  if (Array.isArray(entries)) {
    scope.evidenceLedger = deserializeLedger({ entries })
  }

  // G0-3: restore artifact entities + resolved content (was: "artifact
  // content is not restored, refs are"). Old files without artifactState
  // hydrate an empty store — refs alone stay unreadable, as before.
  if (serializable.artifactState && (serializable.artifactState.artifacts.length > 0 || serializable.artifactState.contents.length > 0)) {
    scope.artifactStore = createArtifactStore(serializable.artifactState)
  }

  const budget = createBudgetLedger(serializable.budgetState.limits)
  Object.assign(budget.used, serializable.budgetState.used)

  return {
    runId: serializable.runId,
    sessionId: serializable.sessionId,
    status: serializable.status,
    input: serializable.input as AgentRunInput,
    scope,
    budget,
    createdAt: serializable.createdAt,
    startedAt: serializable.startedAt,
    finishedAt: serializable.finishedAt,
    interrupt: serializable.interrupt,
    outcome: serializable.outcome,
    eventSequence: serializable.eventSequence,
    schemaVersion: serializable.schemaVersion,
  }
}

/** Snapshot from a live run (same shape as inspect()). */
export function snapshotFromRun(run: AgentRun, workspaceHash?: string, artifactRefs?: string[]): RunSnapshot {
  return {
    schemaVersion: 1,
    runId: run.runId,
    sessionId: run.sessionId,
    sequence: run.eventSequence,
    status: run.status,
    input: run.input,
    planState: serializePlanState(run.scope.planStore),
    modeState: { mode: run.scope.modeStore.mode },
    budgetState: {
      limits: run.budget.limits,
      used: run.budget.used,
      remaining: run.budget.remaining(),
    },
    evidenceState: { entries: serializeLedger(run.scope.evidenceLedger).entries },
    artifactRefs: artifactRefs ?? [],
    conversationRef: "",
    workspaceHash,
    interrupt: run.interrupt,
    outcome: run.outcome,
    createdAt: run.createdAt,
  }
}
