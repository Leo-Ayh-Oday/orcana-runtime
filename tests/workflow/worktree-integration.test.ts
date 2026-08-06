/** M9 acceptance: WORKTREE_CHANGES_INTEGRATED_BEFORE_DISPOSE.
 *
 *  A run that declares a `reduce.merge_agents` node must physically
 *  integrate per-agent worktree changes into the official workspace BEFORE
 *  the worktrees are disposed — otherwise successful agent changes vanish
 *  with the worktree. A failing post-merge verification rolls the merge
 *  back atomically; runs without a merge node keep the isolated worktree
 *  lifecycle (nothing lands, nothing is lost).
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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
import type { ToolExecutionContext } from "../../src/harness/capabilities/execution-context"

/** 写类 mock capability：相对路径解析到 runContext.projectRoot（worktree
 *  根或共享根），输出携带实际写入路径 metadata.paths（M3 任务 8）。 */
function registerWriteCap(env: WorkflowHarnessEnvironment): void {
  env.capabilities.register(
    createCapabilityDescriptor({
      id: "mock_write",
      kind: "tool",
      inputSchema: { type: "object", properties: {}, required: [] },
      sideEffect: "write",
    }),
    {
      async execute(input: unknown, meta: unknown) {
        const params = input as { path?: string; content?: string }
        const runContext = (meta as { metadata?: { runContext?: ToolExecutionContext } })?.metadata?.runContext
        const root = runContext?.projectRoot!
        const target = resolve(root, params.path!)
        mkdirSync(join(target, ".."), { recursive: true })
        writeFileSync(target, params.content ?? "new")
        return {
          ok: true,
          output: { success: true, content: "written", metadata: { paths: [target] } },
        }
      },
    },
  )
}

interface EnvBundle {
  env: WorkflowHarnessEnvironment
  projectRoot: string
}

function buildEnv(): EnvBundle {
  const projectRoot = mkdtempSync(join(tmpdir(), "m9-"))
  const controller = new AbortController()
  const scope = assembleRunScope({ runId: "m9-run", sessionId: "m9", projectRoot, controller })
  const capabilities = createCapabilityRegistry()
  const env: WorkflowHarnessEnvironment = {
    scope,
    budgetLimits: mergeRunBudget(undefined),
    capabilities,
    policy: { allowCapabilities: ["mock_write"] },
  }
  registerWriteCap(env)
  return { env, projectRoot }
}

function reg(): HandlerRegistry {
  const registry = new RegistryImpl()
  registry.register("reduce.merge_agents", "merge", async () => ({
    content: "merged",
    metadata: { merged: {}, conflicts: [], valueConflicts: [] },
  }))
  // M7: H11 write nodes need a passing verification node to complete the
  // run — the integration specs declare one for the write nodes.
  registry.register("tool.run_targeted_verification", "verify", async () => ({ content: "verified" }))
  return registry
}

function spec(nodes: WorkflowNodeSpec[]): WorkflowSpec {
  return { schemaVersion: "0.2", specId: `m9-${Math.random().toString(16).slice(2, 8)}`, mode: "read-write", nodes }
}

function writeNode(id: string, path: string): WorkflowNodeSpec {
  return {
    id,
    handler: "test.reducer",
    input: { path },
    dependsOn: [],
    assignment: id.split(":")[0],
    execution: { kind: "tool", capabilityId: "mock_write", params: { path } },
  }
}

function mergeNode(id = "m:1", dependsOn: string[] = []): WorkflowNodeSpec {
  return { id, handler: "reduce.merge_agents", input: {}, dependsOn }
}

const resultOf = (run: Awaited<ReturnType<typeof runScheduler>>, id: string) =>
  run.results.find(r => r.nodeId === id)!

describe("M9: worktree changes integrated before dispose", () => {
  test("two agents + merge ⇒ changes land in the official workspace", async () => {
    const { env, projectRoot } = buildEnv()
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: join(projectRoot, ".orcana", "worktrees", "a1") })
    pool.register({ id: "b1", ownerFiles: ["b.ts"], worktree: join(projectRoot, ".orcana", "worktrees", "b1") })
    const wtA = join(projectRoot, ".orcana", "worktrees", "a1")
    try {
      const run = await runScheduler(
        spec([
          writeNode("a1:w:1", "a.ts"),
          writeNode("b1:w:1", "b.ts"),
          mergeNode("m:1", ["a1:w:1", "b1:w:1"]),
          { id: "v:1", handler: "tool.run_targeted_verification", input: {}, dependsOn: ["a1:w:1", "b1:w:1"] },
        ]),
        reg(),
        { harness: env, pool },
      )
      expect(resultOf(run, "a1:w:1").status).toBe("done")
      expect(resultOf(run, "b1:w:1").status).toBe("done")
      expect(run.status).toBe("done")
      // 正式 workspace 包含两个 Agent 的变更（物理集成发生在 dispose 之前）
      expect(readFileSync(join(projectRoot, "a.ts"), "utf8")).toBe("new")
      expect(readFileSync(join(projectRoot, "b.ts"), "utf8")).toBe("new")
      // worktree 仍然在运行结束后清理
      expect(existsSync(wtA)).toBe(false)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test("post-merge verification failure ⇒ run failed + atomic rollback", async () => {
    const { env, projectRoot } = buildEnv()
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: join(projectRoot, ".orcana", "worktrees", "a1") })
    try {
      const run = await runScheduler(
        spec([writeNode("a1:w:1", "a.ts"), mergeNode("m:1", ["a1:w:1"])]),
        reg(),
        {
          harness: env,
          pool,
          integrationVerify: async () => ({ passed: false, summary: "typecheck fails" }),
        },
      )
      // 验证失败：merge 节点结果改写为 failed → run 不得 done
      expect(resultOf(run, "m:1").status).toBe("failed")
      expect(resultOf(run, "m:1").errorKind).toBe("integration_failed")
      expect(run.status).toBe("failed")
      // 原子回滚：正式工作区不含集成文件
      expect(existsSync(join(projectRoot, "a.ts"))).toBe(false)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test("no merge node ⇒ worktrees stay isolated (no silent integration)", async () => {
    const { env, projectRoot } = buildEnv()
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: join(projectRoot, ".orcana", "worktrees", "a1") })
    try {
      const run = await runScheduler(
        spec([
          writeNode("a1:w:1", "a.ts"),
          { id: "v:1", handler: "tool.run_targeted_verification", input: {}, dependsOn: ["a1:w:1"] },
        ]),
        reg(),
        { harness: env, pool },
      )
      expect(resultOf(run, "a1:w:1").status).toBe("done")
      // 无 merge 声明：正式工作区保持干净，worktree 被清理
      expect(existsSync(join(projectRoot, "a.ts"))).toBe(false)
      expect(existsSync(join(projectRoot, ".orcana", "worktrees", "a1"))).toBe(false)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})
