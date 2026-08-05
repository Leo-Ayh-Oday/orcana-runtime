/** G3 acceptance: write nodes serialize; readers still parallelize. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { buildTool, type ContractToolDescriptor } from "../../src/tools/registry"
import { FIND_SYMBOL, FIND_REFERENCES, PROJECT_STRUCTURE } from "../../src/tools/codegraph"
import { GIT_STATUS, GIT_DIFF } from "../../src/tools/git"
import { RUN_PROCESS_TOOL } from "../../src/tools/process"
import { RUN_TARGETED_VERIFICATION_TOOL } from "../../src/tools/verification"
import { READ_FILE } from "../../src/tools/file"
import { APPLY_PATCH_TRANSACTION_TOOL } from "../../src/tools/apply-patch"
import { buildReadWriteRegistry } from "../../src/workflow/registry"
import { runScheduler } from "../../src/workflow/scheduler/scheduler"
import type { WorkflowSpec } from "../../src/workflow/types"

const PROJECT = resolve("tmp-g3-serial")
const A = join(PROJECT, "a.ts")

beforeAll(() => {
  mkdirSync(PROJECT, { recursive: true })
  writeFileSync(A, "export const a = 1\n")
})

afterAll(() => {
  rmSync(PROJECT, { recursive: true, force: true })
})

function tools(): ContractToolDescriptor[] {
  return [
    buildTool(READ_FILE),
    buildTool(FIND_SYMBOL),
    buildTool(FIND_REFERENCES),
    buildTool(PROJECT_STRUCTURE),
    buildTool(GIT_STATUS),
    buildTool(GIT_DIFF),
    buildTool(APPLY_PATCH_TRANSACTION_TOOL),
    buildTool(RUN_PROCESS_TOOL),
    buildTool(RUN_TARGETED_VERIFICATION_TOOL),
  ]
}

function makePatchDiff(content: string): string {
  return `--- a/tmp-g3-serial/a.ts\n+++ b/tmp-g3-serial/a.ts\n@@ -1 +1 @@\n-export const a = 1\n+${content}\n`
}

describe("G3 single-writer scheduling", () => {
  test("two write nodes never overlap in time (serialized by the write slot)", async () => {
    const registry = buildReadWriteRegistry(tools())
    const overlaps: Array<[number, number]> = []
    const spec: WorkflowSpec = {
      schemaVersion: "0.1",
      specId: "g3-serial-writes",
      mode: "read-write",
      maxParallel: 4,
      nodes: [
        { id: "w1", handler: "tool.apply_patch", input: { patches: [{ diff: makePatchDiff("export const a = 2") }] }, dependsOn: [] },
        { id: "w2", handler: "tool.apply_patch", input: { patches: [{ diff: "--- a/tmp-g3-serial/a.ts\n+++ b/tmp-g3-serial/a.ts\n@@ -1 +1 @@\n-export const a = 2\n+export const a = 3\n" }] }, dependsOn: [] },
      ],
    }
    const run = await runScheduler(spec, registry, {
      onNodeFinished: r => overlaps.push([r.startedAt, r.finishedAt]),
    })
    expect(run.results).toHaveLength(2)
    expect(run.results.every(r => r.status === "done")).toBe(true)
    // Serialization: finish of one <= start of the other.
    const [first, second] = overlaps.sort((a, b) => a[0] - b[0])
    expect(first![1]).toBeLessThanOrEqual(second![0]!)
  })

  test("write handler in read-only spec is rejected at runtime", async () => {
    const registry = buildReadWriteRegistry(tools())
    const spec: WorkflowSpec = {
      schemaVersion: "0.1",
      specId: "g3-ro-reject",
      mode: "readonly",
      nodes: [
        { id: "w1", handler: "tool.apply_patch", input: { patches: [{ diff: "x" }] }, dependsOn: [] },
      ],
    }
    const run = await runScheduler(spec, registry)
    expect(run.results[0]!.status).toBe("failed")
    expect(run.results[0]!.error).toContain("rejected in readonly mode")
  })

  test("read-only nodes stay parallel in a read-write spec", async () => {
    const registry = buildReadWriteRegistry(tools())
    const spec: WorkflowSpec = {
      schemaVersion: "0.1",
      specId: "g3-mixed",
      mode: "read-write",
      maxParallel: 4,
      nodes: [
        { id: "r1", handler: "tool.read_file", input: { path: A }, dependsOn: [] },
        { id: "r2", handler: "tool.read_file", input: { path: A }, dependsOn: [] },
        { id: "r3", handler: "tool.read_file", input: { path: A }, dependsOn: [] },
        { id: "r4", handler: "tool.read_file", input: { path: A }, dependsOn: [] },
      ],
    }
    const run = await runScheduler(spec, registry)
    expect(run.results.filter(r => r.status === "done")).toHaveLength(4)
  })
})
