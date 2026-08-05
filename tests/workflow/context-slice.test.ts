/** G5 acceptance: context slices never inherit unrelated history (PR-G5). */

import { describe, expect, test } from "bun:test"
import { buildContextSlice } from "../../src/workflow/context/context-slice"
import type { WorkflowNodeSpec, WorkflowNodeResult } from "../../src/workflow/types"

function result(nodeId: string, output: unknown): WorkflowNodeResult {
  return { nodeId, status: "done", output, startedAt: 0, finishedAt: 1, durationMs: 1 }
}

describe("G5 context slice", () => {
  const spec: WorkflowNodeSpec[] = [
    { id: "a", handler: "tool.read_file", input: { path: "a.ts" }, dependsOn: [] },
    { id: "b", handler: "tool.read_file", input: { path: "b.ts" }, dependsOn: ["a"] },
    { id: "c", handler: "tool.read_file", input: { path: "c.ts" }, dependsOn: ["b"] },
    { id: "x", handler: "tool.read_file", input: { path: "x.ts" }, dependsOn: [] },
  ]
  const results = [
    result("a", { content: "aa" }),
    result("b", { content: "bb" }),
    result("c", { content: "cc" }),
    result("x", { content: "xx" }),
  ]

  test("slice contains only the node's own input and direct dependencies", () => {
    const slice = buildContextSlice(spec[2]!, results)
    expect(slice.nodeId).toBe("c")
    expect(slice.input).toEqual({ path: "c.ts" })
    expect(slice.dependencies.map(d => d.nodeId)).toEqual(["b"])
    expect(slice.dependencies[0]!.output).toEqual({ content: "bb" })
  })

  test("unrelated sibling nodes never enter the slice", () => {
    const slice = buildContextSlice(spec[2]!, results)
    const ids = [slice.nodeId, ...slice.dependencies.map(d => d.nodeId)]
    expect(ids).not.toContain("x")
    expect(ids).not.toContain("a")
  })

  test("root node (no dependencies) has an empty dependency list", () => {
    const slice = buildContextSlice(spec[0]!, results)
    expect(slice.dependencies).toEqual([])
  })

  test("failed dependencies are surfaced with status", () => {
    const dep = { nodeId: "d", status: "failed" as const, output: null, error: "boom", startedAt: 0, finishedAt: 1, durationMs: 1 }
    const slice = buildContextSlice(
      { id: "z", handler: "tool.read_file", input: {}, dependsOn: ["d"] },
      [...results, dep],
    )
    expect(slice.dependencies).toHaveLength(1)
    expect(slice.dependencies[0]!.status).toBe("failed")
  })

  test("missing dependency results are skipped, not leaked as undefined", () => {
    const slice = buildContextSlice(
      { id: "z", handler: "tool.read_file", input: {}, dependsOn: ["ghost", "a"] },
      results,
    )
    expect(slice.dependencies.map(d => d.nodeId)).toEqual(["a"])
  })
})
