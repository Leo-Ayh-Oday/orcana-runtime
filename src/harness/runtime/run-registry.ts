/** Run registry (H1): in-memory runId → AgentRun + cancellation handle.
 *
 *  H1 keeps the registry memory-only (persistence lands in H6). It owns the
 *  canonical AgentRun object and the AbortController that bridges
 *  AgentHarness.cancel() into the legacy loop's AgentOptions.abortSignal.
 *  Lifecycle transitions are kept to created → running → terminal (H2
 *  introduces the full LifecycleMachine).
 */

import { randomUUID } from "node:crypto"
import { RunNotFoundError } from "../contracts/errors"
import { isTerminalRunStatus, type AgentRun, type RunStatus } from "../contracts/run"

export interface RegisteredRun {
  run: AgentRun
  controller: AbortController
}

export interface CreateRegisteredRunInput {
  sessionId: string
  projectRoot: string
  input: AgentRun["input"]
}

export class RunRegistry {
  private readonly runs = new Map<string, RegisteredRun>()

  create(input: CreateRegisteredRunInput): RegisteredRun {
    const runId = randomUUID()
    const now = Date.now()
    const run: AgentRun = {
      runId,
      sessionId: input.sessionId,
      status: "created",
      input: input.input,
      // H1: no run-bound state objects yet — scope fields are placeholders
      // per H0 (unknown) and get real types in H3; budget ledger lands in H4.
      scope: {
        runId,
        sessionId: input.sessionId,
        projectRoot: input.projectRoot,
        planStore: undefined,
        modeStore: undefined,
        patchContext: undefined,
        sandbox: undefined,
        rippleSession: undefined,
        evidenceLedger: undefined,
        artifactStore: undefined,
        cancellation: undefined,
        trace: undefined,
      },
      budget: undefined as never,
      createdAt: now,
      eventSequence: 0,
      schemaVersion: 1,
    }
    const registered: RegisteredRun = { run, controller: new AbortController() }
    this.runs.set(runId, registered)
    return registered
  }

  lookup(runId: string): RegisteredRun | undefined {
    return this.runs.get(runId)
  }

  requireRun(runId: string): RegisteredRun {
    const found = this.lookup(runId)
    if (!found) throw new RunNotFoundError(runId)
    return found
  }

  /** H1 minimal transition helper; H2 replaces with LifecycleMachine. */
  setStatus(runId: string, status: RunStatus): void {
    const registered = this.requireRun(runId)
    registered.run.status = status
    if (status === "running" && !registered.run.startedAt) {
      registered.run.startedAt = Date.now()
    }
    if (isTerminalRunStatus(status)) {
      registered.run.finishedAt ??= Date.now()
    }
  }

  remove(runId: string): void {
    this.runs.delete(runId)
  }

  get size(): number {
    return this.runs.size
  }
}
