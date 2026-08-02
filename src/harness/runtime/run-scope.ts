/** Run-scope assembly (H3): build the typed AgentRunScope per run.
 *
 *  Creates the run-owned instances (planStore, sandbox, evidenceLedger) and
 *  bridges the cancellation controller / no-op trace into their contracts.
 *  mode/patch/ripple are initial snapshots in H3 — the authoritative stores
 *  still live in the kernel's AsyncLocalStorage per-run context; the
 *  ALS→scope migration is tracked for H4/H5.
 */

import { createPlanStore } from "../../agent/run/plan-store"
import { createEvidenceLedger } from "../../agent/evidence-ledger"
import type { ModeName } from "../../agent/mode-contract"
import { SandboxManager, type SandboxConfig } from "../../sandbox/sandbox"
import type { HarnessArtifact } from "../contracts/artifact"
import type { ArtifactStore } from "../contracts/artifact"
import type { AgentRunScope } from "../contracts/run"
import type { TraceWriter } from "../contracts/scope"
import { createRunCancellation } from "./cancellation"

export function defaultSandboxConfig(projectRoot: string): SandboxConfig {
  return {
    projectRoot,
    maxRuntimeSec: Number(process.env.DEEPSEEK_SANDBOX_TIMEOUT_SEC) || 30,
    jobMemoryLimitMb: process.env.DEEPSEEK_SANDBOX_MEMORY_MB ? Number(process.env.DEEPSEEK_SANDBOX_MEMORY_MB) : 512,
  }
}

/** H3 no-op trace bridge; the typed envelope writer lands in H5. */
export function createNoopTraceWriter(): TraceWriter {
  return {
    async append() {},
    async flush() {},
    async close() {},
  }
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
    trace: createNoopTraceWriter(),
  }
}
