/** G7 acceptance: multi-agent subgraphs through the shared scheduler —
 *  parallel analysis, independent verification, cancellation, budget. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
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
import { AgentPool } from "../../src/workflow/agents/agent-pool"
import { mergeAgentArtifacts, type AgentArtifact } from "../../src/workflow/agents/merge"
import type { WorkflowSpec } from "../../src/workflow/types"

const PROJECT = resolve("tmp-g7-sched")
const A = join(PROJECT, "a.ts")
const B = join(PROJECT, "b.ts")

beforeAll(() => {
  mkdirSync(PROJECT, { recursive: true })
  writeFileSync(A, "export const a = 1\n")
  writeFileSync(B, "export const b = 1\n")
})

beforeEach(() => {
  writeFileSync(A, "export const a = 1\n")
  writeFileSync(B, "export const b = 1\n")
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

function twoAgentSpec(round: number): WorkflowSpec {
  return {
    schemaVersion: "0.1",
    specId: `g7-${round}`,
    mode: "read-write",
    maxParallel: 4,
    nodes: [
      { id: "a1:r:read", handler: "tool.read_file", input: { path: "tmp-g7-sched/a.ts" }, dependsOn: [] },
      { id: "a2:r:read", handler: "tool.read_file", input: { path: "tmp-g7-sched/b.ts" }, dependsOn: [] },
      { id: "a1:w:patch", handler: "tool.apply_patch", input: { patches: [{ diff: "--- a/tmp-g7-sched/a.ts\n+++ b/tmp-g7-sched/a.ts\n@@ -1 +1 @@\n-export const a = 1\n+export const a = 2\n" }] }, dependsOn: ["a1:r:read"] },
      { id: "a2:w:patch", handler: "tool.apply_patch", input: { patches: [{ diff: "--- a/tmp-g7-sched/b.ts\n+++ b/tmp-g7-sched/b.ts\n@@ -1 +1 @@\n-export const b = 1\n+export const b = 2\n" }] }, dependsOn: ["a2:r:read"] },
    ],
  }
}

describe("G7 multi-agent through the scheduler", () => {
  test("two agents run their subgraphs and both write (single-writer lock holds)", async () => {
    const pool = new AgentPool()
    expect(pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: "/tmp/wt-a1" }).ok).toBe(true)
    expect(pool.register({ id: "a2", ownerFiles: ["b.ts"], worktree: "/tmp/wt-a2" }).ok).toBe(true)
    const run = await runScheduler(twoAgentSpec(1), buildReadWriteRegistry(tools()), { pool })
    expect(run.results.every(r => r.status === "done")).toBe(true)
    expect(run.status).toBe("blocked_no_evidence") // no verification nodes bound
    const read = require("node:fs").readFileSync(A, "utf-8")
    const readB = require("node:fs").readFileSync(B, "utf-8")
    expect(read).toContain("a = 2")
    expect(readB).toContain("b = 2")
  })

  test("cancelling an agent fails its nodes fast; the other agent still completes", async () => {
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: "/tmp/wt-a1" })
    pool.register({ id: "a2", ownerFiles: ["b.ts"], worktree: "/tmp/wt-a2" })
    pool.cancel("a1")
    const run = await runScheduler(twoAgentSpec(2), buildReadWriteRegistry(tools()), { pool })
    const a1Nodes = run.results.filter(r => r.nodeId.startsWith("a1:"))
    const a2Nodes = run.results.filter(r => r.nodeId.startsWith("a2:"))
    expect(a1Nodes.every(r => r.status === "failed" && r.error?.includes("cancelled"))).toBe(true)
    expect(a2Nodes.every(r => r.status === "done")).toBe(true)
  })

  test("budget exhaustion blocks one agent's subgraph only", async () => {
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: "/tmp/wt-a1", budget: { maxNodes: 1 } })
    pool.register({ id: "a2", ownerFiles: ["b.ts"], worktree: "/tmp/wt-a2" })
    const run = await runScheduler(twoAgentSpec(3), buildReadWriteRegistry(tools()), { pool })
    const a1Nodes = run.results.filter(r => r.nodeId.startsWith("a1:"))
    const a2Nodes = run.results.filter(r => r.nodeId.startsWith("a2:"))
    expect(a1Nodes.some(r => r.status === "failed" && r.error?.includes("budget"))).toBe(true)
    expect(a2Nodes.every(r => r.status === "done")).toBe(true)
  })

  test("merge node combines agent artifacts and reports conflicts", () => {
    const artifacts: AgentArtifact[] = [
      { agentId: "a1", artifact: { filesChanged: ["a.ts"], summary: "fixed a" }, files: ["a.ts"] },
      { agentId: "a2", artifact: { filesChanged: ["b.ts"], summary: "fixed b" }, files: ["b.ts"] },
    ]
    const merged = mergeAgentArtifacts({ agents: artifacts })
    expect(merged.merged).toEqual({ filesChanged: ["b.ts"], summary: "fixed b" })
    expect(merged.conflicts).toEqual([])
  })
})
