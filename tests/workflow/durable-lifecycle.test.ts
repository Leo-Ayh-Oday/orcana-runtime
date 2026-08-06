/** Batch 4 acceptance: durable + lifecycle (P1 closeout).
 *
 *  M13 — checkpoints are written atomically (temp+fsync+rename) with
 *        observable errors; corrupted/underrivable checkpoints never lose
 *        the previous generation;
 *  M14 — cache keys bind the workspace digest: same input + changed
 *        workspace ⇒ MISS (no stale read replay across external changes);
 *  M16 — worktrees are disposed on EVERY exit path (interrupt included);
 *  M17 — duplicate agent registrations are rejected (no phantom
 *        ownership);
 *  M18 — the declared AgentSpec.worktree root is authoritative;
 *  M19 — role-declared nodes have their output validated before use.
 */

import { describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../../src/provider/types"
import { buildTools, Result } from "../../src/tools/registry"
import { runScheduler } from "../../src/workflow/scheduler/scheduler"
import type { WorkflowSpec, WorkflowNodeSpec } from "../../src/workflow/types"
import type { HandlerRegistry } from "../../src/workflow/execution/handler-registry"
import { HandlerRegistry as RegistryImpl } from "../../src/workflow/execution/handler-registry"
import type { WorkflowHarnessEnvironment } from "../../src/workflow/harness/environment"
import { assembleRunScope } from "../../src/harness/runtime/run-scope"
import { mergeRunBudget } from "../../src/harness/runtime/budget-ledger"
import { createCapabilityRegistry } from "../../src/harness/capabilities/registry"
import { createCapabilityDescriptor } from "../../src/harness/capabilities/descriptor"
import { ResultCache } from "../../src/workflow/results/result-cache"
import { ResultStore } from "../../src/workflow/results/result-store"
import { AgentPool } from "../../src/workflow/agents/agent-pool"
import { InterruptStore } from "../../src/workflow/interrupts/interrupt-store"
import { ResumeController, computeSpecDigest } from "../../src/workflow/interrupts/resume-controller"

/* ── shared env helpers ─────────────────────────────────────────────── */

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
        const runContext = (meta as { metadata?: { runContext?: { projectRoot?: string } } })?.metadata?.runContext
        const root = runContext?.projectRoot!
        mkdirSync(join(root, ".."), { recursive: true })
        writeFileSync(join(root, params.path!), params.content ?? "new")
        return { ok: true, output: { success: true, content: "written", metadata: { paths: [join(root, params.path!)] } } }
      },
    },
  )
}

function buildEnv(): { env: WorkflowHarnessEnvironment; projectRoot: string } {
  const projectRoot = mkdtempSync(join(tmpdir(), "mw-lifecycle-"))
  const controller = new AbortController()
  const scope = assembleRunScope({ runId: "mw-lifecycle", sessionId: "mw-lifecycle", projectRoot, controller })
  const capabilities = createCapabilityRegistry()
  const env: WorkflowHarnessEnvironment = {
    scope,
    budgetLimits: mergeRunBudget(undefined),
    capabilities,
    policy: { allowCapabilities: ["mock_write", "mock_boom", "mock_observe_root"] },
  }
  registerWriteCap(env)
  return { env, projectRoot }
}

function reg(): HandlerRegistry {
  const registry = new RegistryImpl()
  registry.register("test.noop", "noop", async () => ({ content: "noop" }))
  return registry
}

function spec(nodes: WorkflowNodeSpec[], specId = "mw-lifecycle-spec"): WorkflowSpec {
  return { schemaVersion: "0.2", specId, mode: "read-write", nodes }
}

/* ── M13: atomic + observable checkpoints ───────────────────────────── */

describe("M13: checkpoint atomic + observable", () => {
  test("corrupted checkpoint ⇒ restore fails visibly, previous generation preserved", () => {
    const dir = mkdtempSync(join(tmpdir(), "mw-m13-"))
    const warn = spyOn(console, "warn")
    try {
      const store = new ResultStore("m13-spec", dir)
      store.put({ nodeId: "n:1", status: "done", output: { content: "v1" }, startedAt: 1, finishedAt: 2, durationMs: 1 })
      const file = join(dir, "m13-spec.json")
      expect(existsSync(file)).toBe(true)
      // 外部损坏 checkpoint（模拟崩溃截断）
      writeFileSync(file, "{corrupt", "utf-8")
      const fresh = new ResultStore("m13-spec", dir)
      expect(fresh.restore(dir)).toBe(false)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("checkpoint restore failed")) // 可观测
      expect(existsSync(file)).toBe(true) // 文件本身保留
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("write failure ⇒ no throw, previous generation preserved, error observable", () => {
    const dir = mkdtempSync(join(tmpdir(), "mw-m13-"))
    const warn = spyOn(console, "warn")
    try {
      const store = new ResultStore("m13-spec", dir)
      store.put({ nodeId: "n:1", status: "done", output: { content: "gen1" }, startedAt: 1, finishedAt: 2, durationMs: 1 })
      const file = join(dir, "m13-spec.json")
      const gen1 = readFileSync(file, "utf-8")
      // 让 checkpoint 路径不可写：把 checkpointDir 换成同名文件（mkdir 失败）
      const blocked = new ResultStore("m13-spec", join(dir, "occupied"))
      writeFileSync(join(dir, "occupied"), "a file, not a dir", "utf-8")
      expect(() => blocked.put({ nodeId: "n:2", status: "done", output: {}, startedAt: 3, finishedAt: 4, durationMs: 1 })).not.toThrow()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("checkpoint write failed")) // 可观测
      // 上一代 checkpoint 未被触碰
      expect(readFileSync(file, "utf-8")).toBe(gen1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("atomic writer never leaves a .tmp behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "mw-m13-"))
    try {
      const store = new ResultStore("m13-spec", dir)
      store.put({ nodeId: "n:1", status: "done", output: {}, startedAt: 1, finishedAt: 2, durationMs: 1 })
      expect(existsSync(join(dir, "m13-spec.json.tmp"))).toBe(false)
      expect(existsSync(join(dir, "m13-spec.json"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/* ── M14: result cache freshness bound ──────────────────────────────── */

describe("M14: result cache binds the workspace digest", () => {
  test("external workspace change ⇒ stale read re-executes (cache miss)", async () => {
    const { env, projectRoot } = buildEnv()
    const cache = new ResultCache()
    let calls = 0
    const registry = new RegistryImpl()
    registry.register("test.probe", "probe", async () => {
      calls++
      return { content: "probe" }
    })
    const probeSpec: WorkflowSpec = {
      schemaVersion: "0.2",
      specId: "m14-spec",
      nodes: [{ id: "r:1", handler: "test.probe", input: { q: 1 }, dependsOn: [] }],
    }
    try {
      // 同一 workspace 的第二次运行 → hit（digest 未变）
      await runScheduler(probeSpec, registry, { harness: env, cache })
      const before = calls
      await runScheduler(probeSpec, registry, { harness: env, cache })
      expect(calls - before).toBe(0)
      // 外部状态变更（另一窗口写入了 workspace）→ digest 变 → miss → 重新执行
      writeFileSync(join(projectRoot, "external-change.txt"), "someone else wrote", "utf-8")
      await runScheduler(probeSpec, registry, { harness: env, cache })
      expect(calls).toBe(2) // 不复用陈旧读取结果
      // 内容稳定后再次命中
      const stable = calls
      await runScheduler(probeSpec, registry, { harness: env, cache })
      expect(calls - stable).toBe(0)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

/* ── M16: worktree cleanup on every exit path ───────────────────────── */

describe("M16: worktrees disposed on every exit path", () => {
  test("interrupt path still disposes created worktrees", async () => {
    const { env, projectRoot } = buildEnv()
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: join(projectRoot, ".orcana", "worktrees", "a1") })
    const wt = join(projectRoot, ".orcana", "worktrees", "a1")
    const m16Spec = spec([
      {
        id: "a1:w:1",
        handler: "test.noop",
        input: { path: "a.ts" },
        dependsOn: [],
        assignment: "a1",
        execution: { kind: "tool", capabilityId: "mock_write", params: { path: "a.ts" } },
      },
      {
        id: "h:1",
        handler: "test.noop",
        input: {},
        dependsOn: ["a1:w:1"],
        execution: { kind: "human", prompt: "approve?", responseSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } },
      },
    ])
    try {
      const interruptStore = new InterruptStore(join(projectRoot, ".orcana", "workflow", "interrupts"))
      const run = await runScheduler(m16Spec, reg(), {
        harness: env,
        pool,
        interrupts: { controller: new ResumeController(interruptStore, projectRoot), specDigest: computeSpecDigest(m16Spec) },
      })
      expect(run.status).toBe("waiting_interrupt")
      // 暂停路径也必须清理 worktree（finally）
      expect(existsSync(wt)).toBe(false)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test("node failure path also disposes created worktrees", async () => {
    const { env, projectRoot } = buildEnv()
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: join(projectRoot, ".orcana", "worktrees", "a1") })
    const wt = join(projectRoot, ".orcana", "worktrees", "a1")
    // 节点执行异常：capability 抛错（tool 节点走 harness 路径，handler 不参与）
    env.capabilities.register(
      createCapabilityDescriptor({
        id: "mock_boom",
        kind: "tool",
        inputSchema: { type: "object", properties: {}, required: [] },
        sideEffect: "write",
      }),
      {
        async execute() {
          throw new Error("boom")
        },
      },
    )
    try {
      const run = await runScheduler(
        spec([
          {
            id: "a1:w:1",
            handler: "test.noop",
            input: { path: "a.ts" },
            dependsOn: [],
            assignment: "a1",
            execution: { kind: "tool", capabilityId: "mock_boom", params: { path: "a.ts" } },
          },
        ]),
        reg(),
        { harness: env, pool },
      )
      expect(run.results.find(r => r.nodeId === "a1:w:1")!.status).toBe("failed")
      expect(existsSync(wt)).toBe(false) // 异常节点路径也清理
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

/* ── M17: duplicate registration rejected ───────────────────────────── */

describe("M17: agent registration consistency", () => {
  test("re-registering an agent id is rejected, old agent intact", () => {
    const pool = new AgentPool()
    const first = pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: "/tmp/wt-a1" })
    expect(first.ok).toBe(true)
    const again = pool.register({ id: "a1", ownerFiles: ["b.ts"], worktree: "/tmp/wt-a1" })
    expect(again.ok).toBe(false)
    expect(again.error).toContain("already registered")
    // 旧注册不被污染
    expect(pool.get("a1")!.ownerFiles).toEqual(["a.ts"])
    expect(pool.canWrite("a1", "a.ts")).toBe(true)
    expect(pool.canWrite("a1", "b.ts")).toBe(false)
    expect(pool.size()).toBe(1)
  })
})

/* ── M18: declared worktree root is authoritative ───────────────────── */

describe("M18: AgentSpec.worktree root is authoritative", () => {
  test("explicit worktree root is used (not the default layout)", async () => {
    const { env, projectRoot } = buildEnv()
    const customRoot = mkdtempSync(join(tmpdir(), "mw-m18-"))
    const pool = new AgentPool()
    pool.register({ id: "a1", ownerFiles: ["a.ts"], worktree: customRoot })
    // 记录 capability 实际收到的执行根（run 结束时 dispose 会清理 worktree，
    // 不能在事后读文件断言位置）
    let observedRoot: string | undefined
    env.capabilities.register(
      createCapabilityDescriptor({
        id: "mock_observe_root",
        kind: "tool",
        inputSchema: { type: "object", properties: {}, required: [] },
        sideEffect: "write",
      }),
      {
        async execute() {
          const meta = arguments[1] as { metadata?: { runContext?: { projectRoot?: string } } }
          const root = meta?.metadata?.runContext?.projectRoot
          observedRoot = root
          // enforceActualWrites 要求写节点报告实际写入路径
          return { ok: true, output: { success: true, metadata: { paths: root ? [join(root, "a.ts")] : [] } } }
        },
      },
    )
    const registry = reg()
    // M7: H11 write nodes need a passing verification node to complete the run
    registry.register("tool.run_targeted_verification", "verify", async () => ({ content: "verified" }))
    try {
      const run = await runScheduler(
        spec([
          {
            id: "a1:w:1",
            handler: "test.noop",
            input: { path: "a.ts" },
            dependsOn: [],
            assignment: "a1",
            execution: { kind: "tool", capabilityId: "mock_observe_root", params: { path: "a.ts" } },
          },
          { id: "v:1", handler: "tool.run_targeted_verification", input: {}, dependsOn: ["a1:w:1"] },
        ]),
        registry,
        { harness: env, pool },
      )
      expect(run.results.find(r => r.nodeId === "a1:w:1")!.status).toBe("done")
      // 执行根是声明的 worktree root，而不是默认布局
      expect(observedRoot).toBe(customRoot)
      expect(existsSync(join(projectRoot, ".orcana", "worktrees", "a1"))).toBe(false)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
      rmSync(customRoot, { recursive: true, force: true })
    }
  })
})

/* ── M19: role output validated before use ──────────────────────────── */

class FixedTextProvider implements LLMProvider {
  constructor(private readonly text: string) {}
  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    yield { type: "token_usage", data: { inputTokens: 10, outputTokens: 5, cacheSource: "provider", round: 0 } }
    yield { type: "text", data: this.text }
  }
}

function buildLlmEnv(text: string): { env: WorkflowHarnessEnvironment; projectRoot: string } {
  const projectRoot = mkdtempSync(join(tmpdir(), "mw-m19-"))
  const controller = new AbortController()
  const scope = assembleRunScope({ runId: "mw-m19", sessionId: "mw-m19", projectRoot, controller })
  const capabilities = createCapabilityRegistry()
  const tools = buildTools({
    name: "baseline_probe",
    description: "probe",
    isReadonly: true,
    isConcurrencySafe: true,
    inputSchema: { type: "object", properties: {}, required: [] },
    execute() {
      return Result.ok("ok")
    },
  })
  const env: WorkflowHarnessEnvironment = {
    scope,
    budgetLimits: mergeRunBudget(undefined),
    capabilities,
    tools,
    loopDeps: { provider: new FixedTextProvider(text), tools },
  }
  return { env, projectRoot }
}

describe("M19: role output validated before use", () => {
  test("coder node returning invalid JSON ⇒ failed with invalid_role_output", async () => {
    const { env, projectRoot } = buildLlmEnv("this is not json")
    try {
      const run = await runScheduler(
        spec([
          {
            id: "agent:1",
            handler: "test.noop",
            input: { role: "coder" },
            dependsOn: [],
            execution: { kind: "llm_agent", prompt: "report", maxRounds: 2 },
          },
        ]),
        reg(),
        { harness: env },
      )
      const result = run.results.find(r => r.nodeId === "agent:1")!
      expect(result.status).toBe("failed")
      expect(result.errorKind).toBe("invalid_role_output")
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test("coder node returning schema-valid output ⇒ done", async () => {
    const valid = JSON.stringify({ changes: [], evidenceIds: [] })
    const { env, projectRoot } = buildLlmEnv(valid)
    try {
      const run = await runScheduler(
        spec([
          {
            id: "agent:1",
            handler: "test.noop",
            input: { role: "coder" },
            dependsOn: [],
            execution: { kind: "llm_agent", prompt: "report", maxRounds: 2 },
          },
        ]),
        reg(),
        { harness: env },
      )
      expect(run.results.find(r => r.nodeId === "agent:1")!.status).toBe("done")
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test("node without a declared role keeps legacy behavior (no schema gate)", async () => {
    const { env, projectRoot } = buildLlmEnv("free-form answer")
    try {
      const run = await runScheduler(
        spec([
          {
            id: "agent:1",
            handler: "test.noop",
            input: {},
            dependsOn: [],
            execution: { kind: "llm_agent", prompt: "report", maxRounds: 2 },
          },
        ]),
        reg(),
        { harness: env },
      )
      expect(run.results.find(r => r.nodeId === "agent:1")!.status).toBe("done")
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})
