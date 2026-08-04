/** Tool Runtime 2.0 (RT-1): explicit run-scoped execution context.
 *
 *  A capability handler never touches module-level state or process.cwd() —
 *  everything it may reach is declared here. RT-3 wires the executor to this
 *  object (today the executor takes loose parameters); the type and the
 *  scope-derived builder land now so callers can start consuming it.
 */

import type { BudgetLedger } from "../contracts/budget"
import type { ArtifactStore } from "../contracts/artifact"
import type { EvidenceLedger } from "../../agent/evidence-ledger"
import type { TraceWriter, RippleSession, PatchContextStore } from "../contracts/scope"
import type { SandboxManager } from "../../sandbox/sandbox"
import type { FileStateLedger } from "../../file-state/file-state-ledger"
import type { AgentRunScope } from "../contracts/run"

/** Approval surface handed to capabilities (interactive confirm lives in
 *  the loop; node mode is fail-closed strict — RT-5 deepens the policy). */
export interface ApprovalContext {
  mode: "auto" | "confirm" | "strict"
  /** Approvals granted this run (permission paths, not sessions). */
  granted: Set<string>
  /** Ask for approval; returns true when granted. Never auto-grants in
   *  strict mode (node mode has no interactive channel → fail closed). */
  request(path: string): Promise<boolean>
}

export interface Clock {
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }

export interface ToolExecutionContext {
  runId: string
  sessionId: string
  nodeRunId?: string

  projectRoot: string
  /** Roots the capability may read (defaults to [projectRoot]). */
  readableRoots: string[]
  /** Roots the capability may write (defaults to [] — writes opt in). */
  writableRoots: string[]

  signal: AbortSignal
  budget: BudgetLedger
  approval: ApprovalContext

  sandbox: SandboxManager
  artifactStore: ArtifactStore
  evidenceLedger: EvidenceLedger
  trace: TraceWriter

  fileState: FileStateLedger
  rippleSession: RippleSession
  patchStore: PatchContextStore

  clock: Clock
}

export interface BuildExecutionContextInput {
  runId: string
  sessionId: string
  nodeRunId?: string
  projectRoot: string
  signal: AbortSignal
  budget: BudgetLedger
  /** Defaults to ["auto"] (loop mode); node mode passes strict. */
  approvalMode?: ApprovalContext["mode"]
  /** Roots writable by this run's capabilities (defaults to [projectRoot]). */
  writableRoots?: string[]
  clock?: Clock
}

/** Build a context from an AgentRunScope (RT-3 wiring target). */
export function buildExecutionContext(input: BuildExecutionContextInput): ToolExecutionContext {
  const { runId, sessionId, projectRoot, signal, budget } = input
  const approvalMode = input.approvalMode ?? "auto"
  const granted = new Set<string>()
  const approval: ApprovalContext = {
    mode: approvalMode,
    granted,
    async request(path: string): Promise<boolean> {
      if (granted.has(path)) return true
      if (approvalMode === "strict") return false // node mode fails closed
      if (approvalMode === "auto") {
        granted.add(path)
        return true
      }
      return false // confirm mode without an interactive channel → deny
    },
  }
  const scope = (input as { scope?: AgentRunScope }).scope
  // FileStateLedger is still module-level (runtime-file-state) — the RT-3
  // context work threads a run-scoped instance in; until then it is absent.
  const fileState = null as unknown as FileStateLedger
  return {
    runId,
    sessionId,
    nodeRunId: input.nodeRunId,
    projectRoot,
    readableRoots: [projectRoot],
    writableRoots: input.writableRoots ?? [projectRoot],
    signal,
    budget,
    approval,
    sandbox: scope?.sandbox ?? (null as unknown as SandboxManager),
    artifactStore: scope?.artifactStore ?? (null as unknown as ArtifactStore),
    evidenceLedger: scope?.evidenceLedger ?? (null as unknown as EvidenceLedger),
    trace: scope?.trace ?? (null as unknown as TraceWriter),
    fileState,
    rippleSession: scope?.rippleSession ?? (null as unknown as RippleSession),
    patchStore: scope?.patchContext ?? (null as unknown as PatchContextStore),
    clock: input.clock ?? systemClock,
  }
}

/** Convenience: derive a context directly from a run scope. */
export function contextFromRunScope(
  scope: AgentRunScope,
  input: Omit<BuildExecutionContextInput, "runId" | "sessionId" | "projectRoot" | "budget" | "signal"> & {
    budget: BudgetLedger
    signal: AbortSignal
  },
): ToolExecutionContext {
  return buildExecutionContext({
    ...input,
    runId: scope.runId,
    sessionId: scope.sessionId,
    projectRoot: scope.projectRoot,
    scope,
  } as BuildExecutionContextInput & { scope: AgentRunScope })
}
