/** MACP-M2: workflow-side harness environment.
 *
 *  The workflow runtime is a *consumer* of the H11 Unified Node Runtime:
 *  every model/tool/verification/human node executes as a HarnessNode under
 *  a single run-level BudgetLedger, AgentRunScope (evidence ledger +
 *  artifact store + trace + cancellation) and CapabilityRegistry — the same
 *  ones the harness itself uses. The workflow never constructs a second
 *  budget or model path (plan §23: one source of truth).
 *
 *  The environment is constructed by the caller (the harness / future
 *  coordination layer); SchedulerOptions.harness carries it into
 *  runScheduler. Nodes that declare an H11 execution kind but run with no
 *  environment fail closed (H11_ADAPTER: a declared harness node can never
 *  silently fall back to a handler bypass).
 */

import type { AgentRunScope } from "../../harness/contracts/run"
import type { CapabilityRegistry } from "../../harness/contracts/capability"
import type { RunBudget } from "../../harness/contracts/budget"
import type { LegacyLoopAdapterDeps } from "../../harness/runtime/legacy-loop-adapter"
import type { ToolDescriptor } from "../../tools/registry"
import type { JsonSchema } from "../../harness/contracts/schema"
import type { InterruptKind } from "../../harness/contracts/interrupt"

/** Optional hooks for the harness execution path (M2 task 3 bindings).
 *  All are optional — the workflow builds its own defaults where the
 *  environment is silent, but the *authority* (scope, budget limits,
 *  capabilities, loop deps) always comes from the environment. */
export interface WorkflowHarnessEnvironment {
  /** Run-scoped state: evidence ledger, artifact store, trace, cancellation,
   *  project root. One scope per workflow run — shared by every harness node. */
  scope: AgentRunScope

  /** Budget limits for the run-level ledger (single ledger for the run). */
  budgetLimits: RunBudget

  /** Capability registry (H9) — ToolNode resolves capabilities here. */
  capabilities: CapabilityRegistry

  /** Tool descriptors for policy resolution (category/risk/readonly). */
  tools?: ToolDescriptor[]

  /** LlmAgentNode runtime deps (provider, tool set, hooks, …). */
  loopDeps?: LegacyLoopAdapterDeps

  /** HumanNode responder; absent → human nodes fail closed (no responder). */
  respond?: (interrupt: {
    interruptId: string
    kind: InterruptKind
    prompt: string
    responseSchema: JsonSchema
  }) => Promise<unknown>

  /** Node context slice; defaults to a minimal empty slice. */
  context?: import("../../harness/contracts/context").ContextSlice
}

export function isWorkflowHarnessEnvironment(value: unknown): value is WorkflowHarnessEnvironment {
  return (
    typeof value === "object" &&
    value !== null &&
    "scope" in value &&
    "budgetLimits" in value &&
    "capabilities" in value
  )
}
