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
import type { InterruptResponse } from "../contracts/interrupt"
import type { RunSnapshot } from "../contracts/snapshot"
import { RunRegistry } from "./run-registry"
import { runControlledRun } from "./run-controller"
import { createLegacyLoopAdapter, type LegacyLoopAdapter, type LegacyLoopAdapterDeps } from "./legacy-loop-adapter"

export interface AgentHarnessInput {
  deps: LegacyLoopAdapterDeps
  /** Optional stable session id; otherwise created on first use. */
  sessionId?: string
  projectRoot?: string
}

export function createAgentHarness(input: AgentHarnessInput): AgentHarness {
  const registry = new RunRegistry()
  const adapter: LegacyLoopAdapter = createLegacyLoopAdapter({ deps: input.deps })
  const projectRoot = input.projectRoot ?? process.cwd()

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
      })
      session.activeRunIds.push(registered.run.runId)
      session.updatedAt = Date.now()

      // H2: RunController drives the lifecycle machine, maps the kernel's
      // final LoopDecision to a RunOutcome, and cleans up exactly once.
      yield* runControlledRun({
        adapter,
        run: registered.run,
        runInput,
        session,
        controller: registered.controller,
      })
    },

    async *resume(_runId: string, _response: InterruptResponse): AsyncIterable<HarnessEvent> {
      // H7 introduces persistent interrupts and resume; the H1 facade keeps
      // the signature (per H0 contract) and fails loudly rather than
      // pretending to resume a legacy re-invocation.
      throw new HarnessError("internal", "resume() lands in H7 (persistent interrupts); H1 runs are re-invoked via run()")
    },

    async cancel(runId: string, reason?: string): Promise<void> {
      const registered = registry.lookup(runId)
      if (!registered) throw new HarnessError("run_not_found", `Harness run not found: ${runId}`, runId)
      if (registered.controller.signal.aborted) return
      registered.controller.abort(reason ?? "cancelled by user")
    },

    async inspect(runId: string): Promise<RunSnapshot> {
      const registered = registry.requireRun(runId)
      const { run } = registered
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
        evidenceState: { entries: scope.evidenceLedger.entries.length },
        artifactRefs: [],
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
