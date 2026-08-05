/** G5 acceptance: ResultCache — input-hash hits, superset invalidation,
 *  persistence round-trip (PR-G5). */

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
import { ResultCache, cacheKeyFor } from "../../src/workflow/results/result-cache"
import { saveResultCache, loadResultCache } from "../../src/workflow/persistence/result-cache-store"
import type { WorkflowSpec } from "../../src/workflow/types"

const PROJECT = resolve("tmp-g5-cache")
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

function readSpec(id: string, path: string): WorkflowSpec {
  return {
    schemaVersion: "0.1",
    specId: `g5-read-${id}`,
    nodes: [{ id: "r:read", handler: "tool.read_file", input: { path }, dependsOn: [] }],
  }
}

describe("G5 result cache", () => {
  test("same input hash hits; different input misses", () => {
    const cache = new ResultCache()
    const key = cacheKeyFor("tool.read_file", { path: "a.ts" })
    expect(cache.get(key)).toBeUndefined()
    const result = { nodeId: "r:read", status: "done" as const, output: { content: "x" }, startedAt: 0, finishedAt: 1, durationMs: 1 }
    cache.put(key, result)
    expect(cache.get(key)?.result).toEqual(result)
    expect(cache.hits).toBe(1)
    expect(cache.get(cacheKeyFor("tool.read_file", { path: "b.ts" }))).toBeUndefined()
    expect(cache.misses).toBe(2)
  })

  test("failed results are never cached", () => {
    const cache = new ResultCache()
    const key = cacheKeyFor("tool.read_file", { path: "a.ts" })
    cache.put(key, { nodeId: "r:read", status: "failed", output: null, error: "no", startedAt: 0, finishedAt: 1, durationMs: 1 })
    expect(cache.get(key)).toBeUndefined()
  })

  test("invalidateAll clears everything (write ⇒ recompute)", () => {
    const cache = new ResultCache()
    cache.put("k1", { nodeId: "n1", status: "done", output: null, startedAt: 0, finishedAt: 1, durationMs: 1 })
    cache.put("k2", { nodeId: "n2", status: "done", output: null, startedAt: 0, finishedAt: 1, durationMs: 1 })
    cache.invalidateAll()
    expect(cache.size()).toBe(0)
    expect(cache.invalidations).toBe(1)
  })

  test("scheduler replays a cached read node and marks it replayed", async () => {
    const registry = buildReadWriteRegistry(tools())
    const cache = new ResultCache()
    const run1 = await runScheduler(readSpec("r1", "tmp-g5-cache/a.ts"), registry, { cache })
    expect(run1.results[0]!.status).toBe("done")
    const run2 = await runScheduler(readSpec("r2", "tmp-g5-cache/a.ts"), registry, { cache })
    const node = run2.results[0]!
    expect(node.status).toBe("done")
    expect(node.durationMs).toBe(0)
    expect((node.output as { metadata: Record<string, unknown> }).metadata?.replayed).toBe(true)
    expect(cache.hits).toBe(1)
  })

  test("a completed write node invalidates the cache (file change ⇒ miss)", async () => {
    const registry = buildReadWriteRegistry(tools())
    const cache = new ResultCache()
    const run1 = await runScheduler(readSpec("w1", "tmp-g5-cache/a.ts"), registry, { cache })
    expect(run1.results[0]!.status).toBe("done")

    const patchSpec: WorkflowSpec = {
      schemaVersion: "0.1",
      specId: "g5-write",
      mode: "read-write",
      nodes: [
        { id: "w:patch", handler: "tool.apply_patch", input: { patches: [{ diff: "--- a/tmp-g5-cache/a.ts\n+++ b/tmp-g5-cache/a.ts\n@@ -1 +1 @@\n-export const a = 1\n+export const a = 2\n" }] }, dependsOn: [] },
      ],
    }
    await runScheduler(patchSpec, registry, { cache })
    expect(cache.invalidations).toBe(1)
    expect(cache.size()).toBe(0)

    const run3 = await runScheduler(readSpec("w2", "tmp-g5-cache/a.ts"), registry, { cache })
    expect(run3.results[0]!.status).toBe("done")
    expect((run3.results[0]!.output as { content: string }).content).toContain("a = 2")
  })

  test("persistence round-trip survives schema + restore", () => {
    const dir = join(PROJECT, "cache")
    const file = join(dir, "c.json")
    const cache = new ResultCache()
    cache.put("k1", { nodeId: "n1", status: "done", output: { content: "hello" }, startedAt: 0, finishedAt: 1, durationMs: 1 })
    expect(saveResultCache(cache, file)).toBe(true)
    const loaded = loadResultCache(file)
    expect(loaded).not.toBeNull()
    // Read results pass through redactForTrace on disk (G0 boundary) —
    // the entry structure and node identity survive.
    expect(loaded!.get("k1")?.result.nodeId).toBe("n1")
    expect(loaded!.get("k1")?.result.status).toBe("done")
    expect(loadResultCache(join(dir, "missing.json"))).toBeNull()
  })
})
