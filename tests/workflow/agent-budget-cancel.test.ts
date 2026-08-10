/** Batch 5 acceptance: M4 write-budget enforcement + M5 running-agent
 *  cancellation propagation (P0, Workflow/Multi-Agent).
 *
 *  M4 — AgentBudget.maxWrites is charged by the production scheduler BEFORE
 *       a write node executes: the second write of a maxWrites=1 agent is
 *       blocked pre-execution with writes_exhausted (side effects never
 *       run past the cap);
 *  M5 — pool.cancel() aborts the agent's local signal so an IN-FLIGHT
 *       harness node (blocked tool capability) observes the abort and
 *       terminates, releasing its worktree — without touching the shared
 *       run scope used by other agents.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runScheduler } from "../../src/workflow/scheduler/scheduler"
import type { WorkflowSpec, WorkflowNodeSpec } from "../../src/workflow/types"
import type { HandlerRegistry } from "../../src/workflow/execution/handler-registry"
import { HandlerRegistry as RegistryImpl } from "../../src/workflow/execution/handler-registry"
import type { WorkflowHarnessEnvironment } from "../../src/workflow/harness/environment"
import { assembleRunScope } from "../../src/harness/runtime/run-scope"
import { mergeRunBudget } from "../../src/harness/runtime/budget-ledger"
import { createCapabilityRegistry } from "../../src/harness/capabilities/registry"
import { createCapabilityDescriptor } from "../../src/harness/capabilities/descriptor"
import { AgentPool } from "../../src/workflow/agents/agent-pool"

interface CapMeta {
  metadata?: { runContext?: { signal?: AbortSignal; projectRoot?: string } }
}

function buildEnv(allow: string[]): { env: WorkflowHarnessEnvironment; projectRoot: string } {
  const projectRoot = mkdtempSync(join(tmpdir(), "mw-b5-"))
  const controller = new AbortController()
  const scope = assembleRunScope({ runId: "mw-b5", sessionId: "mw-b5", projectRoot, controller })
  const capabilities = createCapabilityRegistry()
  const env: WorkflowHarnessEnvironment = {
    scope,
    budgetLimits: mergeRunBudget(undefined),
    capabilities,
    policy: { allowCapabilities: allow },
  }
  return { env, projectRoot }
}

function reg(): HandlerRegistry {
  const registry = new RegistryImpl()
  registry.register("test.noop", "noop", async () => ({ content: "noop" }))
  registry.register("tool.run_targeted_verification", "verify", async () => ({ content: "verified" }))
  return registry
}

function spec(nodes: WorkflowNodeSpec[]): WorkflowSpec {
  return { schemaVersion: "0.2", specId: "mw-b5-spec", mode: "read-write", nodes }
}

function writeNode(id: string, capabilityId: string, path: string): WorkflowNodeSpec {
  return {
    id,
    handler: "test.noop",
    input: { path },
    dependsOn: [],
    assignment: "a1",
    execution: { kind: "tool", capabilityId, params: { path } },
  }
}

/* ── M4: write budget charged before execution ───────────────────────── */

describe("M4: AGENT_WRITE_BUDGET_ENFORCED", () => {
  test("maxWrites=1 agent's second write is blocked pre-execution", async () => {
    const { env, projectRoot } = buildEnv(["mock_count_write"])
    let writeCount = 0
    env.capabilities.register(
      createCapabilityDescriptor({
        id: "mock_count_write",
        kind: "tool",
        inputSchema: { type: "object", properties: {}, required: [] },
        sideEffect: "write",
      }),
      {
        async execute() {
          writeCount++
          const input = arguments[0] as { path?: string }
          const runContext = (arguments[1] as CapMeta)?.metadata?.runContext
          const root = runContext?.projectRoot ?? projectRoot // agent 场景 = worktree root
          const file = input.path ?? "out.txt"
          mkdirSync(root, { recursive: true })
          writeFileSync(join(root, file), "x", "utf-8")
          return { ok: true, output: { success: true, metadata: { paths: [join(root, file)] } } }
        },
      },
    )
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["out.txt", "out2.txt"], worktree: join(projectRoot, ".orcana", "worktrees", "a1"), budget: { maxWrites: 1 } })
    try {
      const run = await runScheduler(
        spec([
          writeNode("a1:w:1", "mock_count_write", "out.txt"),
          writeNode("a1:w:2", "mock_count_write", "out2.txt"),
          { id: "v:1", handler: "tool.run_targeted_verification", input: {}, dependsOn: ["a1:w:1", "a1:w:2"] },
        ]),
        reg(),
        { harness: env, pool },
      )
      const first = run.results.find(r => r.nodeId === "a1:w:1")!
      const second = run.results.find(r => r.nodeId === "a1:w:2")!
      expect(first.status).toBe("done")
      // 第二个写节点在执行前被 writes_exhausted 阻止
      expect(second.status).toBe("failed")
      expect(second.error).toContain("writes_exhausted")
      expect(writeCount).toBe(1) // 副作用从未越过上限
      expect(existsSync(join(projectRoot, ".orcana", "worktrees", "a1"))).toBe(false) // 清理照常
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

/* ── M5: running-agent cancellation propagates ───────────────────────── */

describe("M5: RUNNING_AGENT_CANCEL_PROPAGATES", () => {
  test("blocked in-flight node receives the abort from pool.cancel", async () => {
    const { env, projectRoot } = buildEnv(["mock_block"])
    let started: (() => void) | undefined
    const startGate = new Promise<void>(r => { started = r })
    let aborted = false
    env.capabilities.register(
      createCapabilityDescriptor({
        id: "mock_block",
        kind: "tool",
        inputSchema: { type: "object", properties: {}, required: [] },
        sideEffect: "write",
      }),
      {
        async execute() {
          const signal = (arguments[1] as CapMeta)?.metadata?.runContext?.signal
          started!()
          await new Promise<void>(resolve => {
            if (signal?.aborted) return resolve()
            signal?.addEventListener("abort", () => { aborted = true; resolve() })
          })
          // 取消后恢复执行：真实副作用路径会因清理失败而抛错，绝不假成功
          throw new Error("aborted")
        },
      },
    )
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["a1.txt"], worktree: join(projectRoot, ".orcana", "worktrees", "a1") })
    const runPromise = runScheduler(
      spec([writeNode("a1:w:1", "mock_block", "a1.txt")]),
      reg(),
      { harness: env, pool },
    )
    try {
      await startGate // 节点已开始执行（阻塞在 signal 上）
      pool.cancel("a1") // M5: 运行中的节点必须收到 abort
      const run = await runPromise
      expect(aborted).toBe(true) // 节点观察到了 agent 级 abort
      const result = run.results.find(r => r.nodeId === "a1:w:1")!
      expect(result.status).not.toBe("done") // cancelled/failed，不是假完成
      expect(existsSync(join(projectRoot, ".orcana", "worktrees", "a1"))).toBe(false) // 资源/worktree 已释放
    } finally {
      pool.cancel("a1")
      await runPromise.catch(() => {})
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test("run-scope cancellation still works when no agent owns the node", async () => {
    const { env, projectRoot } = buildEnv(["mock_block"])
    let started: (() => void) | undefined
    const startGate = new Promise<void>(r => { started = r })
    env.capabilities.register(
      createCapabilityDescriptor({
        id: "mock_block",
        kind: "tool",
        inputSchema: { type: "object", properties: {}, required: [] },
        sideEffect: "write",
      }),
      {
        async execute() {
          const signal = (arguments[1] as CapMeta)?.metadata?.runContext?.signal
          started!()
          await new Promise<void>(resolve => {
            if (signal?.aborted) return resolve()
            signal?.addEventListener("abort", () => resolve())
          })
          throw new Error("aborted")
        },
      },
    )
    const node: WorkflowNodeSpec = {
      id: "w:1",
      handler: "test.noop",
      input: { path: "w:1.txt" },
      dependsOn: [],
      execution: { kind: "tool", capabilityId: "mock_block", params: { path: "w:1.txt" } },
    }
    const runPromise = runScheduler(
      { schemaVersion: "0.2", specId: "mw-b5-spec", mode: "read-write", nodes: [node] },
      reg(),
      { harness: env },
    )
    try {
      await startGate
      env.scope.cancellation.cancel("test_cancel")
      const run = await runPromise
      expect(run.results.find(r => r.nodeId === "w:1")!.status).not.toBe("done")
    } finally {
      env.scope.cancellation.cancel("test_cancel")
      await runPromise.catch(() => {})
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})
