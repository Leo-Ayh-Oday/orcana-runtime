/** R4: 资源账本接入 Graph 调度 —— 不足时等待而非先启动，结束后释放。 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildTool, type ContractToolDescriptor } from "../../src/tools/registry"
import { READ_FILE } from "../../src/tools/file"
import { HandlerRegistry } from "../../src/workflow/execution/handler-registry"
import { runScheduler } from "../../src/workflow/scheduler/scheduler"
import type { WorkflowSpec } from "../../src/workflow/types"
import { ResourceLedger } from "../../src/runtime/linux/scheduler/resource-ledger"

function tools(): HandlerRegistry {
  const registry = new HandlerRegistry()
  const descriptors: ContractToolDescriptor[] = [buildTool(READ_FILE)]
  for (const d of descriptors) registry.registerTool(d.defn.name, d)
  return registry
}

describe("R4 scheduler ledger", () => {
  test("resource-insufficient nodes wait instead of starting; ledger drained after run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wflow-r4-"))
    writeFileSync(join(dir, "a.txt"), "a")
    writeFileSync(join(dir, "b.txt"), "b")
    writeFileSync(join(dir, "c.txt"), "c")
    const spec: WorkflowSpec = {
      schemaVersion: "0.1",
      specId: "r4-ledger",
      nodes: [
        { id: "tool:1", handler: "read_file", input: { path: join(dir, "a.txt") }, dependsOn: [] },
        { id: "tool:2", handler: "read_file", input: { path: join(dir, "b.txt") }, dependsOn: [] },
        { id: "tool:3", handler: "read_file", input: { path: join(dir, "c.txt") }, dependsOn: [] },
      ],
    }
    // 容量只够 1 个并发 Cell：3 个 ready 节点必须等待串行，且不 overcommit。
    const ledger = new ResourceLedger({
      maxConcurrentCells: 1,
      capacity: { cpuQuota: 1000, memoryBytes: 512 * 1024 * 1024, pids: 100, networkSlots: 1, tempBytes: 1024 * 1024 * 1024, concurrentCells: 1 },
    })
    const run = await runScheduler(spec, tools(), { maxParallel: 3, ledger })
    expect(run.status).toBe("done")
    expect(run.results).toHaveLength(3)
    expect(run.results.every(r => r.status === "done")).toBe(true)
    expect(ledger.outstanding().length).toBe(0)
  })

  test("without ledger, behavior unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wflow-r4-nol-"))
    writeFileSync(join(dir, "a.txt"), "a")
    const spec: WorkflowSpec = {
      schemaVersion: "0.1",
      specId: "r4-noledger",
      nodes: [{ id: "tool:1", handler: "read_file", input: { path: join(dir, "a.txt") }, dependsOn: [] }],
    }
    const run = await runScheduler(spec, tools(), { maxParallel: 2 })
    expect(run.status).toBe("done")
  })
})
