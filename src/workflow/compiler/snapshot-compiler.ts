/** Snapshot compiler (G1): WorkflowSnapshot → executable WorkflowSpec.
 *
 *  This is the G1 input bridge: it takes the shadow graph produced by the
 *  G0 projector and compiles its READ-ONLY portion into a runnable spec.
 *  Only tool nodes map to handlers; gate/verification/plan/round nodes are
 *  skipped (not executable in the read-only scheduler); write tools are
 *  rejected.
 *
 *  G1 tool nodes are dependency-free (true read-only parallelism) — round
 *  ordering and real data edges arrive with the G2 compiler.
 */

import type { WorkflowSnapshot, WorkflowSpec, WorkflowNodeSpec } from "../types"

const READONLY_HANDLERS: Record<string, string> = {
  read_file: "tool.read_file",
  find_symbol: "tool.find_symbol",
  find_references: "tool.find_references",
  project_structure: "tool.project_structure",
  git_diff: "tool.git_diff",
  git_status: "tool.git_status",
}

export function compileFromSnapshot(snapshot: WorkflowSnapshot, specId = snapshot.runId): WorkflowSpec {
  const nodes: WorkflowNodeSpec[] = []
  for (const node of snapshot.nodes) {
    if (node.kind !== "tool") continue
    const handler = READONLY_HANDLERS[node.name]
    if (!handler) {
      throw new Error(`workflow: tool "${node.name}" is not a read-only handler (G1)`)
    }
    nodes.push({
      id: node.id,
      handler,
      input: {},
      dependsOn: [],
    })
  }
  return { schemaVersion: "0.1", specId, nodes }
}
