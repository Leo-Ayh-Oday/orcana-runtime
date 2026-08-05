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
import type { AgentRun, AgentRunScope } from "../contracts/run"
import type { CapabilityRegistry } from "../contracts/capability"
import type { ContextSlice } from "../contracts/context"
import type { NodeExecutionContext } from "../contracts/nodes"
import { PermissionGate } from "../../agent/permission"
import { loadUserConfig, loadProjectConfig } from "../../agent/permission-config"
import type { ToolDescriptor } from "../../tools/registry"
import type { NodePolicyContext } from "../capabilities/policy-adapter"
import type { EvidenceLedger, EvidenceEntry } from "../../agent/evidence-ledger"

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

/** R1 evidence diff helpers: NodeResult.evidence = the entries ADDED during
 *  this node run. Snapshot the ledger before the node's work, diff after. */
export function snapshotEvidence(ledger: EvidenceLedger): ReadonlySet<string> {
  return new Set(ledger.entries.map((e) => e.id))
}

export function diffEvidence(ledger: EvidenceLedger, snapshot: ReadonlySet<string>): EvidenceEntry[] {
  return ledger.entries.filter((e) => !snapshot.has(e.id))
}

/** Conservative node-mode policy context (H9 default semantics: unlimited
 *  rate limits, no task tracker, strict permission mode). modeContract
 *  enrichment is deferred to the Node Context work. */
export function createDefaultNodePolicyContext(
  input: Record<string, unknown>,
  tool?: ToolDescriptor,
  toolCallId?: string,
  name?: string,
): NodePolicyContext {
  return {
    permissionGate: new PermissionGate(),
    permissionMode: "strict",
    tool,
    input,
    toolCallId,
    name,
  }
}

/** R1: node-mode policy context derived from the run scope.
 *
 *  Mandatory policy gate (Harness Closure R1): ToolNode always evaluates
 *  policy through a context built from the run scope — the project permission
 *  file under `scope.projectRoot` is loaded the same way the kernel loads it
 *  (kernel/context.ts), so node-mode executions obey the same permission
 *  surface as loop-mode ones. permissionMode is always strict: node mode has
 *  no interactive confirm channel, so "ask" must fail closed.
 */
export function createNodePolicyContextFromRunScope(
  scope: AgentRunScope,
  opts: { input: Record<string, unknown>; tool?: ToolDescriptor; toolCallId?: string; name?: string },
): NodePolicyContext {
  const gate = new PermissionGate()
  gate.loadRules(loadUserConfig()?.rules ?? [], loadProjectConfig(scope.projectRoot)?.rules ?? [])
  return {
    permissionGate: gate,
    permissionMode: "strict",
    tool: opts.tool,
    input: opts.input,
    toolCallId: opts.toolCallId,
    name: opts.name,
    // RT-5: node writes are bounded to the run scope's project root.
    projectRoot: scope.projectRoot,
    writableRoots: [scope.projectRoot],
  }
}
