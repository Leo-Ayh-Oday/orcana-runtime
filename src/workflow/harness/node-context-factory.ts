/** MACP-M2: NodeExecutionContext factory for workflow-driven harness nodes.
 *
 *  Creates one NodeExecutionContext per workflow node run over the
 *  environment's shared run scope + run-level budget ledger. runId is the
 *  workflow run's, nodeRunId is unique per node run (H11 contract).
 */

import { randomUUID } from "node:crypto"
import type { NodeExecutionContext } from "../../harness/contracts/nodes"
import { createNodeExecutionContext } from "../../harness/nodes/context"
import { createBudgetLedger } from "../../harness/runtime/budget-ledger"
import type { WorkflowHarnessEnvironment } from "./environment"

/** Per-workflow-run harness runtime: the single scope + budget ledger every
 *  harness node in this workflow run executes against. */
export interface WorkflowHarnessRuntime {
  runId: string
  scope: import("../../harness/contracts/run").AgentRunScope
  budget: import("../../harness/contracts/budget").BudgetLedger
  environment: WorkflowHarnessEnvironment
}

export function createWorkflowHarnessRuntime(environment: WorkflowHarnessEnvironment, runId: string): WorkflowHarnessRuntime {
  return {
    runId,
    scope: environment.scope,
    budget: createBudgetLedger(environment.budgetLimits),
    environment,
  }
}

/** Build the H11 NodeExecutionContext for one workflow node run. */
export function createWorkflowNodeContext(runtime: WorkflowHarnessRuntime, nodeId: string): NodeExecutionContext {
  const run = {
    runId: runtime.runId,
    sessionId: runtime.scope.sessionId,
    status: "running" as const,
    input: { prompt: "" },
    scope: runtime.scope,
    budget: runtime.budget,
    createdAt: Date.now(),
    eventSequence: 0,
    schemaVersion: 1,
  }
  return createNodeExecutionContext({
    run,
    nodeRunId: `${runtime.runId}:${nodeId}:${randomUUID().slice(0, 8)}`,
    capabilities: runtime.environment.capabilities,
    context: runtime.environment.context,
  })
}
