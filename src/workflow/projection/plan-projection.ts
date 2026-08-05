/** Plan projection (G2): WorkflowRunResult → MasterPlan status write-back.
 *
 *  The adapter preserves original plan node ids under the "plan:<id>"
 *  prefix, so a finished run can project back onto the plan: done → done,
 *  failed → blocked, evidence summary from the result output.
 */

import type { WorkflowNodeResult, WorkflowRunResult } from "../types"

export interface PlanStatusProjection {
  nodeId: string
  status: "done" | "blocked"
  evidence?: string
}

export function projectResultsToPlan(
  run: WorkflowRunResult,
  originalNodeIds: string[],
): PlanStatusProjection[] {
  const byId = new Map<string, WorkflowNodeResult>()
  for (const result of run.results) byId.set(result.nodeId, result)

  return originalNodeIds.map(id => {
    const result = byId.get(`plan:${id}`)
    if (!result) {
      return { nodeId: id, status: "blocked" as const, evidence: undefined }
    }
    const evidence = summarize(result)
    return {
      nodeId: id,
      status: result.status === "done" ? "done" : "blocked",
      evidence,
    }
  })
}

function summarize(result: WorkflowNodeResult): string | undefined {
  if (result.status === "failed") return undefined
  const output = result.output as { content?: unknown; metadata?: Record<string, unknown> } | null
  if (!output) return undefined
  const content = typeof output.content === "string" ? output.content : ""
  const head = content.replace(/\s+/g, " ").trim().slice(0, 80)
  if (head) return head
  return undefined
}
