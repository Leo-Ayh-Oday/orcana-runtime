/** AgentHarness facade (H1): the single production entry to runs.
 *
 *  CLI / TUI / tests / future Graph drive runs exclusively through this
 *  interface. H1 implements the full facade surface with a legacy loop under
 *  the hood:
 *    - run()        → LegacyLoopAdapter → agentLoop, events as HarnessEvent;
 *    - cancel()     → bridges into AgentOptions.abortSignal via the registry
 *                     AbortController (full cancellation policy lands in H4);
 *    - inspect()    → RunSnapshot from the registry's AgentRun (persistence
 *                     lands in H6 — H1 snapshot is live-state only);
 *    - resume()     → not implemented until H7 (persistent interrupts).
 *
 *  Sessions are held in memory (H6 adds the HarnessStore).
 */

import { randomUUID } from "node:crypto"
import { HarnessError } from "../contracts/errors"
import type { HarnessEvent } from "../contracts/events"
import type { AgentHarness } from "../contracts/harness"
import type { AgentRunInput } from "../contracts/run"
import type { AgentSession, CreateSessionInput } from "../contracts/session"
import type { InterruptKind, InterruptResponse } from "../contracts/interrupt"
import type { RunSnapshot } from "../contracts/snapshot"
import { RunRegistry } from "./run-registry"
import { runControlledRun } from "./run-controller"
import { createLegacyLoopAdapter, type LegacyLoopAdapter, type LegacyLoopAdapterDeps } from "./legacy-loop-adapter"
import { serializeRun, snapshotFromRun, restoreAgentRun } from "../persistence/serialization"
import type { HarnessStore, SerializableRun } from "../persistence/harness-store"
import { serializeLedger } from "../../agent/evidence-ledger"
import { createCapabilityRegistry } from "../capabilities"
import { registerToolCapabilities } from "../capabilities"
import { markInterruptAnswered, validateResume } from "../interrupts/interrupt-manager"
import { applyPlanApprovalResponse } from "../interrupts/plan-approval"
import { applyClarificationResponse } from "../interrupts/clarification"

export interface AgentHarnessInput {
  deps: LegacyLoopAdapterDeps
  /** Optional stable session id; otherwise created on first use. */
  sessionId?: string
  projectRoot?: string
  /** H6: optional persistent store — runs/snapshots saved on terminal states,
   *  inspect falls back to the store for historical runs. */
  store?: HarnessStore
  /** Optional workspace-hash provider (computed lazily at terminal save). */
  workspaceHash?: () => string
  /** G0-2: fail-loud observer for trace batch write failures (audit stream). */
  onTraceWriteFailure?: (info: { runId: string; batchSize: number; error: unknown }) => void
}

/** G0-2: fail-loud trace integrity check on restore — the JSONL event stream
 *  is an audit trail, not the restore source (Run/Snapshot JSON are), so a
 *  missing or incomplete stream is surfaced as a warning, never a failure. */
async function checkTraceIntegrity(store: HarnessStore, serializable: SerializableRun): Promise<void> {
  const integrity = await store.traceIntegrity(serializable.runId).catch(() => ({ eventFileExists: false, eventCount: 0 }))
  if (!integrity.eventFileExists && serializable.eventSequence > 0) {
    console.warn(
      `[orcana] trace integrity: run ${serializable.runId} restored without an event trace file ` +
      `(${serializable.eventSequence} events expected — audit stream only, run state is unaffected)`,
    )
  } else if (integrity.eventCount < serializable.eventSequence) {
    console.warn(
      `[orcana] trace integrity: run ${serializable.runId} event trace is incomplete ` +
      `(${integrity.eventCount}/${serializable.eventSequence} events — audit stream only, run state is unaffected)`,
    )
  }
}

export function createAgentHarness(input: AgentHarnessInput): AgentHarness {
  const registry = new RunRegistry()
  // H9: capability registry over the first migration batch (§15.4). Event
  // bridging and loop routing consume this registry in H9 (budget classes,
  // unified execution entry).
  const capabilities = createCapabilityRegistry()
  registerToolCapabilities(capabilities, input.deps.tools)
  const adapter: LegacyLoopAdapter = createLegacyLoopAdapter({
    deps: { ...input.deps, capabilityRegistry: capabilities },
  })
  const projectRoot = input.projectRoot ?? process.cwd()
  const store = input.store
  const workspaceHash = input.workspaceHash

  const sessions = new Map<string, AgentSession>()
  const primarySessionId = input.sessionId ?? randomUUID()

  function ensureSession(sessionId: string): AgentSession {
    const existing = sessions.get(sessionId)
    if (existing) return existing
    const session: AgentSession = {
      sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      activeRunIds: [],
      projectRoot,
      metadata: {},
    }
    sessions.set(sessionId, session)
    return session
  }

  return {
    async createSession(createInput?: CreateSessionInput): Promise<AgentSession> {
      const session = ensureSession(primarySessionId)
      if (createInput) {
        session.projectRoot = createInput.projectRoot ?? session.projectRoot
        if (createInput.conversationRef !== undefined) session.conversationRef = createInput.conversationRef
        if (createInput.stableMemoryRef !== undefined) session.stableMemoryRef = createInput.stableMemoryRef
        if (createInput.metadata) session.metadata = { ...session.metadata, ...createInput.metadata }
        session.updatedAt = Date.now()
      }
      return session
    },

    async *run(sessionId: string, runInput: AgentRunInput): AsyncIterable<HarnessEvent> {
      // H1 transition: CLI sessions are runtime-created and switchable, so
      // run() auto-creates unknown sessions. H6 persistence turns
      // createSession() into the mandatory entry and restores
      // SessionNotFoundError semantics here.
      const session = ensureSession(sessionId)
      const registered = registry.create({
        sessionId,
        projectRoot,
        input: runInput,
        onTraceWriteFailure: input.onTraceWriteFailure,
      })
      session.activeRunIds.push(registered.run.runId)
      session.updatedAt = Date.now()

      // H2: RunController drives the lifecycle machine, maps the kernel's
      // final LoopDecision to a RunOutcome, and cleans up exactly once.
      try {
        yield* runControlledRun({
          adapter,
          run: registered.run,
          runInput,
          session,
          controller: registered.controller,
        })
      } finally {
        // H6: persist the terminal state (best-effort, never fails the run).
        // H8: artifact refs are collected from the run's store.
        if (store) {
          const hash = workspaceHash?.()
          const artifactRefs = await collectArtifactRefs(registered.run)
          await store.saveRun(serializeRun({ run: registered.run, workspaceHash: hash, artifactRefs })).catch(() => {})
          await store.saveSnapshot(snapshotFromRun(registered.run, hash, artifactRefs)).catch(() => {})
        }
      }
    },

    async *resume(runId: string, response: InterruptResponse): AsyncIterable<HarnessEvent> {
      // H7: resolve the run — in-memory registry or the persistent store.
      let registered = registry.lookup(runId)
      let savedWorkspaceHash: string | undefined
      let restoreSerializable: SerializableRun | undefined
      if (!registered && store) {
        restoreSerializable = await store.loadRun(runId).catch(() => null) ?? undefined
        if (restoreSerializable) {
          const restored = restoreAgentRun({ serializable: restoreSerializable, projectRoot })
          registered = registry.registerRestored(restored, new AbortController())
          savedWorkspaceHash = restoreSerializable.workspaceHash
          // G0-2: surface a missing/incomplete audit stream on restore.
          await checkTraceIntegrity(store, restoreSerializable)
        }
      }
      if (!registered) {
        registry.requireRun(runId) // throws RunNotFoundError
        return
      }
      const { run } = registered

      // Validate: waiting + pending interrupt + id + schema + workspace.
      const currentHash = savedWorkspaceHash !== undefined && workspaceHash
        ? workspaceHash()
        : undefined
      const validation = validateResume({
        run,
        response,
        savedWorkspaceHash,
        currentWorkspaceHash: currentHash,
      })
      if (!validation.ok) throw validation.error
      const interrupt = validation.interrupt

      // Rejection is a formal branch: rejected → cancelled.
      const payload = response.payload as { accepted?: boolean }
      if (response.accepted === false || payload.accepted === false) {
        markInterruptAnswered(interrupt, false)
        run.status = "cancelled"
        run.finishedAt ??= Date.now()
        run.outcome = { kind: "cancelled", reason: "interrupt_rejected" }
        if (store) {
          const artifactRefs = await collectArtifactRefs(run)
          await store.saveRun(serializeRun({ run, workspaceHash: currentHash, artifactRefs })).catch(() => {})
        }
        return
      }

      markInterruptAnswered(interrupt, true)
      // Continuation input: apply the response for the interrupt kind.
      const resumeInput = applyResponseToInput(run, interrupt.kind, payload)

      // Fresh controller (the waiting run's controller was aborted at cleanup).
      const controller = new AbortController()
      registry.replaceController(runId, controller)

      const session = sessions.get(run.sessionId) ?? ensureSession(run.sessionId)
      session.activeRunIds.push(runId)
      session.updatedAt = Date.now()

      try {
        yield* runControlledRun({
          adapter,
          run,
          runInput: run.input,
          resumeInput,
          session,
          controller,
        })
      } finally {
        if (store) {
          const hash = workspaceHash?.()
          const artifactRefs = await collectArtifactRefs(run)
          await store.saveRun(serializeRun({ run, workspaceHash: hash, artifactRefs })).catch(() => {})
          await store.saveSnapshot(snapshotFromRun(run, hash, artifactRefs)).catch(() => {})
        }
      }
    },

    async cancel(runId: string, reason?: string): Promise<void> {
      const registered = registry.lookup(runId)
      if (!registered) throw new HarnessError("run_not_found", `Harness run not found: ${runId}`, runId)
      if (registered.controller.signal.aborted) return
      registered.controller.abort(reason ?? "cancelled by user")
    },

    async inspect(runId: string): Promise<RunSnapshot> {
      const registered = registry.lookup(runId)
      if (!registered) {
        // H6: historical run — fall back to the persistent store.
        if (store) {
          const serializable = await store.loadRun(runId).catch(() => null)
          if (serializable) {
            const restored = restoreAgentRun({ serializable, projectRoot })
            // G0-2: surface a missing/incomplete audit stream on historical inspect.
            await checkTraceIntegrity(store, serializable)
            return snapshotFromRun(restored, serializable.workspaceHash, serializable.artifactRefs ?? [])
          }
        }
        registry.requireRun(runId) // throws RunNotFoundError
      }
      const { run } = registered!
      const { scope } = run
      return {
        schemaVersion: 1,
        runId: run.runId,
        sessionId: run.sessionId,
        sequence: run.eventSequence,
        status: run.status,
        input: run.input,
        // H3: serializable snapshots of the typed run-scope state (sandbox/
        // cancellation/trace instances are never serialized — H6 reinjects).
        planState: {
          revision: scope.planStore.revision,
          goal: scope.planStore.current?.goal ?? null,
          nodes: scope.planStore.current
            ? scope.planStore.current.nodes.map(n => ({ id: n.id, title: n.title, status: n.status }))
            : null,
        },
        modeState: { mode: scope.modeStore.mode },
        // H4: serializable budget snapshot (limits/used/remaining).
        budgetState: {
          limits: run.budget.limits,
          used: run.budget.used,
          remaining: run.budget.remaining(),
        },
        // H8: serialized evidence entries + the run's artifact refs.
        evidenceState: { entries: serializeLedger(scope.evidenceLedger).entries },
        artifactRefs: await collectArtifactRefs(run),
        conversationRef: "",
        createdAt: run.createdAt,
        interrupt: run.interrupt,
        outcome: run.outcome,
      }
    },

    async dispose(): Promise<void> {
      // H1: nothing to flush — sessions and runs are memory-only.
    },
  }
}

/** H8: collect the run's artifact ids (best-effort, never fails the run). */
async function collectArtifactRefs(run: { scope: { artifactStore: import("../contracts/artifact").ArtifactStore } }): Promise<string[]> {
  try {
    const artifacts = await run.scope.artifactStore.entries()
    return artifacts.map(a => a.artifactId)
  } catch {
    return []
  }
}

/** Apply an interrupt response onto the run's continuation input. */
function applyResponseToInput(
  run: { input: AgentRunInput },
  kind: InterruptKind,
  payload: { accepted?: boolean; planText?: string; answers?: Array<{ questionId?: string; answer: string }> },
): AgentRunInput {
  switch (kind) {
    case "plan_approval":
      return applyPlanApprovalResponse(run.input, { accepted: payload.accepted ?? false, planText: payload.planText })
    case "clarification":
      return applyClarificationResponse(run.input, { answers: payload.answers ?? [] })
    default:
      return run.input
  }
}
