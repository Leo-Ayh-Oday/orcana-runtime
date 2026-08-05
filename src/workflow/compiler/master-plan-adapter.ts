/** MasterPlan adapter (G2): MasterPlan (+TaskPackets) → WorkflowSpec.
 *
 *  Kernel-zero-intrusion: this adapter only READS the plan types
 *  (PlanNode.dependsOn / _packet). Nodes with a TaskPacket compile their
 *  goal/scope into the node input; nodes without one are inferred from the
 *  plan intent for the read-only template scenarios, or fail loudly.
 *
 *  Stable graph: specId = stableHash(goal + ordered node identities).
 */

import { stableHash } from "../results/result-hash"
import type { WorkflowSpec, WorkflowNodeSpec } from "../types"
import { normalizeSpec } from "./graph-normalizer"

export interface PlanLikeNode {
  id: string
  title: string
  dependsOn: string[]
  blockedBy?: string[]
  _packet?: {
    goal?: string
    scope?: string[]
    doneCriteria?: string[]
    contextBudget?: { maxToolCalls?: number }
  }
}

export interface PlanLike {
  goal: string
  intent?: string
  nodes: PlanLikeNode[]
}

/** Handler inference for packet-less nodes (read-only template scenarios).
 *  Title matches first; the plan intent is only a fallback so a global
 *  intent cannot override a node's specific title. */
function inferHandler(intent: string | undefined, title: string): string | undefined {
  const t = title.toLowerCase()
  if (/状态|变更|历史|差异|提交|git|status|changes|history|diff/.test(t)) return "tool.git_status"
  if (/结构|目录|概览|树|structure|tree|overview/.test(t)) return "tool.project_structure"
  if (/符号|引用|解释|理解|symbol|reference|explain/.test(t)) return "tool.find_symbol"
  const i = (intent ?? "").toLowerCase()
  if (/explain|解释|理解/.test(i)) return "tool.find_symbol"
  if (/structure|结构|概览/.test(i)) return "tool.project_structure"
  return undefined
}

export function compileMasterPlan(plan: PlanLike): WorkflowSpec {
  const nodes: WorkflowNodeSpec[] = []
  for (const node of plan.nodes) {
    const packet = node._packet
    let handler: string | undefined
    let input: Record<string, unknown> = {}

    if (packet) {
      // TaskPacket-bearing nodes: read-only intent mapping (G3 will bind
      // write handlers for narrow-fix / test-repair templates).
      const text = `${packet.goal ?? ""} ${node.title}`.toLowerCase()
      if (/read|explain|analyze|research|inspect|audit/.test(text)) {
        handler = "tool.read_file"
        input = { scope: packet.scope ?? [] }
      } else if (/symbol|find|reference/.test(text)) {
        handler = "tool.find_symbol"
        input = { query: node.title }
      } else if (/structure|overview/.test(text)) {
        handler = "tool.project_structure"
        input = { scope: packet.scope ?? [] }
      } else {
        handler = "tool.read_file"
        input = { scope: packet.scope ?? [], goal: packet.goal }
      }
    } else {
      handler = inferHandler(plan.intent, node.title)
      if (!handler) {
        throw new Error(
          `workflow: cannot compile plan node "${node.id}" (${node.title}) to a read-only handler — ` +
          "give it a TaskPacket or use a research/audit/explain intent",
        )
      }
    }

    const deps = [...new Set([...(node.dependsOn ?? []), ...(node.blockedBy ?? [])])]
      .map(dep => (dep.startsWith("plan:") ? dep : `plan:${dep}`))
    nodes.push({ id: `plan:${node.id}`, handler, input, dependsOn: deps })
  }

  const identity = stableHash({
    goal: plan.goal,
    nodes: nodes.map(n => ({ id: n.id, handler: n.handler, deps: n.dependsOn })),
  })
  const spec: WorkflowSpec = {
    schemaVersion: "0.1",
    specId: `plan-${identity.slice(0, 12)}`,
    nodes,
  }
  return normalizeSpec(spec)
}
