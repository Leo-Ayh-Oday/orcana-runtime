/** MACP-M3 acceptance: 真实工作区隔离与所有权强制.
 *
 *  AgentPool ownerFiles/worktree/canWrite upgraded from declarations to
 *  enforced execution constraints. Gates: UNOWNED_WRITE / WORKTREE_ESCAPE /
 *  SHARED_WORKSPACE_MULTI_WRITE / SINGLE_AGENT_REGRESSION.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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
import { detectLegacyWorktrees } from "../../src/workflow/agents/workspace-context"
import type { ToolExecutionContext } from "../../src/harness/capabilities/execution-context"

interface WriteCapability {
  /** 实际写入的相对路径（相对执行根 projectRoot）；默认等于 input.path。 */
  actualRelative?: string
}

/** 写类 mock capability：相对路径解析到 runContext.projectRoot（worktree
 *  根或共享根），输出携带实际写入路径 metadata.paths（M3 任务 8）。 */
function registerWriteCap(
  env: WorkflowHarnessEnvironment,
  opts: WriteCapability = {},
): void {
  const ctx = (opts as unknown) as Record<string, unknown>
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
        const root = runContext?.projectRoot ?? (ctx.root as string)
        const rel = (opts.actualRelative ?? params.path)!
        const target = resolve(root, rel)
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
  const projectRoot = mkdtempSync(join(tmpdir(), "m3-"))
  const controller = new AbortController()
  const scope = assembleRunScope({ runId: "m3-run", sessionId: "m3", projectRoot, controller })
  const capabilities = createCapabilityRegistry()
  const env: WorkflowHarnessEnvironment = {
    scope,
    budgetLimits: mergeRunBudget(undefined),
    capabilities,
    policy: { allowCapabilities: ["mock_write"] },
  }
  return { env, projectRoot }
}

function reg(): HandlerRegistry {
  const registry = new RegistryImpl()
  registry.register("test.reducer", "reducer", async input => ({ content: input.value ?? "reduced" }))
  return registry
}

function spec(nodes: WorkflowNodeSpec[], mode: WorkflowSpec["mode"] = "read-write"): WorkflowSpec {
  return { schemaVersion: "0.2", specId: `m3-${Math.random().toString(16).slice(2, 8)}`, nodes, mode }
}

function writeNode(id: string, path: string, assignment?: string): WorkflowNodeSpec {
  return {
    id,
    handler: "test.reducer",
    input: { path },
    dependsOn: [],
    assignment,
    execution: { kind: "tool", capabilityId: "mock_write", params: { path } },
  }
}

const resultOf = (run: Awaited<ReturnType<typeof runScheduler>>, id: string) =>
  run.results.find(r => r.nodeId === id)!

describe("M3: ownership enforcement", () => {
  test("agent writes an owned file → passed", async () => {
    const { env, projectRoot } = buildEnv()
    registerWriteCap(env)
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: join(projectRoot, ".orcana", "worktrees", "a1") })
    try {
      const run = await runScheduler(spec([writeNode("a1:w:1", "a.ts")]), reg(), { harness: env, pool })
      const result = resultOf(run, "a1:w:1")
      expect(result.status).toBe("done")
      expect(result.output).toEqual(expect.objectContaining({ success: true }))
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test("agent writes another agent's file → rejected", async () => {
    const { env, projectRoot } = buildEnv()
    registerWriteCap(env)
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: join(projectRoot, ".orcana", "worktrees", "a1") })
    pool.register({ id: "b1", ownerFiles: ["b.ts"], worktree: join(projectRoot, ".orcana", "worktrees", "b1") })
    try {
      const run = await runScheduler(spec([writeNode("a1:w:1", "b.ts")]), reg(), { harness: env, pool })
      const result = resultOf(run, "a1:w:1")
      expect(result.status).toBe("failed")
      expect(result.errorKind).toBe("ownership_denied")
      expect(result.error).toContain('does not own "b.ts"')
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test("declared a.ts but actually wrote src/a.ts → rejected (post-check)", async () => {
    const { env, projectRoot } = buildEnv()
    registerWriteCap(env, { actualRelative: "src/a.ts" })
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: join(projectRoot, ".orcana", "worktrees", "a1") })
    try {
      const run = await runScheduler(spec([writeNode("a1:w:1", "a.ts")]), reg(), { harness: env, pool })
      const result = resultOf(run, "a1:w:1")
      expect(result.status).toBe("failed")
      expect(result.errorKind).toBe("ownership_denied")
      expect(result.error).toContain("actual write paths violate ownership")
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test("../ path escape → rejected", async () => {
    const { env, projectRoot } = buildEnv()
    registerWriteCap(env)
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: join(projectRoot, ".orcana", "worktrees", "a1") })
    try {
      const run = await runScheduler(spec([writeNode("a1:w:1", "../evil.ts")]), reg(), { harness: env, pool })
      const result = resultOf(run, "a1:w:1")
      expect(result.status).toBe("failed")
      expect(result.errorKind).toBe("ownership_denied")
      expect(result.error).toContain("escapes project root")
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test("symlink escape → rejected", async () => {
    const { env, projectRoot } = buildEnv()
    registerWriteCap(env)
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: join(projectRoot, ".orcana", "worktrees", "a1") })
    try {
      const wt = join(projectRoot, ".orcana", "worktrees", "a1")
      mkdirSync(join(wt, ".."), { recursive: true })
      // 在 worktree 内放一个指向项目外的 symlink（模拟逃逸路径）
      const outside = join(projectRoot, "..", "outside-target.ts")
      writeFileSync(outside, "x")
      mkdirSync(wt, { recursive: true })
      symlinkSync(outside, join(wt, "link.ts"))
      const run = await runScheduler(spec([writeNode("a1:w:1", "link.ts")]), reg(), { harness: env, pool })
      const result = resultOf(run, "a1:w:1")
      expect(result.status).toBe("failed")
      expect(result.errorKind).toBe("ownership_denied")
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
      rmSync(join(projectRoot, "..", "outside-target.ts"), { force: true })
    }
  })

  test("absolute-path bypass → rejected", async () => {
    const { env, projectRoot } = buildEnv()
    registerWriteCap(env)
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: join(projectRoot, ".orcana", "worktrees", "a1") })
    try {
      const outside = mkdtempSync(join(tmpdir(), "m3-abs-"))
      const run = await runScheduler(spec([writeNode("a1:w:1", join(outside, "x.ts"))]), reg(), { harness: env, pool })
      const result = resultOf(run, "a1:w:1")
      expect(result.status).toBe("failed")
      expect(result.errorKind).toBe("ownership_denied")
      expect(result.error).toContain("escapes project root")
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test("planner (writable=false) cannot write → rejected", async () => {
    const { env, projectRoot } = buildEnv()
    registerWriteCap(env)
    const pool = new AgentPool()
    pool.register({ id: "planner", ownerFiles: ["plan.md"], worktree: join(projectRoot, ".orcana", "worktrees", "planner"), writable: false })
    try {
      const run = await runScheduler(spec([writeNode("planner:w:1", "plan.md")]), reg(), { harness: env, pool })
      const result = resultOf(run, "planner:w:1")
      expect(result.status).toBe("failed")
      expect(result.errorKind).toBe("ownership_denied")
      expect(result.error).toContain("not writable")
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

describe("M3: worktree isolation", () => {
  test("two agents write into their own worktrees; main workspace unchanged", async () => {
    const { env, projectRoot } = buildEnv()
    registerWriteCap(env)
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: join(projectRoot, ".orcana", "worktrees", "a1") })
    pool.register({ id: "b1", ownerFiles: ["b.ts"], worktree: join(projectRoot, ".orcana", "worktrees", "b1") })
    const wtA = join(projectRoot, ".orcana", "worktrees", "a1")
    const wtB = join(projectRoot, ".orcana", "worktrees", "b1")
    // worktree 在运行结束时 dispose —— 在节点完成回调里捕获写入内容
    const captured: Record<string, string | undefined> = {}
    try {
      const run = await runScheduler(
        spec([
          writeNode("a1:w:1", "a.ts"),
          writeNode("b1:w:1", "b.ts"),
        ]),
        reg(),
        {
          harness: env,
          pool,
          onNodeFinished: result => {
            if (result.nodeId === "a1:w:1") captured.a = readFileIfExists(join(wtA, "a.ts"))
            if (result.nodeId === "b1:w:1") captured.b = readFileIfExists(join(wtB, "b.ts"))
          },
        },
      )
      expect(resultOf(run, "a1:w:1").status).toBe("done")
      expect(resultOf(run, "b1:w:1").status).toBe("done")
      // 内容落在各自 worktree（各自独立）
      expect(captured.a).toBe("new")
      expect(captured.b).toBe("new")
      // 主工作区未变化（合并前不出现新文件）
      expect(existsSync(join(projectRoot, "a.ts"))).toBe(false)
      expect(existsSync(join(projectRoot, "b.ts"))).toBe(false)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test("worktrees are disposed at run end", async () => {
    const { env, projectRoot } = buildEnv()
    registerWriteCap(env)
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: join(projectRoot, ".orcana", "worktrees", "a1") })
    const wtA = join(projectRoot, ".orcana", "worktrees", "a1")
    try {
      const run = await runScheduler(spec([writeNode("a1:w:1", "a.ts")]), reg(), { harness: env, pool })
      expect(resultOf(run, "a1:w:1").status).toBe("done")
      // snapshot 模式 dispose = rmSync → 目录不残留
      expect(existsSync(wtA)).toBe(false)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test("crashed runs leave detectable legacy worktrees", async () => {
    const { projectRoot } = buildEnv()
    try {
      // 模拟崩溃残留：手动创建 worktree 目录
      const legacy = join(projectRoot, ".orcana", "worktrees", "zombie")
      mkdirSync(legacy, { recursive: true })
      writeFileSync(join(legacy, "leftover.txt"), "x")
      const found = detectLegacyWorktrees(projectRoot)
      expect(found).toContain(legacy)
      expect(found.length).toBeGreaterThan(0)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

describe("M3: single-agent regression", () => {
  test("no pool → legacy behavior unchanged (write tool on shared workspace)", async () => {
    const { env, projectRoot } = buildEnv()
    registerWriteCap(env)
    try {
      const run = await runScheduler(
        spec([
          { id: "w:1", handler: "test.reducer", input: {}, dependsOn: [], execution: { kind: "tool", capabilityId: "mock_write", params: { path: "shared.ts" } } },
        ]),
        reg(),
        { harness: env },
      )
      expect(resultOf(run, "w:1").status).toBe("done")
      // 无 pool：写入共享工作区（旧行为）
      expect(existsSync(join(projectRoot, "shared.ts"))).toBe(true)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test("pool present but node unassigned → legacy behavior unchanged", async () => {
    const { env, projectRoot } = buildEnv()
    registerWriteCap(env)
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: join(projectRoot, ".orcana", "worktrees", "a1") })
    try {
      const run = await runScheduler(
        spec([
          { id: "w:1", handler: "test.reducer", input: {}, dependsOn: [], execution: { kind: "tool", capabilityId: "mock_write", params: { path: "free.ts" } } },
        ]),
        reg(),
        { harness: env, pool },
      )
      expect(resultOf(run, "w:1").status).toBe("done")
      expect(existsSync(join(projectRoot, "free.ts"))).toBe(true)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

function readFileIfExists(p: string): string | undefined {
  try {
    return readFileSync(p, "utf8")
  } catch {
    return undefined
  }
}
