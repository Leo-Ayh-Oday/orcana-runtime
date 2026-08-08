/** Run-scope assembly (H3): build the typed AgentRunScope per run.
 *
 *  Creates the run-owned instances (planStore, sandbox, evidenceLedger) and
 *  bridges the cancellation controller / no-op trace into their contracts.
 *  mode/patch/ripple are initial snapshots in H3 — the authoritative stores
 *  still live in the kernel's AsyncLocalStorage per-run context; the
 *  ALS→scope migration is tracked for H4/H5.
 */

import { join } from "node:path"
import { createPlanStore } from "../../agent/run/plan-store"
import { createEvidenceLedger } from "../../agent/evidence-ledger"
import type { ModeName } from "../../agent/mode-contract"
import { SandboxManager, type SandboxConfig } from "../../sandbox/sandbox"
import type { AgentRunScope } from "../contracts/run"
import type { TraceWriter } from "../contracts/scope"
import { createArtifactStore } from "../artifacts/artifact-store"
import { createJsonlTraceWriter } from "../telemetry/trace-writer"
import { createRunCancellation } from "./cancellation"
import { createRetryLedger } from "../../runtime/retry-ledger"

export function defaultSandboxConfig(projectRoot: string): SandboxConfig {
  return {
    projectRoot,
    maxRuntimeSec: Number(process.env.ORCANA_SANDBOX_TIMEOUT_SEC) || 30,
    jobMemoryLimitMb: process.env.ORCANA_SANDBOX_MEMORY_MB ? Number(process.env.ORCANA_SANDBOX_MEMORY_MB) : 512,
  }
}

/** H3 no-op trace bridge (used by tests and callers without a trace dir). */
export function createNoopTraceWriter(): TraceWriter {
  return {
    async append() {},
    async flush() {},
    async close() {},
    writeFailures() {
      return 0
    },
    pendingEvents() {
      return 0
    },
  }
}

/** H5: JSONL typed trace under .orcana/harness/events/. */
export function createRunTraceWriter(
  projectRoot: string,
  runId: string,
  sessionId: string,
  onTraceWriteFailure?: (info: { runId: string; batchSize: number; error: unknown }) => void,
): TraceWriter {
  return createJsonlTraceWriter({
    dir: join(projectRoot, ".orcana", "harness", "events"),
    runId,
    sessionId,
    onWriteFailure: onTraceWriteFailure,
  })
}

export interface AssembleRunScopeInput {
  runId: string
  sessionId: string
  projectRoot: string
  controller: AbortController
  activeMode?: ModeName
  /** G0-2: fail-loud observer for trace batch write failures. */
  onTraceWriteFailure?: (info: { runId: string; batchSize: number; error: unknown }) => void
}

export function assembleRunScope(input: AssembleRunScopeInput): AgentRunScope {
  const { runId, sessionId, projectRoot, controller, onTraceWriteFailure } = input
  return {
    runId,
    sessionId,
    projectRoot,
    planStore: createPlanStore(),
    modeStore: { mode: input.activeMode ?? "coder" },
    patchContext: null,
    sandbox: new SandboxManager(defaultSandboxConfig(projectRoot)),
    rippleSession: { obligations: [], cascadeFiles: [] },
    evidenceLedger: createEvidenceLedger(),
    artifactStore: createArtifactStore(),
    cancellation: createRunCancellation(controller),
    // H5: typed JSONL trace (H3 no-op replaced).
    trace: createRunTraceWriter(projectRoot, runId, sessionId, onTraceWriteFailure),
    // PR-GATE-06：Run 级统一重试预算（provider/capability/repair 共享）。
    retryLedger: createRetryLedger(),
  }
}
