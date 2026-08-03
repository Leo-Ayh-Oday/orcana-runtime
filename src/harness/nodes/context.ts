/** NodeExecutionContext assembly (H11).
 *
 *  budget is the run-level BudgetLedger (AgentRun.budget) — the node mode
 *  must NOT create a second ledger, or model/tool/token would double-count
 *  (H4/H9 budget governance is run-scoped).
 *
 *  context: ContextSlice is INJECTED — H11 does not build a kernel-side
 *  ContextRequest (that would need a full RunPhaseContext); callers/tests
 *  pre-build a slice via runContextPipeline + createDefaultContextProviders.
 *  Node-mode slice budgeting and the conversation-tail lands with H12.
 */

import { randomUUID } from "node:crypto"
import type { AgentRun } from "../contracts/run"
import type { CapabilityRegistry } from "../contracts/capability"
import type { ContextSlice } from "../contracts/context"
import type { NodeExecutionContext } from "../contracts/nodes"
import { PermissionGate } from "../../agent/permission"
import type { NodePolicyContext } from "../capabilities/policy-adapter"

export function createNodeRunId(): string {
  return randomUUID()
}

/** Minimal empty slice for nodes that don't need pre-built context. */
export function createMinimalContextSlice(): ContextSlice {
  return {
    contributions: [],
    byProvider: new Map(),
    dropped: [],
    budget: { allocatedTokens: {}, totalTokens: 0, trimmedTokens: 0 },
    cachePrefixKeys: [],
    warnings: [],
  }
}

export interface CreateNodeExecutionContextInput {
  run: AgentRun
  nodeRunId?: string
  capabilities: CapabilityRegistry
  /** Injected ContextSlice; defaults to a minimal empty slice. */
  context?: ContextSlice
}

export function createNodeExecutionContext(input: CreateNodeExecutionContextInput): NodeExecutionContext {
  return {
    runId: input.run.runId,
    nodeRunId: input.nodeRunId ?? createNodeRunId(),
    runScope: input.run.scope,
    capabilities: input.capabilities,
    context: input.context ?? createMinimalContextSlice(),
    budget: input.run.budget,
    cancellation: input.run.scope.cancellation,
    artifacts: input.run.scope.artifactStore,
    trace: input.run.scope.trace,
  }
}

/** Conservative node-mode policy context (H9 default semantics: unlimited
 *  rate limits, no task tracker, strict permission mode). modeContract
 *  enrichment is deferred to H12 node context work. */
export function createDefaultNodePolicyContext(input: Record<string, unknown>): NodePolicyContext {
  return {
    permissionGate: new PermissionGate(),
    permissionMode: "strict",
    input,
  }
}
