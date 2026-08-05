/** G5 acceptance: checkpoint resume + replay across runs (PR-G5). */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
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
import { ResultCache } from "../../src/workflow/results/result-cache"
import type { WorkflowSpec } from "../../src/workflow/types"

const PROJECT = resolve("tmp-g5-replay")
const A = join(PROJECT, "a.ts")
const CHECKPOINT_DIR = join(PROJECT, "ckpts")

beforeAll(() => {
  mkdirSync(CHECKPOINT_DIR, { recursive: true })
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

const spec: WorkflowSpec = {
  schemaVersion: "0.1",
  specId: "g5-replay-spec",
  nodes: [
    { id: "r1:read", handler: "tool.read_file", input: { path: "tmp-g5-replay/a.ts" }, dependsOn: [] },
    { id: "r2:read", handler: "tool.project_structure", input: { depth: 1 }, dependsOn: [] },
  ],
}

describe("G5 checkpoint resume + replay", () => {
  test("resumed nodes are not re-executed and refill the cache", async () => {
    const registry = buildReadWriteRegistry(tools())
    const cache = new ResultCache()
    const run1 = await runScheduler(spec, registry, { checkpointDir: CHECKPOINT_DIR, cache })
    expect(run1.results.every(r => r.status === "done")).toBe(true)
    expect(existsSync(join(CHECKPOINT_DIR, "g5-replay-spec.json"))).toBe(true)

    // A fresh scheduler + fresh cache, same checkpoint dir: restore path.
    const cache2 = new ResultCache()
    const run2 = await runScheduler(spec, registry, { checkpointDir: CHECKPOINT_DIR, cache: cache2 })
    for (const r of run2.results) {
      expect((r.output as { metadata: Record<string, unknown> }).metadata?.replayed ?? false).toBe(true)
      expect(r.durationMs).toBe(0)
    }
    // Restored results refilled cache2 (read nodes only), so a run without
    // a checkpoint dir hits the cache for every node (replay across runs).
    const freshSpec: WorkflowSpec = { ...spec, specId: "g5-replay-spec-fresh" }
    const run3 = await runScheduler(freshSpec, registry, { cache: cache2 })
    expect(run3.results.every(r => (r.output as { metadata: Record<string, unknown> }).metadata?.replayed)).toBe(true)
    expect(cache2.hits).toBeGreaterThanOrEqual(2)
  })

  test("cache hits do not invoke the underlying tool again", async () => {
    const registry = buildReadWriteRegistry(tools())
    const probe = buildTool(READ_FILE)
    const original = probe.execute
    let calls = 0
    probe.execute = async (params) => {
      calls++
      return original(params)
    }
    registry.registerTool("tool.read_file", probe)
    const cache = new ResultCache()
    await runScheduler(spec, registry, { cache })
    const before = calls
    await runScheduler(spec, registry, { cache })
    expect(calls - before).toBe(0)
    expect(cache.hits).toBeGreaterThanOrEqual(2)
  })
})
