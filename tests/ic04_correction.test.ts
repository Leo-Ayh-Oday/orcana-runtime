/** IC04 Correction Gate #1 —— P0-4（run-scoped 单 coordinator 实例）+
 *  P0-5（ToolNode coordinator wiring）regression。
 *
 *  P0-4:
 *   A. run 生命周期（fresh → 完成）coordinator identity 不变（configure 不 replace）
 *   B. 同一 runScope 两个 LlmAgentNode 执行 → coordinator identity 不变
 *   C. physical 连续累计：node1=2 + node2=1 → scope total=3；cap=3 时第 4 个不发
 *  P0-5:
 *   ToolNode.execute() 经 coordinator 授权（authorizeRetry 真实调用）：
 *   read/none retryable → 1 initial + 1 coordinator retry；write → 0
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { buildTools, Result } from "../src/tools/registry"
import { createLlmAgentNode } from "../src/harness/nodes/llm-agent-node"
import { createToolNode } from "../src/harness/nodes/tool-node"
import { createNodeExecutionContext } from "../src/harness/nodes/context"
import { runNodeToResult } from "../src/harness/nodes/run"
import { createCapabilityRegistry } from "../src/harness/capabilities/registry"
import { registerToolCapabilities } from "../src/harness/capabilities/tool-adapter"
import { createCapabilityDescriptor } from "../src/harness/capabilities/descriptor"
import { assembleRunScope } from "../src/harness/runtime/run-scope"
import { createBudgetLedger, mergeRunBudget } from "../src/harness/runtime/budget-ledger"
import type { AgentRun } from "../src/harness/contracts/run"
import type { NodeExecutionContext } from "../src/harness/contracts/nodes"
import { RetryCoordinator } from "../src/runtime/retry/coordinator"
import { createRetryLedger } from "../src/runtime/retry-ledger"

const SAVED_FLASH_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
process.env.ORCANA_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_FLASH_TRIAGE === undefined) delete process.env.ORCANA_FLASH_TRIAGE
  else process.env.ORCANA_FLASH_TRIAGE = SAVED_FLASH_TRIAGE
})

const projectRoots: string[] = []
afterAll(() => {
  for (const root of projectRoots) rmSync(root, { recursive: true, force: true })
})

/** provider: r0 工具调用（2 physical per node via 2 rounds 时用 ToolEachRound）。 */
class ToolEachRoundProvider implements LLMProvider {
  rounds = 0
  async *streamChat(_o: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.rounds++
    yield { type: "tool_call", data: { id: `t-${this.rounds}`, name: "baseline_probe", input: {} } }
  }
}

class OneRoundTextProvider implements LLMProvider {
  rounds = 0
  async *streamChat(_o: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    yield { type: "token_usage", data: { inputTokens: 10, outputTokens: 5, cacheSource: "provider", round: this.rounds++ } }
    yield { type: "text", data: "done" }
  }
}

function probeTool() {
  return buildTools({
    name: "baseline_probe",
    description: "probe",
    isReadonly: true,
    isConcurrencySafe: true,
    inputSchema: { type: "object", properties: {}, required: [] },
    execute() {
      return Result.ok("ok")
    },
  })
}

function buildNodeContext(budgetLimits?: Record<string, number>): { context: NodeExecutionContext; run: AgentRun; coordinatorRef: RetryCoordinator } {
  const projectRoot = mkdtempSync(join(tmpdir(), "ic04-p04-"))
  projectRoots.push(projectRoot)
  const runId = `run-${projectRoot.split("/").pop()}`
  const controller = new AbortController()
  const scope = assembleRunScope({
    runId,
    sessionId: "sess-p04",
    projectRoot,
    controller,
    retryCoordinatorCap: budgetLimits?.maxModelCalls ?? 3,
  })
  const input: AgentRunInputInput = { prompt: "read", maxRounds: 10 }
  const run: AgentRun = {
    runId,
    sessionId: "sess-p04",
    status: "running",
    input: input as never,
    scope,
    budget: createBudgetLedger(mergeRunBudget(budgetLimits)),
    createdAt: Date.now(),
    eventSequence: 0,
    schemaVersion: 1,
  }
  const capabilities = createCapabilityRegistry()
  registerToolCapabilities(capabilities, probeTool())
  const context = createNodeExecutionContext({
    run,
    capabilities,
    context: createMinimalContextSlice(),
  })
  return { context, run, coordinatorRef: scope.retryCoordinator! }
}

interface AgentRunInputInput { prompt: string; maxRounds: number }

function createMinimalContextSlice() {
  return { cwd: "/tmp", env: {} } as never
}

describe("IC04 P0-4: run-scoped 单 RetryCoordinator 实例", () => {
  test("B: 同一 runScope 两个 LlmAgentNode 执行 → coordinator identity 不变", async () => {
    const { context, coordinatorRef } = buildNodeContext({ maxModelCalls: 10 })
    // HarnessNode 单次使用 —— 每个 node 新实例，但共享同一 runScope。
    const node1 = createLlmAgentNode({
      id: "agent-1",
      deps: { provider: new ToolEachRoundProvider(), tools: probeTool() },
    })
    const r1 = await runNodeToResult(node1, context, { prompt: "inspect", maxRounds: 3 })
    expect(r1.result.status).toBe("paused")
    const refAfterFirst = context.runScope.retryCoordinator
    expect(refAfterFirst).toBe(coordinatorRef)
    const node2 = createLlmAgentNode({
      id: "agent-2",
      deps: { provider: new ToolEachRoundProvider(), tools: probeTool() },
    })
    const r2 = await runNodeToResult(node2, context, { prompt: "inspect again", maxRounds: 2 })
    expect(r2.result.status).toBe("paused")
    expect(context.runScope.retryCoordinator).toBe(coordinatorRef)
  })

  test("C: physical 连续累计（node1=2 + node2=1 → total=3）；cap=3 时第 4 个请求不发", async () => {
    const { context, coordinatorRef } = buildNodeContext({ maxModelCalls: 3 })
    const node = createLlmAgentNode({
      id: "agent-1",
      deps: { provider: new ToolEachRoundProvider(), tools: probeTool() },
    })
    // node1: maxRounds=2 → 2 次 provider round → physical=2
    await runNodeToResult(node, context, { prompt: "inspect", maxRounds: 2 })
    expect(coordinatorRef.physicalProviderRequests).toBe(2)
    // node2: 1 round → physical=3（累计，不是重置为 1）
    const node2 = createLlmAgentNode({
      id: "agent-2",
      deps: { provider: new OneRoundTextProvider(), tools: probeTool() },
    })
    const r2 = await runNodeToResult(node2, context, { prompt: "summarize", maxRounds: 1 })
    expect(coordinatorRef.physicalProviderRequests).toBe(3)
    // cap=3 → 第 4 个 provider request 永不发出：再跑 node 会因
    // coordinator deny 在第一次 streamChat 前终止（cancelled finish）。
    expect(r2.result.status).toBe("succeeded")
    const node3 = createLlmAgentNode({
      id: "agent-3",
      deps: { provider: new ToolEachRoundProvider(), tools: probeTool() },
    })
    const r3 = await runNodeToResult(node3, context, { prompt: "more", maxRounds: 2 })
    // coordinator deny → 结构化 cancelled → node 不成功
    expect(coordinatorRef.physicalProviderRequests).toBe(3)
    expect(r3.result.status).not.toBe("succeeded")
    expect(r3.result.status).toBe("cancelled")
  })

  test("A: run 生命周期内 coordinator identity 不变（configure 不 replace）", async () => {
    const { run, coordinatorRef, context } = buildNodeContext({ maxModelCalls: 5 })
    void run
    void context
    // assembleRunScope 创建的 coordinator 即为 run-scope 的唯一实例；
    // node 执行（configureBudgetConsumer 路径）后 identity 必须保持。
    const node = createLlmAgentNode({
      id: "agent-a",
      deps: { provider: new OneRoundTextProvider(), tools: probeTool() },
    })
    await runNodeToResult(node, context, { prompt: "go", maxRounds: 1 })
    expect(context.runScope.retryCoordinator).toBe(coordinatorRef)
    expect(coordinatorRef.maxPhysicalProviderRequests).toBe(5)
  })
})

describe("IC04 P0-5: ToolNode production 传 RetryCoordinator", () => {
  test("retryable read capability：ToolNode.execute 内 authorizeRetry 真实被调用（1 retry）", async () => {
    const { context, coordinatorRef } = buildNodeContext({ maxModelCalls: 10 })
    // coordinator spy：数 tool 类 authorizeRetry
    let toolRetryAllows = 0
    const observer = (d: { kind: string; action: string; retryClass?: string }) => {
      if (d.kind === "tool" && d.action === "allow") toolRetryAllows++
    }
    coordinatorRef.attachDecisionObserver(observer as never)
    // 覆盖 probe 的 handler：第一次失败、第二次成功（retryable=true 经
    // registerToolCapabilities 投影 —— probeTool isReadonly riskLevel<=2）。
    const registry = context.capabilities
    let calls = 0
    // 覆盖注册一个显式 retryable read capability（与 registerToolCapabilities
    // 投影一致：retryable=true + sideEffect="read"）。
    registry.register(
      { ...createCapabilityDescriptor({ id: "baseline_probe", kind: "tool", inputSchema: { type: "object", properties: {}, required: [] }, retryable: true, sideEffect: "read" }) },
      {
        async execute() {
          calls++
          if (calls === 1) return { ok: false, error: "transient" }
          return { ok: true, output: { success: true, content: "ok" } }
        },
      },
    )
    const gate = new (await import("../src/agent/permission")).PermissionGate()
    gate.allow("baseline_probe")
    const node = createToolNode({ id: "tool-1", policyContext: { permissionGate: gate, input: {} } })
    const { result } = await runNodeToResult(node, context, { capabilityId: "baseline_probe", params: {} })
    expect(result.output?.success).toBe(true)
    expect(calls).toBe(2)
    expect(toolRetryAllows).toBe(1)
  })

  test("write capability：自动 retry = 0（write/external fail-closed 经 ToolNode）", async () => {
    const { context, coordinatorRef } = buildNodeContext({ maxModelCalls: 10 })
    let toolRetries = 0
    coordinatorRef.attachDecisionObserver(((d: { kind: string; action: string }) => {
      if (d.kind === "tool" && d.action === "allow") toolRetries++
    }) as never)
    const registry = context.capabilities
    let calls = 0
    // retryable=true 也禁 blind automatic retry（write/external fail-closed）。
    registry.register(
      { ...createCapabilityDescriptor({ id: "mock_write_tn", kind: "tool", inputSchema: { type: "object", properties: {}, required: [] }, sideEffect: "write", retryable: true }) },
      {
        async execute() {
          calls++
          return { ok: false, error: "write failed" }
        },
      },
    )
    const gate2 = new (await import("../src/agent/permission")).PermissionGate()
    gate2.allow("mock_write_tn")
    const node = createToolNode({ id: "tool-2", policyContext: { permissionGate: gate2, input: {} } })
    const { result } = await runNodeToResult(node, context, {
      capabilityId: "mock_write_tn",
      params: { path: "a.ts" },
    })
    expect(calls).toBe(1)
    expect(toolRetries).toBe(0)
    expect(result.error?.kind).toBe("tool_failed")
  })
})

describe("IC04 P1-15: serialization restore 恢复 physical cap", () => {
  test("原 maxModelCalls=7 → restore 后 coordinator.maxPhysicalProviderRequests=7（不回落 derived 50）", async () => {
    const { serializeRun, restoreAgentRun } = await import("../src/harness/persistence/serialization")
    // 用 run-registry 创建带 budget 的 run，序列化后再 restore。
    const { RunRegistry } = await import("../src/harness/runtime/run-registry")
    const registry = new RunRegistry()
    const registered = registry.create({
      sessionId: "sess-restore",
      projectRoot: "/tmp",
      input: { prompt: "x", maxRounds: 5, budget: { maxModelCalls: 7 } } as never,
    })
    // coordinator cap 在创建时确定 = explicit maxModelCalls = 7。
    expect(registered.run.scope.retryCoordinator!.maxPhysicalProviderRequests).toBe(7)
    const serialized = serializeRun({ run: registered.run, workspaceHash: "h", artifactRefs: [], artifactState: { artifacts: [], contents: [] } } as never)
    const restored = restoreAgentRun({ serializable: serialized as never, projectRoot: "/tmp" })
    expect(restored.scope.retryCoordinator!.maxPhysicalProviderRequests).toBe(7)
    expect(restored.scope.retryCoordinator!.retryLedger).toBe(restored.scope.retryLedger)
  })
})

describe("IC04 P0-2: constraint distillation 经 coordinatedProvider（同 RetryCoordinator 计数）", () => {
  test("history eviction ≥3 user msgs → distill physical call 计入 coordinator（bypass=0）", async () => {
    const SAVED_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
    process.env.ORCANA_FLASH_TRIAGE = "off"
    const { agentLoop } = await import("../src/agent/loop")
    // counting provider：每次 streamChat（蒸馏 or main）都计数。
    let providerCalls = 0
    const countingProvider: LLMProvider = {
      async *streamChat(_o: ProviderCallOptions): AsyncGenerator<StreamEvent> {
        providerCalls++
        yield { type: "text", data: "answer" }
      },
    }
    const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 100 })
    // 70 条历史 → 窗口（maxMessages=60）裁掉 10 条 user 消息（≥3）→ 蒸馏触发。
    const conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = []
    for (let i = 0; i < 35; i++) {
      conversationHistory.push({ role: "user", content: `constraint-${i}: keep the project safe and read-only` })
      conversationHistory.push({ role: "assistant", content: `ok-${i}` })
    }
    const iterator = agentLoop("inspect the project state", {
      provider: countingProvider,
      model: "test",
      tools: [],
      maxRounds: 2,
      retryCoordinator: coordinator,
      conversationHistory,
      contextMapPolicy: "off",
    })
    let step: IteratorResult<StreamEvent, { kind: string }>
    do {
      step = await iterator.next()
    } while (!step.done)
    // 蒸馏 1 次 + main 1 轮 = 2 次 streamChat；coordinator physical 计数 = 2
    // （若蒸馏绕过 coordinator，physical 只含 main=1）。
    expect(providerCalls).toBeGreaterThanOrEqual(2)
    expect(coordinator.physicalProviderRequests).toBeGreaterThanOrEqual(2)
    if (SAVED_TRIAGE === undefined) delete process.env.ORCANA_FLASH_TRIAGE
    else process.env.ORCANA_FLASH_TRIAGE = SAVED_TRIAGE
  })
})

describe("IC04 P0-1 integration: 每 completed logical round exactly-once progress accounting", () => {
  test("连续 3 个无进展截断轮 → 每轮 exactly 1×progress_delta + 1×loop_supervisor_decision，streak 实际增长到 stalled", async () => {
    const SAVED_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
    process.env.ORCANA_FLASH_TRIAGE = "off"
    const { agentLoop } = await import("../src/agent/loop")
    class MemoryTrace {
      events: Array<{ type: string; data?: unknown }> = []
      record(type: string, data?: unknown) { this.events.push({ type, data }) }
    }
    class TruncOnlyProvider implements LLMProvider {
      rounds = 0
      async *streamChat(_o: ProviderCallOptions): AsyncGenerator<StreamEvent> {
        this.rounds++
        yield { type: "truncated", data: { stopReason: "max_tokens", toolCalls: 0 } }
      }
    }
    const trace = new MemoryTrace()
    const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 100 })
    const provider = new TruncOnlyProvider()
    const iterator = agentLoop("inspect", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 10,
      retryCoordinator: coordinator,
      runTrace: trace as never,
      contextMapPolicy: "off",
    })
    let step: IteratorResult<StreamEvent, { kind: string }>
    do { step = await iterator.next() } while (!step.done)
    const deltas = trace.events.filter(e => e.type === "progress_delta")
    const decisions = trace.events.filter(e => e.type === "loop_supervisor_decision")
    // 3 轮截断 + 每轮 exactly one evaluation。
    expect(deltas.length).toBe(3)
    expect(decisions.length).toBe(3)
    // truncation streak 实际增长 1→2→3（trace 证据，非类型层证明）。
    const streaks = decisions.map(d => (d.data as { truncationStreak: number }).truncationStreak)
    expect(streaks).toEqual([1, 2, 3])
    const stalled = trace.events.find(e => e.type === "agent_loop_stalled")
    expect(stalled).toBeDefined()
    expect((stalled!.data as { reason?: string }).reason).toBe("truncation")
    if (SAVED_TRIAGE === undefined) delete process.env.ORCANA_FLASH_TRIAGE
    else process.env.ORCANA_FLASH_TRIAGE = SAVED_TRIAGE
  })
})

describe("IC04 P1-10: env 级 physical budget（真实 env 路径）", () => {
  test("ORCANA_MAX_ROUNDS=10 + 无 explicit maxRounds → logical=10 → derived physical=20", async () => {
    const SAVED_ROUNDS = process.env.ORCANA_MAX_ROUNDS
    const SAVED_REQUESTS = process.env.ORCANA_MAX_PROVIDER_REQUESTS
    process.env.ORCANA_MAX_ROUNDS = "10"
    delete process.env.ORCANA_MAX_PROVIDER_REQUESTS
    const { RunRegistry } = await import("../src/harness/runtime/run-registry")
    const registry = new RunRegistry()
    const registered = registry.create({
      sessionId: "sess-env-rounds",
      projectRoot: "/tmp",
      input: { prompt: "x" } as never,
    })
    expect(registered.run.budget.limits.maxModelCalls).toBe(20)
    expect(registered.run.scope.retryCoordinator!.maxPhysicalProviderRequests).toBe(20)
    if (SAVED_ROUNDS === undefined) delete process.env.ORCANA_MAX_ROUNDS
    else process.env.ORCANA_MAX_ROUNDS = SAVED_ROUNDS
    if (SAVED_REQUESTS === undefined) delete process.env.ORCANA_MAX_PROVIDER_REQUESTS
    else process.env.ORCANA_MAX_PROVIDER_REQUESTS = SAVED_REQUESTS
  })

  test("ORCANA_MAX_PROVIDER_REQUESTS=7 → physical=7（优先于 derived）", async () => {
    const SAVED_REQUESTS = process.env.ORCANA_MAX_PROVIDER_REQUESTS
    process.env.ORCANA_MAX_PROVIDER_REQUESTS = "7"
    const { RunRegistry } = await import("../src/harness/runtime/run-registry")
    const registry = new RunRegistry()
    const registered = registry.create({
      sessionId: "sess-env-req",
      projectRoot: "/tmp",
      input: { prompt: "x", maxRounds: 50 } as never,
    })
    expect(registered.run.budget.limits.maxModelCalls).toBe(7)
    expect(registered.run.scope.retryCoordinator!.maxPhysicalProviderRequests).toBe(7)
    if (SAVED_REQUESTS === undefined) delete process.env.ORCANA_MAX_PROVIDER_REQUESTS
    else process.env.ORCANA_MAX_PROVIDER_REQUESTS = SAVED_REQUESTS
  })
})

// ════ IC04 Correction Gate #2 regressions ════

import { OpenAIProvider } from "../src/provider/openai"

describe("Gate#2 Blocker A: coordinated generic retry fail-closed", () => {
  const { decideProviderFailureRecovery } = require("../src/agent/provider/failure-policy") as typeof import("../src/agent/provider/failure-policy")
  const base = (over: Record<string, unknown> = {}) => ({
    failure: { message: "socket closed", retryable: true },
    round: 0,
    maxRounds: 3,
    finalText: "",
    taskTracker: null,
    changedFiles: [],
    ...over,
  })

  test("A: taskTracker=null + retryCoordinator → break，RetryLedger.truncation=0", () => {
    const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 100 })
    const decision = decideProviderFailureRecovery(base({ retryCoordinator: coordinator }) as never)
    expect(decision.action).toBe("break")
    expect(coordinator.retryLedger.summary().byClass.truncation).toBe(0)
    expect(coordinator.retryLedger.summary().totalAttempts).toBe(0)
  })

  test("B: taskTracker exists + retryCoordinator → break，truncation=0", () => {
    const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 100 })
    const decision = decideProviderFailureRecovery(base({
      taskTracker: { missingRequirements: () => [] } as never,
      retryCoordinator: coordinator,
    }) as never)
    expect(decision.action).toBe("break")
    expect(coordinator.retryLedger.summary().byClass.truncation).toBe(0)
  })

  test("standalone（无 coordinator 无 ledger）legacy 保留原续跑行为", () => {
    const decision = decideProviderFailureRecovery(base({ taskTracker: { goal: "x", intent: "build", phase: "planning", requiredFiles: [], requiredVerificationKinds: [], verificationEvidence: {}, verification: [], steps: [] } as never }) as never)
    expect(decision.action).toBe("continue")
  })
})

describe("Gate#2 Blocker B: RetryAuthorityDecision 接入 runTrace", () => {
  test("agentLoop runTrace 记录 initial allow + retry allow + retry deny（retry_authority ×3），observer 结束后 detach", async () => {
    const SAVED_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
    process.env.ORCANA_FLASH_TRIAGE = "off"
    const { agentLoop } = await import("../src/agent/loop")
    class MemoryTrace {
      events: Array<{ type: string; data?: unknown }> = []
      record(type: string, data?: unknown) { this.events.push({ type, data }) }
    }
    // mock OpenAI：500 → 500 → 200（2 retry allow + 1 deny 需要 4 次调用；
    // 这里 500×3 → 第 4 次 physical 之前 class deny —— 简化用 500×3）。
    class FlakyOpenAI extends OpenAIProvider {
      calls = 0
      constructor() {
        super("k", {
          baseURL: "https://test.local/v1",
          fetch: (async () => {
            this.calls++
            if (this.calls <= 3) return new Response("server error", { status: 500, headers: { "Content-Type": "application/json" } })
            return new Response("data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } })
          }) as unknown as typeof fetch,
          sleep: async () => {},
        })
      }
    }
    const trace = new MemoryTrace()
    const provider = new FlakyOpenAI()
    const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 100 })
    const iterator = agentLoop("hello", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 3,
      retryCoordinator: coordinator,
      runTrace: trace as never,
      contextMapPolicy: "off",
    })
    let step: IteratorResult<StreamEvent, { kind: string }>
    do { step = await iterator.next() } while (!step.done)
    const audit = trace.events.filter(e => e.type === "retry_authority")
    // initial allow + 2 retry allow + 1 retry deny = 4 条（transport limit 2）。
    expect(audit.length).toBe(4)
    const kinds = audit.map(a => (a.data as { action: string }).action)
    expect(kinds).toEqual(["allow", "allow", "allow", "deny"])
    expect((audit[0]!.data as { kind: string }).kind).toBe("provider_initial")
    expect((audit[1]!.data as { retryClass: string }).retryClass).toBe("transport")
    expect((audit[3]!.data as { reason: string }).reason).toBe("class_exhausted")
    // 字段完整性 + 无敏感载荷。
    for (const a of audit) {
      const d = a.data as Record<string, unknown>
      expect(d).toHaveProperty("action")
      expect(d).toHaveProperty("kind")
      expect(d).toHaveProperty("physicalProviderRequests")
      expect(d).toHaveProperty("maxPhysicalProviderRequests")
      expect(JSON.stringify(d)).not.toMatch(/prompt|api[_-]?key|secret|password/i)
    }
    // observer 已 detach：再执行一次 authorize 不产生新 trace。
    const before = trace.events.length
    coordinator.authorizeProviderAttempt({})
    expect(trace.events.length).toBe(before)
    if (SAVED_TRIAGE === undefined) delete process.env.ORCANA_FLASH_TRIAGE
    else process.env.ORCANA_FLASH_TRIAGE = SAVED_TRIAGE
  })
})

describe("Gate#2 Blocker C: numeric cap deny 不调用消费接口", () => {
  test("numeric=2 external=5（不相等）→ request3 numeric deny：external used 不变=2、notification fired、不 tryConsume", async () => {
    const { createBudgetLedger, mergeRunBudget } = await import("../src/harness/runtime/budget-ledger")
    const { BudgetGuard } = await import("../src/harness/runtime/budget-guard")
    const ledger = createBudgetLedger(mergeRunBudget({ maxModelCalls: 5 }))
    const abortController = new AbortController()
    const guard = new BudgetGuard(ledger, reason => abortController.abort(reason), { modelCallAuthority: "source" })
    let notifications = 0
    const coordinator = new RetryCoordinator({
      ledger: createRetryLedger(),
      maxPhysicalProviderRequests: 2,
      externalBudgetConsumer: {
        tryConsume: () => guard.tryConsumeModelCall(),
        onPhysicalBudgetExhausted: () => { notifications++ },
      },
    })
    coordinator.authorizeProviderAttempt({})
    coordinator.authorizeProviderAttempt({})
    expect(coordinator.physicalProviderRequests).toBe(2)
    expect(ledger.used.modelCalls).toBe(2)
    // request3：numeric cap deny —— external used 不得变 3。
    const denied = coordinator.authorizeProviderAttempt({ retryClass: "transport", fingerprint: "server:500" })
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toBe("physical_request_budget")
    expect(ledger.used.modelCalls).toBe(2)
    expect(coordinator.physicalProviderRequests).toBe(2)
    expect(coordinator.retryLedger.summary().totalAttempts).toBe(0)
    // 非消费 notification fired（不 abort —— notification 由 harness 绑定）。
    expect(notifications).toBe(1)
    expect(abortController.signal.aborted).toBe(false)
  })
})

describe("Gate#2 Blocker D: node.usage 实时 modelCalls 用 node delta", () => {
  test("node2（run 累计 3）实时 node.usage.modelCalls=1、final=1（非 run-global 3）", async () => {
    const { createLlmAgentNode } = await import("../src/harness/nodes/llm-agent-node")
    const { createNodeExecutionContext } = await import("../src/harness/nodes/context")
    const { runNodeToResult } = await import("../src/harness/nodes/run")
    const { createCapabilityRegistry } = await import("../src/harness/capabilities/registry")
    const { registerToolCapabilities } = await import("../src/harness/capabilities/tool-adapter")
    const { assembleRunScope } = await import("../src/harness/runtime/run-scope")
    const { createBudgetLedger, mergeRunBudget } = await import("../src/harness/runtime/budget-ledger")
    const projectRoot = mkdtempSync(join(tmpdir(), "ic04-g2d-"))
    projectRoots.push(projectRoot)
    const scope = assembleRunScope({ runId: "run-g2d", sessionId: "s-g2d", projectRoot, controller: new AbortController(), retryCoordinatorCap: 10 })
    const run: AgentRun = {
      runId: "run-g2d", sessionId: "s-g2d", status: "running",
      input: { prompt: "x", maxRounds: 5 } as never,
      scope, budget: createBudgetLedger(mergeRunBudget({ maxModelCalls: 10 })), createdAt: Date.now(), eventSequence: 0, schemaVersion: 1,
    }
    const capabilities = createCapabilityRegistry()
    registerToolCapabilities(capabilities, probeTool())
    const context = createNodeExecutionContext({ run, capabilities, context: { cwd: "/tmp", env: {} } as never })
    const nodeA = createLlmAgentNode({ id: "a", deps: { provider: new ToolEachRoundProvider(), tools: probeTool() } })
    await runNodeToResult(nodeA, context, { prompt: "inspect", maxRounds: 2 })
    const runPhysicalAfterNode1 = scope.retryCoordinator!.physicalProviderRequests
    expect(runPhysicalAfterNode1).toBe(2)
    // node2：1 轮 text。
    const nodeB = createLlmAgentNode({ id: "b", deps: { provider: new OneRoundTextProvider(), tools: probeTool() } })
    const { events, result } = await runNodeToResult(nodeB, context, { prompt: "summarize", maxRounds: 1 })
    const usageEvents = events.filter(e => e.type === "node.usage")
    const lastStreaming = (usageEvents[usageEvents.length - 1] as { usage: { modelCalls: number } } | undefined)?.usage
    expect(lastStreaming?.modelCalls).toBe(1)
    expect(result.output?.usage.modelCalls).toBe(1)
    expect(scope.retryCoordinator!.physicalProviderRequests).toBe(3)
  })
})
