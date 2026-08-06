/** NodeExecutionContext assembly (H11).
 *
 *  budget is the run-level BudgetLedger (AgentRun.budget) — the node mode
 *  must NOT create a second ledger, or model/tool/token would double-count
 *  (H4/H9 budget governance is run-scoped).
 *
 *  context: ContextSlice is INJECTED — callers/tests pre-build a slice via
 *  runContextPipeline + createDefaultContextProviders. H12 adds the
 *  node-mode builder (buildNodeContextSlice): a kernel-side independent
 *  ContextRequest constructed from the run scope, piped through the node
 *  provider allowlist, and trimmed — so workflow nodes get real context
 *  without a kernel round.
 */

import { randomUUID } from "node:crypto"
import type { AgentRun, AgentRunScope } from "../contracts/run"
import type { CapabilityRegistry } from "../contracts/capability"
import type { ContextSlice } from "../contracts/context"
import type { NodeExecutionContext } from "../contracts/nodes"
import { PermissionGate } from "../../agent/permission"
import { loadUserConfig, loadProjectConfig } from "../../agent/permission-config"
import { MODES } from "../../agent/mode-contract"
import type { ToolDescriptor } from "../../tools/registry"
import type { NodePolicyContext } from "../capabilities/policy-adapter"
import type { EvidenceLedger, EvidenceEntry } from "../../agent/evidence-ledger"
import { runContextPipeline, createDefaultContextProviders } from "../context"
import { createNodeContextRequest } from "../context/request"

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

/** H12: node-mode provider allowlist — the providers that contribute
 *  meaningful context for a workflow node with no kernel round state.
 *  research / staged-context / thinking / knowledge / planning / skills are
 *  dropped: their request inputs are kernel-only (research context, staged
 *  files, thinking store, knowledge base, task tracker, skill prompts), so
 *  they have nothing to contribute in node mode. */
export const NODE_SLICE_PROVIDER_ALLOWLIST: ReadonlySet<string> = new Set([
  "lang-instruction",
  "stable-memory",
  "project-kernel",
  "context-map",
  "plan-state",
  "mode-contract",
  "conversation-tail",
])

/** H12: build the node-mode context slice — request constructed from the run
 *  scope (createNodeContextRequest), piped through the allowlisted node
 *  providers, then trimmed so no non-allowlisted contribution can leak into
 *  a node's visible bytes. */
export async function buildNodeContextSlice(
  scope: AgentRunScope,
  input: { prompt: string },
  round: number,
): Promise<ContextSlice> {
  const providers = (await createDefaultContextProviders()).filter((p) => NODE_SLICE_PROVIDER_ALLOWLIST.has(p.id))
  const slice = await runContextPipeline({
    providers,
    request: createNodeContextRequest(scope, input, round),
  })
  return trimNodeSlice(slice)
}

/** H12: structural guarantee that a node's visible context contains only
 *  allowlisted providers (defensive — the pipeline above already runs only
 *  allowlisted providers, but trimming here makes the invariant structural
 *  for any injected slice). */
export function trimNodeSlice(slice: ContextSlice): ContextSlice {
  const keep = (id: string): boolean => NODE_SLICE_PROVIDER_ALLOWLIST.has(id)
  return {
    ...slice,
    contributions: slice.contributions.filter((c) => keep(c.providerId)),
    byProvider: new Map([...slice.byProvider].filter(([id]) => keep(id))),
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
 *
 *  H12: modeContract enrichment — the run's modeStore mode is the authority
 *  (Gate 7 consumes it for tool enforcement), the same source the kernel's
 *  loop path uses via buildLoopOptions.
 */
export function createNodePolicyContextFromRunScope(
  scope: AgentRunScope,
  opts: { input: Record<string, unknown>; tool?: ToolDescriptor; toolCallId?: string; name?: string },
): NodePolicyContext {
  const gate = new PermissionGate()
  // RC-02 B2: 三态消费——损坏配置进入 safe mode，绝不静默退回 allow。
  const userCfg = loadUserConfig()
  const projectCfg = loadProjectConfig(scope.projectRoot)
  const userOverrides = userCfg.status === "valid" ? userCfg.config.categoryOverrides : undefined
  const projectOverrides = projectCfg.status === "valid" ? projectCfg.config.categoryOverrides : undefined
  gate.loadRules(userCfg.status === "valid" ? userCfg.config.rules : [], projectCfg.status === "valid" ? projectCfg.config.rules : [], { ...projectOverrides, ...userOverrides })
  if (userCfg.status === "invalid" || projectCfg.status === "invalid") {
    gate.enterSafeMode("permission 配置损坏——写入/进程/网络一律 ask")
  }
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
    // H12: the run's mode contract rides into node-mode policy (Gate 7).
    modeContract: MODES[scope.modeStore.mode],
  }
}
