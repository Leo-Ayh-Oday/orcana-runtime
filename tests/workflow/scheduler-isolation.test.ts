/** G1 acceptance: single node failure does not affect siblings; dependents still run. */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildTool, type ContractToolDescriptor } from "../../src/tools/registry"
import { READ_FILE } from "../../src/tools/file"
import { HandlerRegistry } from "../../src/workflow/execution/handler-registry"
import { runScheduler } from "../../src/workflow/scheduler/scheduler"
import type { WorkflowSpec } from "../../src/workflow/types"

function tools(): ContractToolDescriptor[] {
  return [buildTool(READ_FILE)]
}

describe("G1 failure isolation", () => {
  test("a failing node does not stop its siblings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wflow-g1-iso-"))
    writeFileSync(join(dir, "ok.ts"), "export const ok = 1\n")
    const spec: WorkflowSpec = {
      schemaVersion: "0.1",
      specId: "g1-iso",
      nodes: [
        { id: "tool:good", handler: "tool.read_file", input: { path: join(dir, "ok.ts") }, dependsOn: [] },
        { id: "tool:missing", handler: "tool.read_file", input: { path: join(dir, "does-not-exist.ts") }, dependsOn: [] },
      ],
    }
    const run = await runScheduler(spec, buildTools(), { maxParallel: 2 })
    expect(run.results).toHaveLength(2)
    const good = run.results.find(r => r.nodeId === "tool:good")
    const missing = run.results.find(r => r.nodeId === "tool:missing")
    expect(good!.status).toBe("done")
    expect(missing!.status).toBe("failed")
  })

  test("a dependent still runs after its dependency failed (failed edge passes through)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wflow-g1-dep-"))
    writeFileSync(join(dir, "base.ts"), "export const base = 1\n")
    const spec: WorkflowSpec = {
      schemaVersion: "0.1",
      specId: "g1-depfail",
      nodes: [
        { id: "tool:parent", handler: "tool.read_file", input: { path: join(dir, "nope.ts") }, dependsOn: [] },
        { id: "tool:child", handler: "tool.read_file", input: { path: join(dir, "base.ts") }, dependsOn: ["tool:parent"] },
      ],
    }
    const run = await runScheduler(spec, buildTools(), { maxParallel: 1 })
    expect(run.results.find(r => r.nodeId === "tool:parent")!.status).toBe("failed")
    expect(run.results.find(r => r.nodeId === "tool:child")!.status).toBe("done")
  })
})

function buildTools(): HandlerRegistry {
  const registry = new HandlerRegistry()
  registry.registerTool("tool.read_file", tools()[0]!)
  return registry
}
