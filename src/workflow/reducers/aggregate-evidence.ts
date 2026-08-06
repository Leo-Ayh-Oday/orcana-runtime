/** Aggregate evidence (G3): verification results → evidence bound to write nodes.
 *
 *  Template structure is "write node → verification node" (the verification
 *  node depends on the write node it verifies). This reducer maps each
 *  verification node result to an evidence entry binding the write node ids,
 *  so the completion gate can enforce "no Evidence ⇒ no completion".
 */

import type { WorkflowNodeResult, WorkflowSpec } from "../types"

export interface EvidenceEntry {
  nodeId: string
  writeNodeIds: string[]
  passed: boolean
  summary?: string
}

/** Which handlers are verification producers (G3 whitelist). */
const VERIFICATION_HANDLERS = new Set([
  "tool.run_targeted_verification",
])

export function aggregateEvidence(spec: WorkflowSpec, results: WorkflowNodeResult[]): EvidenceEntry[] {
  const byId = new Map(results.map(r => [r.nodeId, r]))
  const specNodes = new Map(spec.nodes.map(n => [n.id, n]))
  const isWriteNode = (id: string): boolean => {
    const node = specNodes.get(id)
    if (!node) return false
    // M7: H11 tool nodes (execution.kind === "tool") are write-class when
    // their capability declares sideEffect "write" — the scheduler's
    // writeNodeIds already classified them; here we conservatively bind
    // every harness tool node so verification evidence never detaches
    // from an H11 write it verifies.
    return WRITE_NODE_HANDLERS.has(node.handler) || node.execution?.kind === "tool"
  }

  const entries: EvidenceEntry[] = []
  for (const node of spec.nodes) {
    if (!VERIFICATION_HANDLERS.has(node.handler)) continue
    const result = byId.get(node.id)
    if (!result) continue
    const writeNodeIds = node.dependsOn
      .map(dep => (typeof dep === "string" ? dep : dep.nodeId))
      .filter(isWriteNode)
    if (writeNodeIds.length === 0) continue
    entries.push({
      nodeId: node.id,
      writeNodeIds,
      passed: result.status === "done",
      summary: summarize(result),
    })
  }
  return entries
}

function summarize(result: WorkflowNodeResult): string | undefined {
  if (result.status === "failed") return undefined
  const output = result.output as { content?: unknown } | null
  const content = typeof output?.content === "string" ? output.content : ""
  const head = content.replace(/\s+/g, " ").trim().slice(0, 120)
  return head || undefined
}

const WRITE_NODE_HANDLERS = new Set([
  "tool.apply_patch",
  "tool.run_process",
])
