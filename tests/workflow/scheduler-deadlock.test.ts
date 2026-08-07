/** G1 acceptance: no deadlock — cycles rejected up front, run terminates. */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildTool } from "../../src/tools/registry"
import { READ_FILE } from "../../src/tools/file"
import { HandlerRegistry } from "../../src/workflow/execution/handler-registry"
import { runScheduler } from "../../src/workflow/scheduler/scheduler"
import type { WorkflowSpec } from "../../src/workflow/types"

function registry(): HandlerRegistry {
  const r = new HandlerRegistry()
  r.registerTool("tool.read_file", buildTool(READ_FILE))
  return r
}

describe("G1 deadlock guard", () => {
  test("cyclic spec is rejected before execution", async () => {
    const spec: WorkflowSpec = {
      schemaVersion: "0.1",
      specId: "g1-dl1",
      nodes: [
        { id: "a", handler: "tool.read_file", input: { path: "/tmp/x" }, dependsOn: ["b"] },
        { id: "b", handler: "tool.read_file", input: { path: "/tmp/x" }, dependsOn: ["a"] },
      ],
    }
    await expect(runScheduler(spec, registry())).rejects.toThrow(/cycle/)
  })

  test("self-loop is rejected", async () => {
    const spec: WorkflowSpec = {
      schemaVersion: "0.1",
      specId: "g1-dl2",
      nodes: [
        { id: "a", handler: "tool.read_file", input: { path: "/tmp/x" }, dependsOn: ["a"] },
      ],
    }
    await expect(runScheduler(spec, registry())).rejects.toThrow(/cycle/)
  })

  test("a run with all results restored does not hang", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wflow-g1-restore-"))
    writeFileSync(join(dir, "f.ts"), "export const f = 1\n")
    const spec: WorkflowSpec = {
      schemaVersion: "0.1",
      specId: "g1-restore",
      nodes: [
        { id: "tool:a", handler: "tool.read_file", input: { path: join(dir, "f.ts") }, dependsOn: [] },
        { id: "tool:b", handler: "tool.read_file", input: { path: join(dir, "f.ts") }, dependsOn: ["tool:a"] },
      ],
    }
    // Run once with checkpointing…
    const checkpointDir = mkdtempSync(join(tmpdir(), "wflow-g1-cp-"))
    const first = await runScheduler(spec, registry(), { checkpointDir, projectRoot: dir })
    expect(first.results).toHaveLength(2)

    // …then re-run: restored results must be honored without re-execution or hangs.
    const second = await runScheduler(spec, registry(), { checkpointDir, projectRoot: dir })
    expect(second.results).toHaveLength(2)
    expect(second.results.every(r => r.status === "done")).toBe(true)
  })
})
