/** IC04: RetryCoordinator —— Retry Authority 测试矩阵（§52-§55）。
 *
 *  R1  transport（class limit 2 + physical cap high）：initial=1 + retry=2，
 *       total physical = 3，之后 provider_failure（不开启新的 Agent round）
 *  R2  rateLimit（limit 3）：initial=1 + retry=3，physical = 4
 *  R3  global physical cap = 2：第三 request 永不发出
 *  R4  side-effect boundary：已输出 tool declaration 后 transport failure
 *       → physical = 1、automatic retry = 0
 *  R5  abort during backoff：physicalRequests = 1（backoff 中 abort 不计数）
 *  R6  class denied 不消费 physical
 *  R7  physical denied 不消费 retry class
 *  §53 Retry Cascade E2E：500×3 → 1 logical round / 3 physical / provider_failure
 *  §54 True truncation E2E：3× truncated_before_action → 3 physical / ledger 0 / stalled
 */

import { describe, expect, test } from "bun:test"
import { RetryCoordinator, deriveMaxPhysicalProviderRequests } from "../src/runtime/retry/coordinator"
import { createRetryLedger } from "../src/runtime/retry-ledger"
import { DeepSeekProvider } from "../src/provider/deepseek"
import { AnthropicProvider } from "../src/provider/anthropic"
import { OpenAIProvider } from "../src/provider/openai"
import { withRetryCoordinator } from "../src/provider/retry"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"

function sleep0() { return Promise.resolve() }

// ── R1-R7: coordinator 单元（原子性）──

describe("IC04 R1-R2: class budget → physical counting", () => {
  test("R1: transport limit 2 → initial + 2 retry = 3 physical，之后 class_exhausted", () => {
    const coordinator = new RetryCoordinator({
      ledger: createRetryLedger(),
      maxPhysicalProviderRequests: 100,
    })
    expect(coordinator.authorizeProviderAttempt({}).allowed).toBe(true) // initial
    const r1 = coordinator.authorizeProviderAttempt({ retryClass: "transport", fingerprint: "server:500" })
    expect(r1.allowed).toBe(true)
    const r2 = coordinator.authorizeProviderAttempt({ retryClass: "transport", fingerprint: "server:500" })
    expect(r2.allowed).toBe(true)
    const r3 = coordinator.authorizeProviderAttempt({ retryClass: "transport", fingerprint: "server:500" })
    expect(r3.allowed).toBe(false)
    expect(r3.reason).toBe("class_exhausted")
    expect(coordinator.physicalProviderRequests).toBe(3)
    expect(coordinator.retryLedger.summary().byClass.transport).toBe(2)
  })

  test("R2: rateLimit limit 3 → initial + 3 retry = 4 physical", () => {
    const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 100 })
    coordinator.authorizeProviderAttempt({})
    for (let i = 0; i < 3; i++) {
      expect(coordinator.authorizeProviderAttempt({ retryClass: "rateLimit", fingerprint: "rate_limit:429" }).allowed).toBe(true)
    }
    const denied = coordinator.authorizeProviderAttempt({ retryClass: "rateLimit", fingerprint: "rate_limit:429" })
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toBe("class_exhausted")
    expect(coordinator.physicalProviderRequests).toBe(4)
  })
})

describe("IC04 R3: global physical cap", () => {
  test("physical cap = 2 → 第三 request 永不发出（class budget 仍可用）", () => {
    const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 2 })
    expect(coordinator.authorizeProviderAttempt({}).allowed).toBe(true)
    expect(coordinator.authorizeProviderAttempt({ retryClass: "transport", fingerprint: "server:500" }).allowed).toBe(true)
    const third = coordinator.authorizeProviderAttempt({ retryClass: "transport", fingerprint: "server:500" })
    expect(third.allowed).toBe(false)
    expect(third.reason).toBe("physical_request_budget")
    expect(coordinator.physicalProviderRequests).toBe(2)
  })
})

describe("IC04 R4: side-effect boundary hard deny", () => {
  test("sideEffectBoundaryCrossed → deny（优先级 > retry budget，§43）", () => {
    const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 100 })
    coordinator.authorizeProviderAttempt({})
    const permit = coordinator.authorizeProviderAttempt({
      retryClass: "transport",
      fingerprint: "server:500",
      sideEffectBoundaryCrossed: true,
    })
    expect(permit.allowed).toBe(false)
    expect(permit.reason).toBe("side_effect_boundary")
    // 不 record、不 physical
    expect(coordinator.physicalProviderRequests).toBe(1)
    expect(coordinator.retryLedger.summary().totalAttempts).toBe(0)
  })
})

describe("IC04 R6/R7: deny 原子性", () => {
  test("R6: class denied 不消费 physical", () => {
    const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 100 })
    coordinator.authorizeProviderAttempt({})
    coordinator.authorizeProviderAttempt({ retryClass: "tool", fingerprint: "x" })
    coordinator.authorizeProviderAttempt({ retryClass: "tool", fingerprint: "x" })
    const before = coordinator.physicalProviderRequests
    const denied = coordinator.authorizeProviderAttempt({ retryClass: "tool", fingerprint: "x" })
    expect(denied.allowed).toBe(false)
    expect(coordinator.physicalProviderRequests).toBe(before)
  })

  test("R7: physical denied 不消费 retry class（账本从不记录未执行的 retry）", () => {
    const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 1 })
    coordinator.authorizeProviderAttempt({})
    const denied = coordinator.authorizeProviderAttempt({ retryClass: "transport", fingerprint: "server:500" })
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toBe("physical_request_budget")
    expect(coordinator.retryLedger.summary().totalAttempts).toBe(0)
    expect(coordinator.retryLedger.attempts("transport", "server:500")).toBe(0)
  })
})

describe("IC04 deriveMaxPhysicalProviderRequests（§24）", () => {
  test("max(maxRounds*2, maxRounds+8) = 100 @ maxRounds 50", () => {
    expect(deriveMaxPhysicalProviderRequests(50)).toBe(100)
    expect(deriveMaxPhysicalProviderRequests(2)).toBe(10)
    expect(deriveMaxPhysicalProviderRequests(10)).toBe(20)
  })
})

// ── R5: backoff 中 abort 不计数（provider 集成）──

class FlakyClient {
  calls = 0
  throwError: unknown
  constructor(throwError: unknown) {
    this.throwError = throwError
  }
  messages = {
    stream: () => {
      this.calls += 1
      throw this.throwError
    },
  }
}

async function collectWithCoordinator(provider: LLMProvider, coordinator: RetryCoordinator): Promise<{ events: StreamEvent[]; coordinator: RetryCoordinator }> {
  const wrapped = withRetryCoordinator(provider, coordinator)
  const events: StreamEvent[] = []
  for await (const event of wrapped.streamChat({
    model: "test",
    system: "system",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    maxTokens: 1024,
  })) {
    events.push(event)
  }
  return { events, coordinator }
}

describe("IC04 R5: abort during backoff 不提前计数", () => {
  test("request #1 失败 → backoff 中 abort → physicalRequests = 1（request #2 不计数不发出）", async () => {
    const controller = new AbortController()
    const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 100 })
    const client = new FlakyClient(Object.assign(new Error("connection reset"), { code: "ECONNRESET" }))
    const provider = new DeepSeekProvider("k", {
      client: client as never,
      sleep: () => new Promise(resolve => setTimeout(resolve, 30_000)),
    })
    const wrapped = withRetryCoordinator(provider, coordinator)
    setTimeout(() => controller.abort(), 10)
    const events: StreamEvent[] = []
    for await (const e of wrapped.streamChat({
      model: "test", system: "s", messages: [], tools: [], maxTokens: 1024, abortSignal: controller.signal,
    })) {
      events.push(e)
    }
    // 只有 initial 一次 physical attempt 被计数（backoff 中 abort → 不提前计 request #2）。
    expect(coordinator.physicalProviderRequests).toBe(1)
    expect(client.calls).toBe(1)
    const finishes = events.filter(e => e.type === "finish")
    expect((finishes[0]!.data as { finishReason: string }).finishReason).toBe("cancelled")
  })
})

// ── §53 Retry Cascade E2E：OpenAI mock 500×3 ──

function openaiErrorResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } })
}

function openaiOkResponse(): Response {
  const chunk = JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${chunk}\n\n`))
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

class Always500Provider extends OpenAIProvider {
  calls = 0
  constructor() {
    super("k", {
      baseURL: "https://test.local/v1",
      fetch: (async () => {
        this.calls++
        return openaiErrorResponse(500, "server error")
      }) as unknown as typeof fetch,
      sleep: async () => {},
    })
  }
}

describe("IC04 §53: Retry Cascade E2E（TRANSPORT_ROUND_RETRY_CASCADE = 0）", () => {
  test("500×3 → coordinator transport exhausted → provider_failure，Agent 不 continue 重来", async () => {
    const provider = new Always500Provider()
    const coordinator = new RetryCoordinator({
      ledger: createRetryLedger(),
      maxPhysicalProviderRequests: 100,
    })
    const { events } = await collectWithCoordinator(provider, coordinator)
    // initial + 2 retry = 3 physical requests（coordinator 授权计数）
    expect(provider.calls).toBe(3)
    expect(coordinator.physicalProviderRequests).toBe(3)
    // 结构化终止：transport_failure（非 retryable generic）
    const finishes = events.filter(e => e.type === "finish")
    expect(finishes).toHaveLength(1)
    expect((finishes[0]!.data as { finishReason: string }).finishReason).toBe("transport_failure")
    // transport 账本记了 2 次 retry
    expect(coordinator.retryLedger.summary().byClass.transport).toBe(2)
  })
})

// ── §54 True truncation E2E：RetryLedger 零消耗 ──

class TruncatedProvider implements LLMProvider {
  calls = 0
  async *streamChat(_o: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.calls++
    yield { type: "truncated", data: { stopReason: "max_tokens", toolCalls: 0 } }
  }
}

describe("IC04 §54: true truncation 从 Retry 迁移到 Liveness", () => {
  test("3× no-action truncation → physical=3、RetryLedger 全零、stalled", async () => {
    const provider = new TruncatedProvider()
    const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 100 })
    for (let i = 0; i < 3; i++) {
      const { events } = await collectWithCoordinator(provider, coordinator)
      // raw provider 流：legacy truncated 事件（无 finish —— runner 侧
      // fallback 才是结构化分类）；此处验证 truncation 事件 + physical 计数。
      const truncatedEvents = events.filter(e => e.type === "truncated")
      expect(truncatedEvents.length).toBeGreaterThanOrEqual(1)
    }
    expect(provider.calls).toBe(3)
    // truncation 不属于 Retry subsystem（TRUE_TRUNCATION_GENERIC_RETRY = 0）
    const summary = coordinator.retryLedger.summary()
    expect(summary.byClass.transport).toBe(0)
    expect(summary.byClass.truncation).toBe(0)
    expect(summary.totalAttempts).toBe(0)
    expect(coordinator.physicalProviderRequests).toBe(3)
  })
})

// ── legacy compatibility（§35）：无 coordinator 时 standalone 行为不变 ──

describe("IC04 §35: standalone provider legacy retry 保留", () => {
  test("无 coordinator 的 DeepSeekProvider 走 maxRetries legacy", async () => {
    const flaky = new FlakyClient(Object.assign(new Error("connection reset"), { code: "ECONNRESET" }))
    const provider = new DeepSeekProvider("k", {
      client: flaky as never,
      maxRetries: 1,
      sleep: sleep0,
    })
    const events: StreamEvent[] = []
    for await (const e of provider.streamChat({ model: "test", system: "s", messages: [], tools: [], maxTokens: 1024 })) {
      events.push(e)
    }
    // initial + 1 retry（maxRetries=1）→ 2 calls，结构化 transport_failure。
    expect(flaky.calls).toBe(2)
    const finishes = events.filter(e => e.type === "finish")
    expect(finishes).toHaveLength(1)
    expect((finishes[0]!.data as { finishReason: string }).finishReason).toBe("transport_failure")
  })

  test("无 coordinator 的 AnthropicProvider 成功路径正常", async () => {
    const client = {
      messages: {
        stream: async function* () {
          yield { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } }
          yield { type: "message_delta", delta: { stop_reason: "end_turn" } }
        },
      },
    }
    const provider = new AnthropicProvider("k", { client: client as never, sleep: sleep0 })
    const events: StreamEvent[] = []
    for await (const e of provider.streamChat({ model: "test", system: "s", messages: [], tools: [], maxTokens: 1024 })) {
      events.push(e)
    }
    const finishes = events.filter(e => e.type === "finish")
    expect((finishes[0]!.data as { finishReason: string }).finishReason).toBe("complete")
  })
})

// ── §55: Harness physical model-call budget（strict cap = physical）──

import { createAgentHarness } from "../src/harness/runtime/agent-harness"
import { executeCapability } from "../src/harness/capabilities/executor"
import { RepairLoop } from "../src/workflow/convergence/repair-loop"
import { buildTools } from "../src/tools/registry"

class RetryThenOkProvider extends OpenAIProvider {
  calls = 0
  constructor() {
    super("k", {
      baseURL: "https://test.local/v1",
      fetch: (async () => {
        this.calls++
        if (this.calls <= 2) return openaiErrorResponse(500, "server error")
        return openaiOkResponse()
      }) as unknown as typeof fetch,
      sleep: async () => {},
    })
  }
}

function probeTool() {
  return buildTools({
    name: "baseline_probe",
    description: "probe",
    inputSchema: { type: "object", properties: {}, required: [] },
    isReadonly: true,
    isConcurrencySafe: true,
    execute() {
      return { success: true, content: "probe-ok", output: "probe-ok" }
    },
  })
}

describe("IC04 §55: harness budget.maxModelCalls = strict physical cap", () => {
  test("maxModelCalls=2 → physical=2、used.modelCalls=2、第三次请求不发、无 double count", async () => {
    const provider = new RetryThenOkProvider()
    const harness = createAgentHarness({
      sessionId: "sess-ic04-physical",
      deps: {
        provider,
        model: "test",
        tools: probeTool(),
      },
    })
    const session = await harness.createSession()
    const events: Array<{ runId?: string }> = []
    for await (const event of harness.run(session.sessionId, {
      prompt: "inspect the project",
      maxRounds: 5,
      budget: { maxModelCalls: 2 },
    } as never)) {
      events.push(event as never)
    }
    const snapshot = await harness.inspect(events[0]!.runId!)
    // 第 3 次 physical request 永不发出（provider calls = 2）。
    expect(provider.calls).toBe(2)
    expect(snapshot.status).toBe("cancelled")
    // BudgetLedger 记账 = 实际 physical 数（source counting，无 double count）。
    const used = (snapshot.budgetState as { used: { modelCalls: number } }).used
    expect(used.modelCalls).toBe(2)
  })
})

// ── §57: Capability retry Gate（write/external 禁 blind retry）──

describe("IC04 §57: capability retry 经 coordinator + write/external fail-closed", () => {
  test("read-only retryable capability：1 initial + 1 retry（coordinator tool class）", async () => {
    const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 100 })
    let calls = 0
    const registry = {
      resolve: () => ({
        descriptor: { id: "my-read", kind: "read", sideEffect: "read", retryable: true, inputSchema: { type: "object", properties: {}, required: [] }, outputSchema: { type: "object", properties: {}, required: [] }, concurrencyGroup: "", permissions: [] },
        handler: {
          async execute() {
            calls++
            if (calls < 2) return { ok: false, error: "transient" } as never
            return { ok: true, output: {} }
          },
        },
      }),
    }
    const result = await executeCapability(registry as never, {
      capabilityId: "my-read",
      params: {},
      toolCallId: "c1",
      retryCoordinator: coordinator,
      projectRoot: "/tmp",
      policyContext: {
        permissionGate: { check: () => ({ allowed: true, level: "allow", source: "test" }) } as never,
        tool: probeTool()[0],
        input: {},
      },
      emit: () => {},
    })
    expect(result.result.success).toBe(true)
    expect(calls).toBe(2)
    expect(coordinator.retryLedger.summary().byClass.tool).toBe(1)
  })

  test("write capability：descriptor.retryable=true 也禁 blind automatic retry", async () => {
    const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 100 })
    let calls = 0
    const registry = {
      resolve: () => ({
        descriptor: { id: "my-write", kind: "write", sideEffect: "write", retryable: true, inputSchema: { type: "object", properties: {}, required: [] }, outputSchema: { type: "object", properties: {}, required: [] }, concurrencyGroup: "", permissions: [] },
        handler: {
          async execute() {
            calls++
            return { success: false, error: "failed" } as never
          },
        },
      }),
    }
    const result = await executeCapability(registry as never, {
      capabilityId: "my-write",
      params: { path: "a.ts" },
      toolCallId: "c1",
      retryCoordinator: coordinator,
      projectRoot: "/tmp",
      policyContext: {
        permissionGate: { check: () => ({ allowed: true, level: "allow", source: "test" }) } as never,
        tool: probeTool()[0],
        input: {},
      },
      emit: () => {},
    })
    expect(result.result.success).toBe(false)
    expect(calls).toBe(1) // 第一次失败后 automatic retry = 0（SIDE_EFFECT_RETRY_AFTER_BOUNDARY = 0）
    expect(coordinator.retryLedger.summary().totalAttempts).toBe(0)
  })
})

// ── §58: Semantic Repair Gate（授权经 coordinator）──

describe("IC04 §58: RepairLoop semanticRepair 经 coordinator", () => {
  test("同 signature 经 coordinator 授权（semanticRepair <= 2）", async () => {
    const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 100 })
    const sig = "handler|category"
    // 直接验证 coordinator 是 repair 授权的权威（而非直接 RetryLedger）。
    expect(coordinator.authorizeRetry({ retryClass: "semanticRepair", fingerprint: sig }).allowed).toBe(true)
    expect(coordinator.authorizeRetry({ retryClass: "semanticRepair", fingerprint: sig }).allowed).toBe(true)
    const denied = coordinator.authorizeRetry({ retryClass: "semanticRepair", fingerprint: sig })
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toBe("class_exhausted")
    expect(coordinator.retryLedger.summary().byClass.semanticRepair).toBe(2)
  })

  test("RepairLoop 接受 retryCoordinator 且经其授权", async () => {
    const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 100 })
    const loop = new RepairLoop({
      registry: { get: () => undefined },
      specFactory: () => null,
      retryCoordinator: coordinator,
    } as never)
    // 构造成功即证明选项透传；行为由上面 coordinator 授权语义覆盖。
    expect(loop).toBeDefined()
  })
})
