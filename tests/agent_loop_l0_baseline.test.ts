import { afterAll, describe, expect, spyOn, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { agentLoop } from "../src/agent/loop"
import type { AgentRunTrace } from "../src/agent/run-trace"
import { getActiveMode, setActiveMode } from "../src/agent/mode-contract"
import { getActivePatchContext, clearActivePatchContext } from "../src/agent/patch-transaction"
import { getRuntimeContextBudgetMode, setRuntimeContextBudgetMode } from "../src/agent/runtime-context"
import { setCascadeFiles } from "../src/ripple/engine"
import type { LLMProvider, ProviderCallOptions, ProviderMessage, StreamEvent } from "../src/provider/types"
import { SandboxManager } from "../src/sandbox/sandbox"
import { HookEvent, HookSystem } from "../src/hooks"
import { buildTools, Result } from "../src/tools/registry"
import { getShellSandbox, setShellSandbox } from "../src/tools/shell"

const SAVED_ORCANA_FLASH_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
process.env.ORCANA_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_ORCANA_FLASH_TRIAGE === undefined) delete process.env.ORCANA_FLASH_TRIAGE
  else process.env.ORCANA_FLASH_TRIAGE = SAVED_ORCANA_FLASH_TRIAGE
})

interface GoldenFixture {
  criticalEvents: string[]
  providerToolChain: string[]
  hookAndExecutionOrder: string[]
  traceSequence: string[]
}

class MemoryTrace {
  events: Array<{ type: string; data?: unknown }> = []

  record(type: string, data?: unknown) {
    this.events.push({ type, data })
  }
}

class GoldenProvider implements LLMProvider {
  private round = 0
  readonly requests: ProviderCallOptions[] = []

  constructor(private readonly timeline: string[]) {}

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    const round = this.round++
    this.timeline.push(`provider:round-${round}`)
    this.requests.push(options)
    if (round === 0) {
      yield {
        type: "tool_call",
        data: { id: "golden-read", name: "baseline_probe", input: { target: "loop" } },
      }
      return
    }
    yield { type: "text", data: "Golden final response." }
  }
}

class ClarificationProvider implements LLMProvider {
  calls = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.calls += 1
    yield {
      type: "text",
      data: [
        "[clarification-gate]",
        JSON.stringify({
          questions: [{
            id: "scope",
            title: "选择交付范围",
            options: [
              { key: "A", label: "最小可用版本", recommended: true },
              { key: "B", label: "完整产品版本" },
            ],
          }],
        }),
      ].join("\n"),
    }
  }
}

class TextProvider implements LLMProvider {
  calls = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.calls += 1
    yield { type: "text", data: "Read-only response." }
  }
}

class AbortAwareProvider implements LLMProvider {
  aborted = false

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    options.abortSignal?.addEventListener("abort", () => {
      this.aborted = true
    }, { once: true })
    yield { type: "status", data: "provider-ready" }
    await new Promise<void>(() => {})
  }
}

class PlanProvider implements LLMProvider {
  calls = 0

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.calls += 1
    if (options.purpose === "flash_triage") {
      yield {
        type: "text",
        data: JSON.stringify({
          mode: "plan_before_code",
          needsWeb: false,
          researchQueries: [],
          relevantSkillNames: [],
          planSteps: [
            {
              id: "foundation",
              title: "Create project foundation",
              deliverables: ["package.json", "tsconfig.json"],
              verification: "typecheck",
            },
            {
              id: "backend",
              title: "Create API and tests",
              deliverables: ["server/index.ts", "server/index.test.ts", "server/posts.json"],
              verification: "test",
            },
            {
              id: "frontend",
              title: "Create responsive client",
              deliverables: ["client/src/App.tsx", "client/src/App.css"],
              verification: "build",
            },
          ],
          requiredVerification: ["typecheck", "test", "build"],
          reasoning: "multi-surface implementation requires an approved plan",
          riskLevel: "medium",
        }),
      }
      return
    }
    yield {
      type: "text",
      data: [
        "Problem model: build a complete full-stack personal blog, not a bare demo. Scope includes package setup, TypeScript config, Bun API, blog content data, React/Vite UI, integration, tests, and build verification. Out of scope: auth, database migrations, comments, and deployment unless requested.",
        "Assumptions and uncertainty: the repo may be empty, so I will create a minimal but coherent structure. If existing files appear later, I will adapt instead of overwriting blindly. The visual direction should be readable and polished without adding unnecessary dependencies.",
        "Risk and counter-argument: the fastest path is a default list page, but that would fail the frontend quality floor. Another risk is API tests that require a running server; tests should start and stop the service or use finite smoke checks.",
        "Selected approach: Option A is React/Vite plus a Bun TypeScript API with JSON content. Option B is SQLite persistence plus an admin system. I choose Option A because it keeps the first deliverable small, testable, and easy to inspect. I am not choosing SQLite or an admin system because they add scope before the first validation loop.",
        "Execution checklist:",
        "- Create package.json and tsconfig.json with scripts for typecheck, test, and build.",
        "- Create server/index.ts, server/index.test.ts, and server/posts.json with API success and error paths.",
        "- Create client/src/App.tsx and client/src/App.css with responsive layout, visual hierarchy, and media-bearing blog surfaces.",
        "- Wire the frontend to the API data shape and keep fallback content deterministic.",
        "- Run external verification: bun run typecheck, bun test, and bunx vite build or an equivalent finite build/smoke command.",
      ].join("\n"),
    }
  }
}

function normalizeCriticalEvents(events: StreamEvent[]): string[] {
  const normalized: string[] = []
  for (const event of events) {
    if (event.type === "tool_call") {
      const data = event.data as { id?: string; name?: string }
      normalized.push(`tool_call:${data.name}:${data.id}`)
      continue
    }
    if (event.type === "tool_result") {
      const data = event.data as { name?: string; success?: boolean }
      normalized.push(`tool_result:${data.name}:${String(data.success)}`)
      continue
    }
    if (event.type === "text") {
      normalized.push(`text:${String(event.data ?? "")}`)
      continue
    }
    if (event.type !== "status") continue
    const status = String(event.data ?? "")
    if (status.startsWith("context-kernel:")) normalized.push("status:context-kernel")
    else if (status.startsWith("intent-gate:")) normalized.push("status:intent-gate")
    else if (status === "working") normalized.push("status:working")
    else if (status.startsWith("tool-ledger:")) normalized.push("status:tool-ledger")
    else if (status.startsWith("gate-telemetry:")) normalized.push("status:gate-telemetry")
  }
  return normalized
}

function providerToolChain(messages: ProviderMessage[]): string[] {
  const chain: string[] = []
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      const record = block as Record<string, unknown>
      if (record.type === "tool_use") {
        chain.push(`${message.role}:tool_use:${String(record.id)}`)
      } else if (record.type === "tool_result") {
        chain.push(`${message.role}:tool_result:${String(record.tool_use_id)}`)
      }
    }
  }
  return chain
}

function normalizeTrace(trace: MemoryTrace): string[] {
  const normalized: string[] = []
  for (const event of trace.events) {
    const data = event.data as Record<string, unknown> | undefined
    if (event.type === "round_started") {
      normalized.push(`round_started:${String(data?.round)}`)
    } else if (event.type === "tool_call") {
      normalized.push(`tool_call:${String(data?.tool)}`)
    } else if (event.type === "tool_result") {
      normalized.push(`tool_result:${String(data?.tool)}:${data?.success ? "success" : "failed"}`)
    } else if (event.type === "agent_loop_finished") {
      normalized.push("agent_loop_finished")
    }
  }
  return normalized
}

async function collect(iterable: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

function assertFallbackRuntimeIsClean() {
  expect(getActiveMode().mode).toBe("coder")
  expect(getRuntimeContextBudgetMode()).toBe("normal")
  expect(getActivePatchContext()).toBeNull()
  expect(getShellSandbox()).toBeNull()
}

function resetFallbackRuntime() {
  setActiveMode("coder")
  setRuntimeContextBudgetMode("normal")
  clearActivePatchContext()
  setShellSandbox(null)
  setCascadeFiles(new Set())
}

describe("Agent loop L0 behavior baseline", () => {
  test("matches the golden event, provider transcript, gate/tool, and hook order", async () => {
    resetFallbackRuntime()
    const fixture = JSON.parse(readFileSync(
      join(import.meta.dirname, "fixtures", "agent-loop-l0-golden.json"),
      "utf8",
    )) as GoldenFixture
    const timeline: string[] = []
    const trace = new MemoryTrace()
    const hooks = new HookSystem()
    hooks.on(HookEvent.UserPromptSubmit, () => {
      timeline.push("hook:prompt")
      return {}
    })
    hooks.on(HookEvent.PreToolUse, input => {
      timeline.push(`hook:pre:${input.tool}`)
      return {}
    })
    hooks.on(HookEvent.PostToolUse, input => {
      timeline.push(`hook:post:${input.tool}`)
      return {}
    })
    hooks.on(HookEvent.Stop, input => {
      timeline.push(`hook:stop:${input.reason}`)
      return {}
    })
    const provider = new GoldenProvider(timeline)
    const tools = buildTools({
      name: "baseline_probe",
      description: "Return a deterministic read-only baseline result",
      isReadonly: true,
      isConcurrencySafe: true,
      inputSchema: {
        type: "object",
        properties: { target: { type: "string" } },
        required: ["target"],
      },
      execute() {
        timeline.push("tool:baseline_probe")
        return Result.ok("baseline-ok")
      },
    })

    const events = await collect(agentLoop(
      "Read only: inspect the loop baseline and summarize it. Do not edit or write files.",
      {
        provider,
        model: "test",
        tools,
        hooks,
        runTrace: trace as unknown as AgentRunTrace,
        contextMapPolicy: "off",
        maxRounds: 2,
      },
    ))

    expect(normalizeCriticalEvents(events)).toEqual(fixture.criticalEvents)
    expect(provider.requests).toHaveLength(2)
    expect(providerToolChain(provider.requests[1]!.messages)).toEqual(fixture.providerToolChain)
    expect(timeline).toEqual(fixture.hookAndExecutionOrder)
    expect(normalizeTrace(trace)).toEqual(fixture.traceSequence)
    expect(events.filter(event =>
      event.type === "text" && event.data === "Golden final response."
    )).toHaveLength(1)
    assertFallbackRuntimeIsClean()
  })

  test("clarification exits once and disposes sandbox and run-scoped state", async () => {
    resetFallbackRuntime()
    const dispose = spyOn(SandboxManager.prototype, "dispose")
    const stopReasons: string[] = []
    const hooks = new HookSystem()
    hooks.on(HookEvent.Stop, input => {
      stopReasons.push(input.reason)
      return {}
    })
    try {
      const provider = new ClarificationProvider()
      const events = await collect(agentLoop("做一个全栈项目", {
        provider,
        model: "test",
        tools: [],
        hooks,
        contextMapPolicy: "off",
        maxRounds: 2,
      }))

      expect(provider.calls).toBe(1)
      expect(events.filter(event => event.type === "clarification_ready")).toHaveLength(1)
      // TB2-1: clarification 是等待用户输入的暂停态（paused），不是 aborted。
      expect(stopReasons).toEqual(["paused"])
      expect(dispose).toHaveBeenCalledTimes(1)
      assertFallbackRuntimeIsClean()
    } finally {
      dispose.mockRestore()
    }
  })

  test("dispatches completed, blocked, error, and aborted Stop reasons exactly once", async () => {
    resetFallbackRuntime()

    const completed: string[] = []
    const completedHooks = new HookSystem()
    completedHooks.on(HookEvent.Stop, input => {
      completed.push(input.reason)
      return {}
    })
    await collect(agentLoop("Read only: summarize the current design; do not edit.", {
      provider: new TextProvider(),
      model: "test",
      tools: [],
      hooks: completedHooks,
      contextMapPolicy: "off",
      maxRounds: 1,
    }))
    expect(completed).toEqual(["completed"])

    const blocked: string[] = []
    const blockedHooks = new HookSystem()
    blockedHooks.on(HookEvent.UserPromptSubmit, () => ({
      blocked: true,
      warn: "blocked by baseline test",
      source: "l0-test",
    }))
    blockedHooks.on(HookEvent.Stop, input => {
      blocked.push(input.reason)
      return {}
    })
    await collect(agentLoop("inspect", {
      provider: new TextProvider(),
      model: "test",
      tools: [],
      hooks: blockedHooks,
      contextMapPolicy: "off",
      maxRounds: 1,
    }))
    expect(blocked).toEqual(["blocked"])

    const failed: string[] = []
    const failedHooks = new HookSystem()
    failedHooks.on(HookEvent.Stop, input => {
      failed.push(input.reason)
      return {}
    })
    const throwingTrace = {
      record(type: string) {
        if (type === "round_started") throw new Error("l0 trace failure")
      },
    }
    let thrown: unknown
    try {
      await collect(agentLoop("Read only: inspect without edits.", {
        provider: new TextProvider(),
        model: "test",
        tools: [],
        hooks: failedHooks,
        runTrace: throwingTrace as unknown as AgentRunTrace,
        contextMapPolicy: "off",
        maxRounds: 1,
      }))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe("l0 trace failure")
    expect(failed).toEqual(["error"])

    const aborted: string[] = []
    const abortedHooks = new HookSystem()
    abortedHooks.on(HookEvent.Stop, input => {
      aborted.push(input.reason)
      return {}
    })
    const abortProvider = new AbortAwareProvider()
    const iterator = agentLoop("Read only: inspect without edits.", {
      provider: abortProvider,
      model: "test",
      tools: [],
      hooks: abortedHooks,
      contextMapPolicy: "off",
      maxRounds: 1,
    })
    while (true) {
      const next = await iterator.next()
      if (next.done || (next.value.type === "status" && next.value.data === "provider-ready")) break
    }
    await iterator.return(undefined as never)
    expect(abortProvider.aborted).toBe(true)
    expect(aborted).toEqual(["aborted"])
    assertFallbackRuntimeIsClean()
  })

  test("context budget block performs cleanup without calling the provider", async () => {
    resetFallbackRuntime()
    const oldWarn = process.env.ORCANA_CONTEXT_WARN_RATIO
    const oldBlock = process.env.ORCANA_CONTEXT_BLOCK_RATIO
    process.env.ORCANA_CONTEXT_WARN_RATIO = "0.000001"
    process.env.ORCANA_CONTEXT_BLOCK_RATIO = "0.000002"
    const dispose = spyOn(SandboxManager.prototype, "dispose")
    const stopReasons: string[] = []
    const hooks = new HookSystem()
    hooks.on(HookEvent.Stop, input => {
      stopReasons.push(input.reason)
      return {}
    })
    try {
      const provider = new TextProvider()
      const events = await collect(agentLoop("continue", {
        provider,
        model: "test",
        tools: [],
        hooks,
        contextMapPolicy: "off",
        conversationHistory: [{ role: "user", content: "x".repeat(4000) }],
        maxRounds: 2,
      }))

      expect(provider.calls).toBe(0)
      expect(events.some(event =>
        event.type === "status" && String(event.data).startsWith("context-budget: block")
      )).toBe(true)
      expect(stopReasons).toHaveLength(1)
      expect(dispose).toHaveBeenCalledTimes(1)
      assertFallbackRuntimeIsClean()
    } finally {
      if (oldWarn === undefined) delete process.env.ORCANA_CONTEXT_WARN_RATIO
      else process.env.ORCANA_CONTEXT_WARN_RATIO = oldWarn
      if (oldBlock === undefined) delete process.env.ORCANA_CONTEXT_BLOCK_RATIO
      else process.env.ORCANA_CONTEXT_BLOCK_RATIO = oldBlock
      dispose.mockRestore()
    }
  })

  test("emits one plan_ready event and one Stop hook after plan approval pause", async () => {
    resetFallbackRuntime()
    const stopReasons: string[] = []
    const hooks = new HookSystem()
    hooks.on(HookEvent.Stop, input => {
      stopReasons.push(input.reason)
      return {}
    })
    const events = await collect(agentLoop(
      "Build a complete full-stack personal blog with React/Vite, a Bun API, tests, responsive design, and build verification while preserving existing files.",
      {
        provider: new PlanProvider(),
        model: "test",
        tools: [],
        hooks,
        flashTriagePolicy: "always",
        contextMapPolicy: "off",
        maxRounds: 2,
      },
    ))

    const planReadyEvents = events.filter(event => event.type === "plan_ready")
    expect(planReadyEvents).toHaveLength(1)
    expect(stopReasons).toHaveLength(1)
    assertFallbackRuntimeIsClean()
  })
})
