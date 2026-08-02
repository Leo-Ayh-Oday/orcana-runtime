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
import type { HarnessArtifact } from "../contracts/artifact"
import type { ArtifactStore } from "../contracts/artifact"
import type { AgentRunScope } from "../contracts/run"
import type { TraceWriter } from "../contracts/scope"
import { createJsonlTraceWriter } from "../telemetry/trace-writer"
import { createRunCancellation } from "./cancellation"

export function defaultSandboxConfig(projectRoot: string): SandboxConfig {
  return {
    projectRoot,
    maxRuntimeSec: Number(process.env.DEEPSEEK_SANDBOX_TIMEOUT_SEC) || 30,
    jobMemoryLimitMb: process.env.DEEPSEEK_SANDBOX_MEMORY_MB ? Number(process.env.DEEPSEEK_SANDBOX_MEMORY_MB) : 512,
  }
}

/** H3 no-op trace bridge (used by tests and callers without a trace dir). */
export function createNoopTraceWriter(): TraceWriter {
  return {
    async append() {},
    async flush() {},
    async close() {},
  }
}

/** H5: JSONL typed trace under .deepseek-code/harness/events/. */
export function createRunTraceWriter(
  projectRoot: string,
  runId: string,
  sessionId: string,
): TraceWriter {
  return createJsonlTraceWriter({
    dir: join(projectRoot, ".deepseek-code", "harness", "events"),
    runId,
    sessionId,
  })
}

/** H3 in-memory artifact store (full integration lands in H8). */
export function createInMemoryArtifactStore(): ArtifactStore {
  const artifacts = new Map<string, HarnessArtifact>()
  return {
    async put(artifact) {
      artifacts.set(artifact.artifactId, artifact)
    },
    async get(artifactId) {
      return artifacts.get(artifactId) ?? null
    },
    async markStale(artifactId) {
      const artifact = artifacts.get(artifactId)
      if (artifact) artifact.status = "stale"
    },
  }
}

export interface AssembleRunScopeInput {
  runId: string
  sessionId: string
  projectRoot: string
  controller: AbortController
  activeMode?: ModeName
}

export function assembleRunScope(input: AssembleRunScopeInput): AgentRunScope {
  const { runId, sessionId, projectRoot, controller } = input
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
    artifactStore: createInMemoryArtifactStore(),
    cancellation: createRunCancellation(controller),
    // H5: typed JSONL trace (H3 no-op replaced).
    trace: createRunTraceWriter(projectRoot, runId, sessionId),
  }
}
