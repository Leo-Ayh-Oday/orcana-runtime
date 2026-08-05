/** G3 write templates: narrow_fix and test_repair (single-writer).
 *
 *  Template structure invariant (enforced at build): every write node must
 *  be followed by a verification node that depends on it — the evidence
 *  gate depends on this shape.
 */

import { stableHash } from "../results/result-hash"
import type { WorkflowSpec, WorkflowNodeSpec } from "../types"
import { normalizeSpec } from "../compiler/graph-normalizer"

export interface WriteTemplateInput {
  path?: string
  query?: string
  files?: string[]
  /** Unified diff to apply (apply_patch input). */
  diff?: string
  /** baseHash for freshness checks. */
  baseHash?: string
}

function verifyNode(id: string, writeNodeId: string, files: string[]): WorkflowNodeSpec {
  return {
    id,
    handler: "tool.run_targeted_verification",
    input: { files },
    dependsOn: [writeNodeId],
  }
}

export function buildNarrowFix(input: WriteTemplateInput): WorkflowSpec {
  const files = input.files ?? []
  const diff = input.diff ?? ""
  const nodes: WorkflowNodeSpec[] = []
  if (input.query) {
    nodes.push({ id: "w:find", handler: "tool.find_symbol", input: { query: input.query, path: input.path }, dependsOn: [] })
  }
  if (files.length > 0) {
    nodes.push({ id: "w:read", handler: "tool.read_file", input: { path: files[0] ?? "" }, dependsOn: input.query ? ["w:find"] : [] })
  }
  nodes.push({
    id: "w:patch",
    handler: "tool.apply_patch",
    input: { patches: [{ diff, baseHash: input.baseHash }] },
    dependsOn: files.length > 0 ? ["w:read"] : input.query ? ["w:find"] : [],
  })
  nodes.push(verifyNode("w:verify", "w:patch", files))
  return {
    schemaVersion: "0.1",
    specId: `narrow-fix-${stableHash({ diff, query: input.query }).slice(0, 8)}`,
    mode: "read-write",
    nodes,
  }
}

export function buildTestRepair(input: WriteTemplateInput): WorkflowSpec {
  const files = input.files ?? []
  const nodes: WorkflowNodeSpec[] = [
    { id: "t:run", handler: "tool.run_process", input: { command: "bun", args: ["test"], cwd: input.path }, dependsOn: [] },
  ]
  if (files.length > 0) {
    nodes.push({ id: "t:read", handler: "tool.read_file", input: { path: files[0] ?? "" }, dependsOn: ["t:run"] })
  }
  nodes.push({
    id: "t:patch",
    handler: "tool.apply_patch",
    input: { patches: [{ diff: input.diff ?? "", baseHash: input.baseHash }] },
    dependsOn: files.length > 0 ? ["t:read"] : ["t:run"],
  })
  nodes.push(verifyNode("t:verify", "t:patch", files))
  return {
    schemaVersion: "0.1",
    specId: `test-repair-${stableHash({ diff: input.diff }).slice(0, 8)}`,
    mode: "read-write",
    nodes,
  }
}
