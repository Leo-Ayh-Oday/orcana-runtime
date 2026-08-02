/** Run registry (H1): in-memory runId → AgentRun + cancellation handle.
 *
 *  H1 keeps the registry memory-only (persistence lands in H6). It owns the
 *  canonical AgentRun object and the AbortController that bridges
 *  AgentHarness.cancel() into the legacy loop's AgentOptions.abortSignal.
 *  Lifecycle transitions are kept to created → running → terminal (H2
 *  introduces the full LifecycleMachine).
 */

import { randomUUID } from "node:crypto"
import type { ModeName } from "../../agent/mode-contract"
import { RunNotFoundError } from "../contracts/errors"
import type { AgentRun } from "../contracts/run"
import { createBudgetLedger, mergeRunBudget } from "./budget-ledger"
import { assembleRunScope } from "./run-scope"

export interface RegisteredRun {
  run: AgentRun
  controller: AbortController
}

export interface CreateRegisteredRunInput {
  sessionId: string
  projectRoot: string
  input: AgentRun["input"]
  activeMode?: ModeName
}

export class RunRegistry {
  private readonly runs = new Map<string, RegisteredRun>()

  create(input: CreateRegisteredRunInput): RegisteredRun {
    const runId = randomUUID()
    const now = Date.now()
    const controller = new AbortController()
    // H4: budget limits — maxRounds maps to maxModelCalls unless the caller
    // set an explicit budget.
    const budget = mergeRunBudget(input.input.budget)
    if (input.input.maxRounds !== undefined && input.input.budget?.maxModelCalls === undefined) {
      budget.maxModelCalls = input.input.maxRounds
    }
    const run: AgentRun = {
      runId,
      sessionId: input.sessionId,
      status: "created",
      input: input.input,
      // H3: typed run-scope — planStore/sandbox/evidenceLedger owned here and
      // wired into the legacy kernel (single source of truth).
      scope: assembleRunScope({
        runId,
        sessionId: input.sessionId,
        projectRoot: input.projectRoot,
        controller,
        activeMode: input.activeMode,
      }),
      budget: createBudgetLedger(budget),
      createdAt: now,
      eventSequence: 0,
      schemaVersion: 1,
    }
    const registered: RegisteredRun = { run, controller }
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

  /** H7: replace the run's cancellation controller (waiting runs were aborted
   *  on cleanup; resume installs a fresh one). */
  replaceController(runId: string, controller: AbortController): RegisteredRun {
    const registered = this.requireRun(runId)
    registered.controller = controller
    return registered
  }

  /** H7: register a restored run (cross-instance resume). */
  registerRestored(run: AgentRun, controller: AbortController): RegisteredRun {
    const registered: RegisteredRun = { run, controller }
    this.runs.set(run.runId, registered)
    return registered
  }

  remove(runId: string): void {
    this.runs.delete(runId)
  }

  get size(): number {
    return this.runs.size
  }
}
