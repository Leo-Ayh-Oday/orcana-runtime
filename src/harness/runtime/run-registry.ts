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
import { resolveMaxRounds } from "../../agent/round/helpers"
import { deriveMaxPhysicalProviderRequests } from "../../runtime/retry/coordinator"
import { assembleRunScope } from "./run-scope"
import { stopServicesForRun } from "../../tools/service"

export interface RegisteredRun {
  run: AgentRun
  controller: AbortController
}

export interface CreateRegisteredRunInput {
  sessionId: string
  projectRoot: string
  input: AgentRun["input"]
  activeMode?: ModeName
  /** G0-2: fail-loud observer for trace batch write failures. */
  onTraceWriteFailure?: (info: { runId: string; batchSize: number; error: unknown }) => void
}

export class RunRegistry {
  private readonly runs = new Map<string, RegisteredRun>()

  create(input: CreateRegisteredRunInput): RegisteredRun {
    const runId = randomUUID()
    const now = Date.now()
    const controller = new AbortController()
    // H4 + IC04 P0-3: physical model-call budget 规则。
    //   explicit budget.maxModelCalls → strict physical cap（保持）。
    //   否则 ORCANA_MAX_PROVIDER_REQUESTS → 否则 derived(logicalMaxRounds)。
    // logicalMaxRounds = resolveMaxRounds(maxRounds, ORCANA_MAX_ROUNDS)。
    // 注意：physical cap 不再 = maxRounds（R=2 → physical=10）；logical
    // round 上限仍由 maxRounds 决定（两者独立）。
    const budget = mergeRunBudget(input.input.budget)
    if (input.input.budget?.maxModelCalls === undefined) {
      const envPhysical = Number(process.env.ORCANA_MAX_PROVIDER_REQUESTS)
      const logicalMaxRounds = resolveMaxRounds(input.input.maxRounds, process.env.ORCANA_MAX_ROUNDS)
      budget.maxModelCalls = Number.isFinite(envPhysical) && envPhysical > 0
        ? Math.floor(envPhysical)
        : deriveMaxPhysicalProviderRequests(logicalMaxRounds)
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
        onTraceWriteFailure: input.onTraceWriteFailure,
        // P0-4: 唯一 RetryCoordinator 在 Run 创建时确定（ledger + physical
        // cap = resolved budget.maxModelCalls）；run 生命周期内不 replace。
        retryCoordinatorCap: budget.maxModelCalls,
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
    // RT-11: run-bound service leases (cleanupPolicy "run-end") must die with
    // their run — otherwise background services leak past the session (TL-014).
    stopServicesForRun(runId)
    this.runs.delete(runId)
  }

  get size(): number {
    return this.runs.size
  }
}
