/** G5 acceptance: checkpoint resume + replay across runs (PR-G5). */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
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
import { ResultStore } from "../../src/workflow/results/result-store"
import { HandlerRegistry as RegistryImpl } from "../../src/workflow/execution/handler-registry"
import type { WorkflowHarnessEnvironment } from "../../src/workflow/harness/environment"
import { assembleRunScope } from "../../src/harness/runtime/run-scope"
import { mergeRunBudget } from "../../src/harness/runtime/budget-ledger"
import { createCapabilityRegistry } from "../../src/harness/capabilities/registry"
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
    { id: "r1:read", handler: "tool.read_file", input: { path: "a.ts" }, dependsOn: [] },
    { id: "r2:read", handler: "tool.project_structure", input: { depth: 1 }, dependsOn: [] },
  ],
}

describe("G5 checkpoint resume + replay", () => {
  test("resumed nodes are not re-executed and refill the cache", async () => {
    const registry = buildReadWriteRegistry(tools())
    const cache = new ResultCache()
    const run1 = await runScheduler(spec, registry, { checkpointDir: CHECKPOINT_DIR, cache, projectRoot: PROJECT })
    expect(run1.results.every(r => r.status === "done")).toBe(true)
    expect(existsSync(join(CHECKPOINT_DIR, "g5-replay-spec.json"))).toBe(true)

    // A fresh scheduler + fresh cache, same checkpoint dir: restore path.
    const cache2 = new ResultCache()
    const run2 = await runScheduler(spec, registry, { checkpointDir: CHECKPOINT_DIR, cache: cache2, projectRoot: PROJECT })
    for (const r of run2.results) {
      expect((r.output as { metadata: Record<string, unknown> }).metadata?.replayed ?? false).toBe(true)
      expect(r.durationMs).toBe(0)
    }
    // Restored results refilled cache2 (read nodes only), so a run without
    // a checkpoint dir hits the cache for every node (replay across runs).
    const freshSpec: WorkflowSpec = { ...spec, specId: "g5-replay-spec-fresh" }
    const run3 = await runScheduler(freshSpec, registry, { cache: cache2, projectRoot: PROJECT })
    expect(run3.results.every(r => (r.output as { metadata: Record<string, unknown> }).metadata?.replayed)).toBe(true)
    expect(cache2.hits).toBeGreaterThanOrEqual(2)
  })

  test("cache hits do not invoke the underlying tool again", async () => {
    const registry = buildReadWriteRegistry(tools())
    const probe = buildTool(READ_FILE)
    const original = probe.execute
    let calls = 0
    // 转发全部参数：D7 后工具需要 projectRoot context，只转 params 会让
    // 真实执行失去路径权威（fail-closed → 节点失败 → 不缓存）。
    probe.execute = async (params, context) => {
      calls++
      return original(params, context)
    }
    registry.registerTool("tool.read_file", probe)
    const cache = new ResultCache()
    await runScheduler(spec, registry, { cache, projectRoot: PROJECT })
    const before = calls
    await runScheduler(spec, registry, { cache, projectRoot: PROJECT })
    expect(calls - before).toBe(0)
    expect(cache.hits).toBeGreaterThanOrEqual(2)
  })
})

describe("M11: checkpoint binds spec + workspace digest", () => {
  test("changed node input ⇒ stale checkpoint rejected, node re-executes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wflow-m11-"))
    const cache = new ResultCache()
    let calls = 0
    const registry = new RegistryImpl()
    registry.register("test.probe", "probe", async input => {
      calls++
      return { content: `value:${String(input.value)}` }
    })
    const makeSpec = (value: string): WorkflowSpec => ({
      schemaVersion: "0.2",
      specId: "m11-spec",
      nodes: [{ id: "p:1", handler: "test.probe", input: { value }, dependsOn: [] }],
    })
    try {
      await runScheduler(makeSpec("v1"), registry, { checkpointDir: dir, cache, projectRoot: PROJECT })
      expect(calls).toBe(1)

      // 同 specId，节点 input 变化 → 图摘要不同 → 旧 checkpoint 整体拒绝
      const run2 = await runScheduler(makeSpec("v2"), registry, { checkpointDir: dir, cache })
      expect(calls).toBe(2) // 节点重新执行，未复用旧结果
      expect((run2.results[0]!.output as { content: string }).content).toBe("value:v2")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("changed workspace ⇒ checkpoint rejected when harness binds the digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wflow-m11-"))
    const projectRoot = mkdtempSync(join(tmpdir(), "wflow-m11-ws-"))
    const controller = new AbortController()
    const scope = assembleRunScope({ runId: "m11-run", sessionId: "m11", projectRoot, controller })
    const env: WorkflowHarnessEnvironment = {
      scope,
      budgetLimits: mergeRunBudget(undefined),
      capabilities: createCapabilityRegistry(),
    }
    let calls = 0
    const registry = new RegistryImpl()
    registry.register("test.probe", "probe", async input => {
      calls++
      return { content: `value:${String(input.value)}` }
    })
    const makeSpec = (value: string): WorkflowSpec => ({
      schemaVersion: "0.2",
      specId: "m11-ws",
      nodes: [{ id: "p:1", handler: "test.probe", input: { value }, dependsOn: [] }],
    })
    try {
      await runScheduler(makeSpec("v1"), registry, { checkpointDir: dir, harness: env })
      expect(calls).toBe(1)
      // 工作区内容变化 → workspace digest 不同 → 旧 checkpoint 拒绝
      writeFileSync(join(projectRoot, "changed.txt"), "dirty")
      await runScheduler(makeSpec("v1"), registry, { checkpointDir: dir, harness: env })
      expect(calls).toBe(2) // 未复用旧结果，节点重新执行
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test("unbound (old-format) checkpoint is rejected fail-closed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wflow-m11-"))
    const registry = buildReadWriteRegistry(tools())
    try {
      // 模拟旧格式 checkpoint：无 specDigest/workspaceDigest
      const legacy = new ResultStore("m11-legacy", dir)
      legacy.put({ nodeId: "r:read", status: "done", output: { content: "stale" }, startedAt: 1, finishedAt: 2, durationMs: 1 })
      const specA: WorkflowSpec = {
        schemaVersion: "0.1",
        specId: "m11-legacy",
        nodes: [{ id: "r:read", handler: "tool.read_file", input: { path: "a.ts" }, dependsOn: [] }],
      }
      const run = await runScheduler(specA, registry, { checkpointDir: dir, projectRoot: PROJECT })
      // digest-bound store 拒绝未绑定 checkpoint → 节点真实执行，不读陈旧结果
      expect((run.results[0]!.output as { content: string }).content).not.toBe("stale")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
