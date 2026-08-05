/** G1 acceptance: downstream waits for its dependencies; results are reachable. */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildTool } from "../../src/tools/registry"
import { READ_FILE } from "../../src/tools/file"
import { HandlerRegistry } from "../../src/workflow/execution/handler-registry"
import { runScheduler } from "../../src/workflow/scheduler/scheduler"
import { buildTopology, detectCycle, topologicalOrder } from "../../src/workflow/results/edge-store"
import type { WorkflowSpec } from "../../src/workflow/types"

function readOnlyRegistry(): HandlerRegistry {
  const registry = new HandlerRegistry()
  registry.registerTool("tool.read_file", buildTool(READ_FILE))
  return registry
}

describe("G1 dependency waiting", () => {
  test("diamond DAG: child starts only after both parents finish", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wflow-g1-diamond-"))
    writeFileSync(join(dir, "a.ts"), "export const a = 1\n")
    writeFileSync(join(dir, "b.ts"), "export const b = 2\n")

    const seen: string[] = []
    const spec: WorkflowSpec = {
      schemaVersion: "0.1",
      specId: "g1-diamond",
      nodes: [
        { id: "tool:p1", handler: "tool.read_file", input: { path: join(dir, "a.ts") }, dependsOn: [] },
        { id: "tool:p2", handler: "tool.read_file", input: { path: join(dir, "b.ts") }, dependsOn: [] },
        { id: "tool:child", handler: "tool.read_file", input: { path: join(dir, "a.ts") }, dependsOn: ["tool:p1", "tool:p2"] },
      ],
    }
    await runScheduler(spec, readOnlyRegistry(), {
      maxParallel: 2,
      onNodeFinished: r => seen.push(r.nodeId),
    })

    // child must be last: both parents finish before it starts.
    expect(seen[2]).toBe("tool:child")
    expect(seen.slice(0, 2).sort()).toEqual(["tool:p1", "tool:p2"])
  })

  test("chain: strict ordering with maxParallel=1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wflow-g1-chain-"))
    writeFileSync(join(dir, "x.ts"), "export const x = 1\n")
    const spec: WorkflowSpec = {
      schemaVersion: "0.1",
      specId: "g1-chain",
      nodes: [
        { id: "tool:n1", handler: "tool.read_file", input: { path: join(dir, "x.ts") }, dependsOn: [] },
        { id: "tool:n2", handler: "tool.read_file", input: { path: join(dir, "x.ts") }, dependsOn: ["tool:n1"] },
        { id: "tool:n3", handler: "tool.read_file", input: { path: join(dir, "x.ts") }, dependsOn: ["tool:n2"] },
      ],
    }
    const seen: string[] = []
    await runScheduler(spec, readOnlyRegistry(), { maxParallel: 1, onNodeFinished: r => seen.push(r.nodeId) })
    expect(seen).toEqual(["tool:n1", "tool:n2", "tool:n3"])
  })

  test("edge store: topology, cycle detection, topological order", () => {
    const spec: WorkflowSpec = {
      schemaVersion: "0.1",
      specId: "g1-edges",
      nodes: [
        { id: "a", handler: "x", input: {}, dependsOn: [] },
        { id: "b", handler: "x", input: {}, dependsOn: ["a"] },
        { id: "c", handler: "x", input: {}, dependsOn: ["a", "b"] },
      ],
    }
    const topo = buildTopology(spec)
    expect(topo.indegree.get("a")).toBe(0)
    expect(topo.indegree.get("b")).toBe(1)
    expect(topo.indegree.get("c")).toBe(2)
    expect(detectCycle(spec)).toBeNull()
    expect(topologicalOrder(spec)).toEqual(["a", "b", "c"])
  })

  test("cycle detection rejects cyclic specs", () => {
    const cyclic: WorkflowSpec = {
      schemaVersion: "0.1",
      specId: "g1-cycle",
      nodes: [
        { id: "a", handler: "x", input: {}, dependsOn: ["b"] },
        { id: "b", handler: "x", input: {}, dependsOn: ["a"] },
      ],
    }
    const cycle = detectCycle(cyclic)
    expect(cycle).not.toBeNull()
    expect(cycle!.join(" → ")).toContain("a")
  })
})
