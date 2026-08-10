/** MACP-M2: H11 NodeResult → WorkflowNodeResult adapter.
 *
 *  Preserves Evidence, Diagnostics and Usage (M2 task 5): the workflow
 *  result carries the harness node's evidence entries, diagnostics and usage
 *  verbatim, plus a structured errorKind so downstream policy can branch on
 *  budget exhaustion / policy blocks / cancellation without string matching.
 */

import type { NodeResult } from "../../harness/contracts/nodes"
import type { WorkflowNodeResult } from "../types"

export interface AdaptNodeResultOptions {
  nodeId: string
  startedAt: number
}

/** NodeResult.status → workflow status:
 *  succeeded → done; failed → failed; blocked → blocked (kept distinct so
 *  M1 conditional dependencies can react to it); cancelled → failed (with
 *  the cancellation reason structured). */
export function adaptNodeResult(nodeResult: NodeResult, options: AdaptNodeResultOptions): WorkflowNodeResult {
  const finishedAt = Date.now()
  const base: WorkflowNodeResult = {
    nodeId: options.nodeId,
    status: "done",
    output: nodeResult.output ?? null,
    startedAt: options.startedAt,
    finishedAt,
    durationMs: finishedAt - options.startedAt,
    usage: nodeResult.usage,
    diagnostics: nodeResult.diagnostics,
    evidence: nodeResult.evidence,
  }
  switch (nodeResult.status) {
    case "succeeded":
      return base
    case "failed":
      return {
        ...base,
        status: "failed",
        output: null,
        error: nodeResult.error?.message ?? "harness node failed",
        errorKind: nodeResult.error?.kind ?? "node_failed",
      }
    case "blocked":
      return {
        ...base,
        status: "blocked",
        output: null,
        error: nodeResult.error?.message ?? "harness node blocked",
        errorKind: nodeResult.error?.kind ?? "node_blocked",
      }
    case "cancelled":
      return {
        ...base,
        status: "failed",
        output: null,
        error: nodeResult.error?.message ?? "harness node cancelled",
        errorKind: "cancelled",
      }
    case "paused":
      // TB2-1: 轮次耗尽/暂停 = incomplete，不是成功——workflow 侧映射为
      // blocked（可恢复）而非 done。
      return {
        ...base,
        status: "blocked",
        output: null,
        error: nodeResult.error?.message ?? "harness node paused (incomplete)",
        errorKind: "node_paused",
      }
  }
}
