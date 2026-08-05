/** MACP-M5 acceptance: 冲突安全合并 (replaces later-wins).
 *
 *  Gates: AUTOMATIC_CONFLICT_OVERWRITE / POST_MERGE_VERIFICATION /
 *  PARTIAL_INTEGRATION.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { collectAgentBundle, combineBundles, type AgentResultBundle } from "../../src/workflow/agents/merge-bundle"
import { buildConflictSet, hasConflicts } from "../../src/workflow/agents/conflict-policy"
import { buildIntegrationPlan, planBlocked } from "../../src/workflow/agents/integration-plan"
import { integrateWithVerification } from "../../src/workflow/agents/integration-verifier"
import { mergeAgentArtifacts } from "../../src/workflow/agents/merge"

function inMemoryFiles(map: Map<string, string>) {
  return (relativePath: string): string | undefined => map.get(relativePath)
}

function bundle(agentId: string, files: Record<string, string>, outputs?: Record<string, unknown>): AgentResultBundle {
  const map = new Map(Object.entries(files))
  return collectAgentBundle({
    agentId,
    files: Object.keys(files),
    outputs,
    readFile: inMemoryFiles(map),
  })
}

describe("M5: conflict policy", () => {
  test("different files auto-combine (no conflicts)", () => {
    const set = buildConflictSet(combineBundles([bundle("a1", { "src/a.ts": "A" }), bundle("a2", { "src/b.ts": "B" })]))
    expect(set.fileConflicts).toEqual([])
    expect(hasConflicts(set)).toBe(false)
  })

  test("same file identical content dedupes (no conflict)", () => {
    const set = buildConflictSet(combineBundles([bundle("a1", { "src/shared.ts": "SAME" }), bundle("a2", { "src/shared.ts": "SAME" })]))
    expect(set.fileConflicts).toEqual([])
    expect(hasConflicts(set)).toBe(false)
  })

  test("same file different content is a conflict — never auto-overwritten", () => {
    const set = buildConflictSet(combineBundles([bundle("a1", { "src/shared.ts": "ONE" }), bundle("a2", { "src/shared.ts": "TWO" })]))
    expect(set.fileConflicts).toHaveLength(1)
    expect(set.fileConflicts[0]!.file).toBe("src/shared.ts")
    expect(set.fileConflicts[0]!.agents).toEqual(["a1", "a2"])
    expect(hasConflicts(set)).toBe(true)
  })

  test("outputs stay per-agent (no field overwriting)", () => {
    const bundles = combineBundles([
      bundle("a1", {}, { plan: "x", version: 1 }),
      bundle("a2", {}, { plan: "y", version: 1 }),
    ])
    expect(bundles[0]!.outputs).toEqual({ plan: "x", version: 1 })
    expect(bundles[1]!.outputs).toEqual({ plan: "y", version: 1 })
  })

  test("conflict set is order-independent (agent reordering changes nothing)", () => {
    const b1 = [bundle("a1", { "s.ts": "X" }), bundle("a2", { "s.ts": "Y" }), bundle("a3", { "t.ts": "T" })]
    const b2 = [bundle("a3", { "t.ts": "T" }), bundle("a2", { "s.ts": "Y" }), bundle("a1", { "s.ts": "X" })]
    expect(buildConflictSet(b1)).toEqual(buildConflictSet(b2))
  })

  test("declared contract collisions are reported", () => {
    const set = buildConflictSet(combineBundles([
      bundle("a1", { "src/a.ts": "A" }, { contracts: ["IConfig"] }),
      bundle("a2", { "src/b.ts": "B" }, { contracts: ["IConfig"] }),
    ]))
    expect(set.contractConflicts).toEqual([{ contract: "IConfig", agents: ["a1", "a2"] }])
    expect(hasConflicts(set)).toBe(true)
  })
})

describe("M5: integration plan", () => {
  test("disjoint + deduped files enter automatic; conflicts block", () => {
    const plan = buildIntegrationPlan(combineBundles([
      bundle("a1", { "src/a.ts": "A", "src/shared.ts": "SAME" }),
      bundle("a2", { "src/b.ts": "B", "src/shared.ts": "SAME" }),
      bundle("a3", { "src/shared.ts": "DIFFERENT" }),
    ]))
    expect(plan.automatic).toEqual(["src/a.ts", "src/b.ts"])
    expect(planBlocked(plan)).toBe(true)
    expect(plan.conflictSet.fileConflicts.map(c => c.file)).toEqual(["src/shared.ts"])
  })
})

describe("M5: integration with verification", () => {
  test("merge succeeds with passing post-merge verification", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "m5-"))
    const wt = {
      a1: mkdtempSync(join(tmpdir(), "m5-wt-a1-")),
      a2: mkdtempSync(join(tmpdir(), "m5-wt-a2-")),
    }
    try {
      writeFileSync(join(wt.a1, "a.ts"), "A")
      writeFileSync(join(wt.a2, "b.ts"), "B")
      const plan = buildIntegrationPlan(combineBundles([
        collectAgentBundle({ agentId: "a1", files: ["a.ts"], readFile: p => readFileSync(join(wt.a1, p), "utf8") }),
        collectAgentBundle({ agentId: "a2", files: ["b.ts"], readFile: p => readFileSync(join(wt.a2, p), "utf8") }),
      ]))
      expect(planBlocked(plan)).toBe(false)
      const result = await integrateWithVerification({
        plan,
        projectRoot,
        worktreeRoots: wt,
        verify: async () => ({ passed: true, summary: "all green" }),
      })
      expect(result.status).toBe("merged")
      expect(result.integrated.sort()).toEqual(["a.ts", "b.ts"])
      expect(readFileSync(join(projectRoot, "a.ts"), "utf8")).toBe("A")
      expect(readFileSync(join(projectRoot, "b.ts"), "utf8")).toBe("B")
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
      rmSync(wt.a1, { recursive: true, force: true })
      rmSync(wt.a2, { recursive: true, force: true })
    }
  })

  test("post-merge verification failure rolls back the official workspace", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "m5-"))
    writeFileSync(join(projectRoot, "a.ts"), "ORIGINAL")
    const wt = { a1: mkdtempSync(join(tmpdir(), "m5-wt-")) }
    try {
      writeFileSync(join(wt.a1, "a.ts"), "MERGED-BROKEN")
      const plan = buildIntegrationPlan(combineBundles([
        collectAgentBundle({ agentId: "a1", files: ["a.ts"], readFile: p => readFileSync(join(wt.a1, p), "utf8") }),
      ]))
      const result = await integrateWithVerification({
        plan,
        projectRoot,
        worktreeRoots: wt,
        verify: async () => ({ passed: false, summary: "typecheck fails" }),
      })
      expect(result.status).toBe("verification_failed")
      expect(result.verification?.passed).toBe(false)
      // 回滚：正式工作区恢复原内容
      expect(readFileSync(join(projectRoot, "a.ts"), "utf8")).toBe("ORIGINAL")
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
      rmSync(wt.a1, { recursive: true, force: true })
    }
  })

  test("interrupted integration never leaves half-written files", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "m5-"))
    writeFileSync(join(projectRoot, "a.ts"), "ORIGINAL-A")
    writeFileSync(join(projectRoot, "b.ts"), "ORIGINAL-B")
    const wt = { a1: mkdtempSync(join(tmpdir(), "m5-wt-")) }
    try {
      writeFileSync(join(wt.a1, "a.ts"), "NEW-A")
      writeFileSync(join(wt.a1, "b.ts"), "NEW-B")
      const plan = buildIntegrationPlan(combineBundles([
        collectAgentBundle({ agentId: "a1", files: ["a.ts", "b.ts"], readFile: p => readFileSync(join(wt.a1, p), "utf8") }),
      ]))
      // verify 抛异常模拟中断
      const result = await integrateWithVerification({
        plan,
        projectRoot,
        worktreeRoots: wt,
        verify: async () => { throw new Error("crash mid-merge") },
      })
      expect(result.status).toBe("verification_failed")
      // 无半成品：所有文件保持原状
      expect(readFileSync(join(projectRoot, "a.ts"), "utf8")).toBe("ORIGINAL-A")
      expect(readFileSync(join(projectRoot, "b.ts"), "utf8")).toBe("ORIGINAL-B")
      expect(existsSync(join(projectRoot, "c.ts"))).toBe(false)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
      rmSync(wt.a1, { recursive: true, force: true })
    }
  })

  test("unresolved conflicts block integration — official workspace untouched", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "m5-"))
    const wt = { a1: mkdtempSync(join(tmpdir(), "m5-wt-")), a2: mkdtempSync(join(tmpdir(), "m5-wt-")) }
    try {
      writeFileSync(join(wt.a1, "shared.ts"), "ONE")
      writeFileSync(join(wt.a2, "shared.ts"), "TWO")
      const plan = buildIntegrationPlan(combineBundles([
        collectAgentBundle({ agentId: "a1", files: ["shared.ts"], readFile: p => readFileSync(join(wt.a1, p), "utf8") }),
        collectAgentBundle({ agentId: "a2", files: ["shared.ts"], readFile: p => readFileSync(join(wt.a2, p), "utf8") }),
      ]))
      const result = await integrateWithVerification({
        plan,
        projectRoot,
        worktreeRoots: wt,
        verify: async () => ({ passed: true, summary: "n/a" }),
      })
      expect(result.status).toBe("blocked_conflict")
      expect(result.integrated).toEqual([])
      expect(existsSync(join(projectRoot, "shared.ts"))).toBe(false)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
      rmSync(wt.a1, { recursive: true, force: true })
      rmSync(wt.a2, { recursive: true, force: true })
    }
  })
})

describe("M5: scheduler blocked_conflict", () => {
  test("merge node with conflicts sets run status blocked_conflict", async () => {
    const { runScheduler } = await import("../../src/workflow/scheduler/scheduler")
    const { HandlerRegistry } = await import("../../src/workflow/execution/handler-registry")
    const reg = new HandlerRegistry()
    reg.register("reduce.merge_agents", "merge", async () => ({
      content: "merged",
      metadata: {
        merged: { a: 1 },
        conflicts: [{ file: "shared.ts", agents: ["a1", "a2"] }],
        valueConflicts: [],
      },
    }))
    const run = await runScheduler(
      { schemaVersion: "0.2", specId: "m5", mode: "read-write", nodes: [{ id: "m:1", handler: "reduce.merge_agents", input: {}, dependsOn: [] }] },
      reg,
    )
    expect(run.status).toBe("blocked_conflict")
  })

  test("conflict-free merge node completes normally", async () => {
    const { runScheduler } = await import("../../src/workflow/scheduler/scheduler")
    const { HandlerRegistry } = await import("../../src/workflow/execution/handler-registry")
    const reg = new HandlerRegistry()
    reg.register("reduce.merge_agents", "merge", async () => ({
      content: "merged",
      metadata: { merged: { a: 1 }, conflicts: [], valueConflicts: [] },
    }))
    const run = await runScheduler(
      { schemaVersion: "0.2", specId: "m5b", mode: "read-write", nodes: [{ id: "m:1", handler: "reduce.merge_agents", input: {}, dependsOn: [] }] },
      reg,
    )
    expect(run.status).toBe("done")
  })

  test("valueConflicts also block the run (no later-wins)", async () => {
    const { runScheduler } = await import("../../src/workflow/scheduler/scheduler")
    const { HandlerRegistry } = await import("../../src/workflow/execution/handler-registry")
    const reg = new HandlerRegistry()
    reg.register("reduce.merge_agents", "merge", async () => ({
      content: "merged",
      metadata: {
        merged: {},
        conflicts: [],
        valueConflicts: [{ key: "version", agents: ["a1", "a2"], values: [1, 2] }],
      },
    }))
    const run = await runScheduler(
      { schemaVersion: "0.2", specId: "m5c", mode: "read-write", nodes: [{ id: "m:1", handler: "reduce.merge_agents", input: {}, dependsOn: [] }] },
      reg,
    )
    expect(run.status).toBe("blocked_conflict")
  })
})
