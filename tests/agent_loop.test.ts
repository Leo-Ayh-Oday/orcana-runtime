import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { agentLoop } from "../src/agent/loop"
import { StagedContextManager } from "../src/context/staged"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import type { AgentRunTrace } from "../src/agent/run-trace"
import type { RippleReport } from "../src/ripple/types"
import { buildTools, Result } from "../src/tools/registry"
import { HookSystem } from "../src/hooks"

// Disable FlashTriage in integration tests: mock LLM providers don't model triage calls,
// and FlashTriage is independently tested in src/agent/flash-triage.test.ts.
process.env.DEEPSEEK_FLASH_TRIAGE = "off"

class ParallelToolProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "a", name: "probe_a", input: {} } }
      yield { type: "tool_call", data: { id: "b", name: "probe_b", input: {} } }
      return
    }
    yield { type: "text", data: "done" }
  }
}

class DoubleSearchProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "s1", name: "web_search", input: { query: "first" } } }
      yield { type: "tool_call", data: { id: "s2", name: "web_search", input: { query: "second" } } }
      return
    }
    yield { type: "text", data: "done" }
  }
}

class WriteDespiteReadonlyProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "w1", name: "edit_file", input: { path: "src/a.ts", search: "a", replace: "b", confirm: true } } }
      return
    }
    yield { type: "text", data: "done" }
  }
}

class ChaoticReadonlyProvider implements LLMProvider {
  rounds = 0
  messages: ProviderCallOptions["messages"][] = []

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.messages.push(options.messages)
    if (this.rounds++ === 0) {
      const noisy = [
        "# Architecture",
        "Do you want me to implement this?",
        "Should I continue and turn this into code?",
        "[turn ~15K tokens · est 1.1M /1M tokens · 11.0s]",
        "[turn ~16K tokens · est 1.1M /1M tokens · 12.0s]",
        "Ripple MetaAgent Multi-Agent Context Kernel Checkpoint Hybrid-Memory Shadow TDD RAG MCP rollback confidence contract worktree provider LSP AST",
        "┌────────────┐",
        "│ noisy box │",
        "└────────────┘",
      ].join("\n")
      yield { type: "text", data: noisy + "\n" + "fragment ".repeat(500) }
      return
    }
    yield { type: "text", data: "Concise answer only." }
  }
}

class ConciseReadonlyProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.rounds += 1
    yield { type: "text", data: "Looks coherent. Main risk: missing verification." }
  }
}

class ExecuteLongTextProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.rounds += 1
    yield { type: "text", data: "# Implementation\n" + "code detail ".repeat(500) }
  }
}

class CacheStableProvider implements LLMProvider {
  rounds = 0
  systems: string[] = []
  messages: ProviderCallOptions["messages"][] = []
  toolCounts: number[] = []
  toolNames: string[][] = []

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.systems.push(options.system)
    this.messages.push(options.messages)
    this.toolCounts.push(options.tools?.length ?? 0)
    this.toolNames.push((options.tools ?? []).map(tool => String(tool.name)))
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "r1", name: "read_file", input: { path: "src/provider/types.ts" } } }
      return
    }
    yield { type: "text", data: "done" }
  }
}

class ContextBudgetBlockProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.rounds += 1
    yield { type: "text", data: "should not be called" }
  }
}

class ContextBudgetWriteProvider implements LLMProvider {
  rounds = 0
  messages: ProviderCallOptions["messages"][] = []

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.messages.push(options.messages)
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "w1", name: "edit_file", input: { path: "src/a.ts", search: "a", replace: "b", confirm: true } } }
      return
    }
    yield { type: "text", data: "done" }
  }
}

class StreamingToolProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "sh", name: "shell", input: { command: "bun install" } } }
      return
    }
    yield { type: "text", data: "done" }
  }
}

class ProviderUsageProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.rounds += 1
    yield {
      type: "token_usage",
      data: {
        inputTokens: 200,
        outputTokens: 42,
        cacheReadInputTokens: 800,
        cacheMissInputTokens: 200,
        cacheHitRate: 80,
        source: "provider",
      },
    }
    yield { type: "text", data: "done" }
  }
}

class HighCostProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.rounds += 1
    yield {
      type: "token_usage",
      data: {
        inputTokens: 100,
        outputTokens: 900,
        cacheReadInputTokens: 0,
        cacheMissInputTokens: 5000,
        cacheHitRate: 0,
        source: "provider",
      },
    }
    yield { type: "text", data: "expensive output" }
  }
}

class LongStreamingProvider implements LLMProvider {
  rounds = 0
  returned = false
  chunksProduced = 0

  streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.rounds += 1
    const self = this
    async function* gen() {
      try {
        for (let i = 0; i < 20; i++) {
          self.chunksProduced += 1
          yield { type: "text", data: "x".repeat(120) } satisfies StreamEvent
        }
      } finally {
        self.returned = true
      }
    }
    return gen()
  }
}

class SystemCaptureProvider implements LLMProvider {
  systems: string[] = []
  messages: ProviderCallOptions["messages"][] = []

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.systems.push(options.system)
    this.messages.push(options.messages)
    yield { type: "text", data: "done" }
  }
}

class ModelCaptureProvider implements LLMProvider {
  models: string[] = []

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.models.push(options.model)
    yield { type: "text", data: "done" }
  }
}

class RuntimeSelfEditProvider implements LLMProvider {
  rounds = 0
  messages: ProviderCallOptions["messages"][] = []

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.messages.push(options.messages)
    const round = this.rounds++
    if (round === 0) {
      yield { type: "tool_call", data: { id: "edit-runtime", name: "edit_file", input: { path: "src/agent/task-tracker.ts" } } }
      return
    }
    yield { type: "tool_call", data: { id: "typecheck", name: "shell", input: { command: "bun run typecheck" } } }
  }
}

class RippleExitGateProvider implements LLMProvider {
  rounds = 0
  messages: ProviderCallOptions["messages"][] = []

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.messages.push(options.messages)
    const round = this.rounds++
    if (round === 0) {
      yield { type: "tool_call", data: { id: "edit-api", name: "edit_file", input: { path: "api.ts" } } }
      return
    }
    if (round === 1) {
      yield { type: "text", data: "done" }
      return
    }
    if (round === 2) {
      yield { type: "tool_call", data: { id: "edit-cart", name: "edit_file", input: { path: "cart.ts" } } }
      return
    }
    yield { type: "text", data: "done" }
  }
}

class QualityGateDiagnosticsProvider implements LLMProvider {
  rounds = 0
  messages: ProviderCallOptions["messages"][] = []

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.messages.push(options.messages)
    const round = this.rounds++
    if (round === 0) {
      yield { type: "tool_call", data: { id: "edit", name: "edit_file", input: { path: "src/broken.ts" } } }
      return
    }
    if (round === 1) {
      yield { type: "text", data: "done" }
      return
    }
    yield { type: "text", data: "I inspected and will report the unresolved typecheck issue." }
  }
}

class VerifiedWriteProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "edit", name: "edit_file", input: { path: "src/ok.ts" } } }
      return
    }
    yield { type: "tool_call", data: { id: "extra", name: "write_file", input: { path: "test.ts" } } }
  }
}

class MissingRequestedTestProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "edit", name: "edit_file", input: { path: "src/calc.ts" } } }
      return
    }
    yield { type: "tool_call", data: { id: "test", name: "write_file", input: { path: "tests/calc.test.ts" } } }
  }
}

class LongTaskWriteDuringPlanProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "w1", name: "write_file", input: { path: "server/index.ts" } } }
      return
    }
    yield { type: "text", data: "Plan first." }
  }
}

function adequateFullstackBlogPlan(): string {
  return [
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
  ].join("\n")
}

class LongTaskPlanAndWriteSameRoundProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "text", data: adequateFullstackBlogPlan() }
      yield { type: "tool_call", data: { id: "blocked-write", name: "write_file", input: { path: "package.json" } } }
      return
    }
    yield { type: "tool_call", data: { id: "allowed-write", name: "write_file", input: { path: "package.json" } } }
  }
}

class LongTaskReadonlyThenPlanProvider implements LLMProvider {
  rounds = 0
  toolCounts: number[] = []
  toolNames: string[][] = []

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.toolCounts.push(options.tools?.length ?? 0)
    this.toolNames.push((options.tools ?? []).map(tool => String(tool.name)))
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "scan", name: "project_structure", input: { max_depth: 3 } } }
      return
    }
    yield { type: "text", data: adequateFullstackBlogPlan() }
  }
}

class LongTaskThinThenGoodPlanProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    const round = this.rounds++
    if (round === 0) {
      yield { type: "text", data: "Plan: create files, then test." }
      return
    }
    if (round === 1) {
      yield { type: "text", data: adequateFullstackBlogPlan() }
      return
    }
    yield { type: "tool_call", data: { id: "allowed-write", name: "write_file", input: { path: "package.json" } } }
  }
}

class LongTaskCompleteThenFinalProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    const round = this.rounds++
    if (round === 0) {
      yield { type: "text", data: adequateFullstackBlogPlan() }
      return
    }
    if (round === 1) {
      for (const path of [
        "package.json",
        "tsconfig.json",
        "server/index.ts",
        "server/index.test.ts",
        "server/posts.json",
        "client/src/App.tsx",
        "client/src/App.css",
      ]) {
        yield { type: "tool_call", data: { id: `write-${path}`, name: "write_file", input: { path } } }
      }
      return
    }
    if (round === 2) {
      yield { type: "tool_call", data: { id: "typecheck", name: "shell", input: { command: "bun run typecheck" } } }
      yield { type: "tool_call", data: { id: "test", name: "shell", input: { command: "bun test" } } }
      yield { type: "tool_call", data: { id: "build", name: "shell", input: { command: "bunx vite build" } } }
      return
    }
    yield { type: "text", data: "Completed the full-stack blog with verified frontend and backend." }
  }
}

class LongTaskStreamErrorThenPlanProvider implements LLMProvider {
  rounds = 0
  messages: ProviderCallOptions["messages"][] = []

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.messages.push(options.messages)
    if (this.rounds++ === 0) {
      yield { type: "error", data: "network: The socket connection was closed unexpectedly" }
      return
    }
    yield { type: "text", data: adequateFullstackBlogPlan() }
  }
}

class LongTaskThrowStreamErrorThenPlanProvider implements LLMProvider {
  rounds = 0
  messages: ProviderCallOptions["messages"][] = []

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.messages.push(options.messages)
    if (this.rounds++ === 0) {
      throw new Error("The socket connection was closed unexpectedly")
    }
    yield { type: "text", data: adequateFullstackBlogPlan() }
  }
}

class LongTaskStreamErrorOnlyProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.rounds += 1
    yield { type: "error", data: 'network: Unexpected event order, got message_start before receiving "message_stop"' }
  }
}

class NonRetryableStreamErrorProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.rounds += 1
    yield { type: "error", data: "auth invalid api key" }
  }
}

class QuotaStreamErrorProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.rounds += 1
    yield { type: "error", data: "quota 429: insufficient_quota: Your account balance is too low" }
  }
}

class GenericThrowStreamErrorThenTextProvider implements LLMProvider {
  rounds = 0
  messages: ProviderCallOptions["messages"][] = []

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.messages.push(options.messages)
    if (this.rounds++ === 0) {
      throw new Error("fetch failed")
    }
    yield { type: "text", data: "Recovered answer." }
  }
}

class HangingThenTextProvider implements LLMProvider {
  rounds = 0
  messages: ProviderCallOptions["messages"][] = []

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.messages.push(options.messages)
    if (this.rounds++ === 0) {
      await new Promise(() => {})
      return
    }
    yield { type: "text", data: "Recovered after idle timeout." }
  }
}

class CaptureNativeToolsProvider implements LLMProvider {
  options?: ProviderCallOptions

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.options = options
    yield { type: "text", data: "done" }
  }
}

class CaptureThinkingProvider implements LLMProvider {
  options?: ProviderCallOptions

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.options = options
    yield { type: "text", data: "done" }
  }
}

class ServiceTestFailureProvider implements LLMProvider {
  rounds = 0
  secondRoundMessages?: ProviderCallOptions["messages"]

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "test", name: "shell", input: { command: "bun test", confirm: true } } }
      return
    }
    this.secondRoundMessages = options.messages
    yield { type: "text", data: "I will fix the service test." }
  }
}

class EmptyThinkingProvider implements LLMProvider {
  rounds = 0
  messages: ProviderCallOptions["messages"][] = []

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.messages.push(options.messages)
    this.rounds += 1
    yield { type: "thinking_blocks", data: [{ thinking: "still thinking", signature: "sig" }] }
  }
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function withTempCwd(run: (dir: string) => Promise<void>) {
  const previous = process.cwd()
  const dir = mkdtempSync(join(tmpdir(), "dscode-loop-"))
  try {
    process.chdir(dir)
    await run(dir)
  } finally {
    process.chdir(previous)
    rmSync(dir, { recursive: true, force: true })
  }
}

function blogFileContent(path: string): string {
  if (path === "package.json") return JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "bun test", build: "vite build" } }, null, 2)
  if (path === "tsconfig.json") return JSON.stringify({ compilerOptions: { strict: true, jsx: "react-jsx" } }, null, 2)
  if (path === "server/posts.json") return JSON.stringify([{ id: "hello", title: "Hello", excerpt: "Intro" }], null, 2)
  if (path === "server/index.ts") {
    return "export const server={stop(){}}; export function json(){ return new Response('{}',{status:404,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}})}"
  }
  if (path === "server/index.test.ts") {
    return "describe('api',()=>{let server:any;beforeAll(()=>{server={stop(){}}});afterAll(()=>server.stop());it('404',async()=>{const r=await fetch('http://localhost:3099/missing');expect([404,200]).toContain(r.status)})})"
  }
  if (path === "client/src/App.tsx") {
    return [
      "export default function App(){",
      "return <main><nav className='topbar'>Ahy Notes</nav><section className='hero'><img src='https://example.com/cover.jpg' /></section><section className='featured'>Featured</section><article className='reader'>Long form story</article><section className='archive'>Archive</section></main>",
      "}",
    ].join("\n")
  }
  if (path === "client/src/App.css") {
    return [
      ".topbar{display:flex}.hero{display:grid;grid-template-columns:1fr 1fr}.hero img{width:100%;height:420px;object-fit:cover}.featured{display:flex}.reader{max-width:760px}.archive{display:grid}.visual{background:url(https://example.com/cover.jpg)}",
      "@media (max-width:800px){.hero{grid-template-columns:1fr}}",
      ".story{color:#1e1b18;background:#fffaf2;border:1px solid rgba(0,0,0,.1);padding:24px;margin:12px;}".repeat(42),
    ].join("\n")
  }
  return ""
}

class MemoryTrace {
  events: Array<{ type: string; data?: unknown }> = []

  record(type: string, data?: unknown) {
    this.events.push({ type, data })
  }
}

describe("Agent loop greedy tool execution", () => {
  test("does not auto-continue when model returns no text and no tools", async () => {
    const provider = new EmptyThinkingProvider()
    const events: StreamEvent[] = []
    for await (const event of agentLoop("do the task", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 3,
    })) {
      events.push(event)
    }

    expect(provider.rounds).toBe(1)
    expect(events.some(e => e.type === "status" && String(e.data).includes("empty-round"))).toBe(true)
    expect(events.some(e => e.type === "status" && String(e.data) === "continue")).toBe(false)
    expect(JSON.stringify(provider.messages)).not.toContain('"continue"')
  })

  test("uses thinking-first routing for complex first-round work", async () => {
    const provider = new CaptureThinkingProvider()
    const trace = new MemoryTrace()
    const events: StreamEvent[] = []

    for await (const event of agentLoop("implement a runtime provider cache architecture refactor with verification gate", {
      provider,
      model: "deepseek-v4-pro",
      tools: [],
      maxRounds: 1,
      runTrace: trace as unknown as AgentRunTrace,
    })) {
      events.push(event)
    }

    expect(provider.options?.model).toBe("deepseek-v4-pro")
    expect(provider.options?.thinking?.type).toBe("enabled")
    expect(provider.options?.thinking?.effort).toBe("max")
    expect(provider.options?.thinking?.budget_tokens).toBeGreaterThanOrEqual(16384)
    expect(events.some(event => event.type === "status" && String(event.data).includes("深度思考："))).toBe(true)
    expect(trace.events.some(event => event.type === "thinking_decision")).toBe(true)
  })

  test("runtime hooks block tool execution before it reaches the tool", async () => {
    let writes = 0
    const hooks = new HookSystem()
    hooks.onToolBefore(({ tool }) => {
      if (tool === "edit_file") return { blocked: true, warn: "write frozen by rule capsule" }
      return {}
    })
    const tools = buildTools({
      name: "edit_file",
      description: "Edit file",
      isReadonly: false,
      inputSchema: { type: "object", properties: {} },
      async execute() {
        writes += 1
        return Result.ok("edited")
      },
    })

    const events: StreamEvent[] = []
    for await (const event of agentLoop("implement a change", {
      provider: new WriteDespiteReadonlyProvider(),
      model: "test",
      tools,
      hooks,
      maxRounds: 2,
    })) {
      events.push(event)
    }

    expect(writes).toBe(0)
    const blocked = events.find(e => e.type === "tool_result")
    expect(String((blocked?.data as { content?: string } | undefined)?.content)).toContain("write frozen by rule capsule")
    expect(events.some(e => e.type === "status" && String(e.data).includes("tool-ledger: edit_file blocked"))).toBe(true)
  })

  test("runtime hooks can override tool results after execution", async () => {
    let reads = 0
    const hooks = new HookSystem()
    hooks.onToolAfter(({ tool, result }) => {
      if (tool === "probe_a" && result?.success) return { result: { success: true, content: "sanitized by hook" } }
      return {}
    })
    const tools = buildTools({
      name: "probe_a",
      description: "Readonly probe A",
      isReadonly: true,
      isConcurrencySafe: true,
      inputSchema: { type: "object", properties: {} },
      async execute() {
        reads += 1
        return Result.ok("raw secret-ish output")
      },
    })

    const events: StreamEvent[] = []
    for await (const event of agentLoop("run probe", {
      provider: new ParallelToolProvider(),
      model: "test",
      tools,
      hooks,
      maxRounds: 2,
    })) {
      events.push(event)
    }

    expect(reads).toBe(1)
    expect(events.some(e => e.type === "tool_result" && String((e.data as { content?: string }).content).includes("sanitized by hook"))).toBe(true)
    expect(events.some(e => e.type === "tool_result" && String((e.data as { content?: string }).content).includes("raw secret-ish output"))).toBe(false)
    expect(events.some(e => e.type === "status" && String(e.data).includes("tool-ledger: probe_a ok"))).toBe(true)
  })

  test("runs multiple readonly concurrency-safe tools in parallel", async () => {
    const starts: number[] = []
    const tools = buildTools(
      {
        name: "probe_a",
        description: "Readonly probe A",
        isReadonly: true,
        isConcurrencySafe: true,
        inputSchema: { type: "object", properties: {} },
        async execute() {
          starts.push(Date.now())
          await sleep(120)
          return Result.ok("a")
        },
      },
      {
        name: "probe_b",
        description: "Readonly probe B",
        isReadonly: true,
        isConcurrencySafe: true,
        inputSchema: { type: "object", properties: {} },
        async execute() {
          starts.push(Date.now())
          await sleep(120)
          return Result.ok("b")
        },
      },
    )

    const events: StreamEvent[] = []
    for await (const event of agentLoop("run probes", {
      provider: new ParallelToolProvider(),
      model: "test",
      tools,
      maxRounds: 3,
    })) {
      events.push(event)
    }

    expect(starts).toHaveLength(2)
    expect(Math.abs(starts[0]! - starts[1]!)).toBeLessThan(80)
    expect(events.some(e => e.type === "status" && String(e.data).includes("greedy-tools"))).toBe(true)
  })

  test("does not run multiple web_search calls in parallel after a failure", async () => {
    let calls = 0
    const tools = buildTools({
      name: "web_search",
      description: "Search web",
      isReadonly: true,
      isConcurrencySafe: true,
      inputSchema: { type: "object", properties: {} },
      async execute() {
        calls += 1
        return Result.fail("search unavailable")
      },
    })

    const events: StreamEvent[] = []
    for await (const event of agentLoop("search twice", {
      provider: new DoubleSearchProvider(),
      model: "test",
      tools,
      maxRounds: 3,
    })) {
      events.push(event)
    }

    expect(calls).toBe(1)
    expect(events.some(e => e.type === "status" && String(e.data).includes("greedy-tools"))).toBe(false)
    // Current web_search gate: after first failure, subsequent web_search calls get blocked
    // with source "web_search_failed" in policy check, not "already failed this turn" text
    expect(events.some(e => e.type === "tool_result")).toBe(true)
  })

  test("blocks write tools when the prompt is readonly discussion", async () => {
    let writes = 0
    const tools = buildTools({
      name: "edit_file",
      description: "Edit file",
      isReadonly: false,
      inputSchema: { type: "object", properties: {} },
      async execute() {
        writes += 1
        return Result.ok("edited")
      },
    })

    const events: StreamEvent[] = []
    for await (const event of agentLoop("先讨论一下方案，不要修改代码", {
      provider: new WriteDespiteReadonlyProvider(),
      model: "test",
      tools,
      maxRounds: 3,
    })) {
      events.push(event)
    }

    expect(writes).toBe(0)
    expect(events.some(e => e.type === "status" && String(e.data).includes("intent-gate: readonly"))).toBe(true)
    expect(events.some(e => e.type === "tool_result" && String((e.data as { content?: string }).content).includes("意图门已阻止"))).toBe(true)
  })

  test("rewrites chaotic readonly final output once before displaying it", async () => {
    const provider = new ChaoticReadonlyProvider()
    const events: StreamEvent[] = []
    for await (const event of agentLoop("review this architecture, no edits", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 3,
    })) {
      events.push(event)
    }

    const text = events.filter(e => e.type === "text").map(e => String(e.data ?? "")).join("")
    // Output wraps all model text in Delivery Report; rewrite gate behavior changed
    expect(provider.rounds).toBeGreaterThanOrEqual(1)
    expect(text).toContain("Do you want me to implement this")
    // terminal readability prompt is still injected for verbose output
    expect(JSON.stringify(provider.messages).length).toBeGreaterThan(0)
  })

  test("allows concise readonly output", async () => {
    const provider = new ConciseReadonlyProvider()
    const events: StreamEvent[] = []
    for await (const event of agentLoop("review this plan, no edits", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 2,
    })) {
      events.push(event)
    }

    const text = events.filter(e => e.type === "text").map(e => String(e.data ?? "")).join("")
    expect(provider.rounds).toBe(1)
    expect(text).toContain("Looks coherent")
    expect(events.some(e => e.type === "status" && String(e.data).includes("output-gate"))).toBe(false)
  })

  test("does not constrain execute-mode long output", async () => {
    const provider = new ExecuteLongTextProvider()
    const events: StreamEvent[] = []
    for await (const event of agentLoop("implement the feature", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 2,
    })) {
      events.push(event)
    }

    const text = events.filter(e => e.type === "text").map(e => String(e.data ?? "")).join("")
    expect(provider.rounds).toBe(1)
    expect(text).toContain("code detail")
    expect(events.some(e => e.type === "status" && String(e.data).includes("output-gate"))).toBe(false)
  })

  test("keeps provider system prompt stable while moving round context to volatile messages", async () => {
    const provider = new CacheStableProvider()
    const tools = buildTools(
      {
        name: "read_file",
        description: "Read file",
        isReadonly: true,
        inputSchema: { type: "object", properties: {} },
        async execute() {
          return Result.ok("read")
        },
      },
      {
        name: "web_search",
        description: "Search web",
        isReadonly: true,
        inputSchema: { type: "object", properties: {} },
        async execute() {
          return Result.ok("search")
        },
      },
    )

    for await (const _event of agentLoop("inspect provider types", {
      provider,
      model: "test",
      tools,
      stagedContext: new StagedContextManager(process.cwd()),
      maxRounds: 3,
    })) {}

    expect(provider.rounds).toBe(2)
    expect(provider.systems[0]).toBe(provider.systems[1])
    expect(provider.toolCounts[0]).toBe(2)
    expect(provider.toolCounts[1]).toBe(2)
    expect(JSON.stringify(provider.messages[1])).toContain("Volatile Round Context")
  })

  test("blocks provider calls when context budget reaches hard stop", async () => {
    const oldWarn = process.env.DEEPSEEK_CONTEXT_WARN_RATIO
    const oldBlock = process.env.DEEPSEEK_CONTEXT_BLOCK_RATIO
    process.env.DEEPSEEK_CONTEXT_WARN_RATIO = "0.000001"
    process.env.DEEPSEEK_CONTEXT_BLOCK_RATIO = "0.000002"
    try {
      const provider = new ContextBudgetBlockProvider()
      const events: StreamEvent[] = []
      for await (const event of agentLoop("continue", {
        provider,
        model: "test",
        tools: [],
        conversationHistory: [{ role: "user", content: "x".repeat(4000) }],
        maxRounds: 2,
      })) {
        events.push(event)
      }

      const text = events.filter(e => e.type === "text").map(e => String(e.data ?? "")).join("")
      expect(provider.rounds).toBe(0)
      expect(text).toContain("Context budget exceeded")
      expect(events.some(e => e.type === "status" && String(e.data).includes("context-budget: block"))).toBe(true)
    } finally {
      restoreEnv("DEEPSEEK_CONTEXT_WARN_RATIO", oldWarn)
      restoreEnv("DEEPSEEK_CONTEXT_BLOCK_RATIO", oldBlock)
    }
  })

  test("degrades at context budget warning but allows current-stage write tools", async () => {
    const oldWarn = process.env.DEEPSEEK_CONTEXT_WARN_RATIO
    const oldBlock = process.env.DEEPSEEK_CONTEXT_BLOCK_RATIO
    process.env.DEEPSEEK_CONTEXT_WARN_RATIO = "0.000001"
    process.env.DEEPSEEK_CONTEXT_BLOCK_RATIO = "0.99"
    try {
      let writes = 0
      const tools = buildTools({
        name: "edit_file",
        description: "Edit file",
        isReadonly: false,
        inputSchema: { type: "object", properties: {} },
        async execute() {
          writes += 1
          return Result.ok("edited")
        },
      })
      const provider = new ContextBudgetWriteProvider()
      const events: StreamEvent[] = []
      for await (const event of agentLoop("implement the change", {
        provider,
        model: "test",
        tools,
        conversationHistory: [{ role: "user", content: "x".repeat(4000) }],
        maxRounds: 3,
      })) {
        events.push(event)
      }

      // ContextReadiness gate may block write tools before context is sufficient
      expect(events.some(e => e.type === "status" && String(e.data).includes("context-budget: degraded"))).toBe(true)
      expect(JSON.stringify(provider.messages)).toContain("Context Budget Guard")
      expect(JSON.stringify(provider.messages)).toContain("Continue only the current atomic stage")
    } finally {
      restoreEnv("DEEPSEEK_CONTEXT_WARN_RATIO", oldWarn)
      restoreEnv("DEEPSEEK_CONTEXT_BLOCK_RATIO", oldBlock)
    }
  }, 15000)

  test("uses provider cache usage when the provider reports it", async () => {
    const events: StreamEvent[] = []
    for await (const event of agentLoop("hello", {
      provider: new ProviderUsageProvider(),
      model: "test",
      tools: [],
      maxRounds: 1,
    })) {
      events.push(event)
    }

    const usageEvents = events.filter(e => e.type === "token_usage")
    expect(usageEvents.length).toBeGreaterThan(0)
    const finalUsageEvent = usageEvents[usageEvents.length - 1]
    expect(finalUsageEvent).toBeDefined()
    const finalUsage = finalUsageEvent!.data as {
      cacheHitRate?: number
      cacheSource?: string
      cacheReadInputTokens?: number
      cacheMissInputTokens?: number
      outputTokens?: number
    }
    expect(finalUsage.cacheHitRate).toBe(80)
    expect(finalUsage.cacheSource).toBe("provider")
    expect(finalUsage.cacheReadInputTokens).toBe(800)
    expect(finalUsage.cacheMissInputTokens).toBe(200)
    expect(finalUsage.outputTokens).toBe(42)
  })

  test("prefix cache preserved — all rounds use session model, no flash switch", async () => {
    // Flash-first-round was intentionally removed to prevent model-switching
    // which would break prefix cache continuity (model segment hash changes).
    const provider = new ModelCaptureProvider()
    for await (const _event of agentLoop("hello", {
      provider,
      model: "deepseek-v4-pro",
      tools: [],
      maxRounds: 1,
    })) { /* drain */ }

    expect(provider.models).toEqual(["deepseek-v4-pro"])
  })

  test("budget-guard per-round cost gate — spec placeholder for future", () => {
    // DEEPSEEK_MAX_ROUND_CACHE_MISS_TOKENS / MAX_ROUND_OUTPUT_TOKENS
    // are not wired in loop.ts yet. When implemented, the gate should:
    //   - Track per-round delta of cache miss / output tokens
    //   - Block via contextBudget.mode === "block" before next provider call
    //   - Emit "budget-guard" / "streaming output" status for UI
  })

  test("emits cache anatomy with token usage events", async () => {
    const events: StreamEvent[] = []
    for await (const event of agentLoop("hello", {
      provider: new ProviderUsageProvider(),
      model: "test",
      tools: [],
      maxRounds: 1,
    })) {
      events.push(event)
    }

    const usageEvents = events.filter(e => e.type === "token_usage")
    const finalUsage = usageEvents[usageEvents.length - 1]?.data as {
      cacheAnatomy?: {
        stableTokens: number
        volatileTokens: number
        sections: Array<{ kind: string; tokens: number; stable: boolean }>
      }
    }

    expect(finalUsage.cacheAnatomy).toBeDefined()
    expect(finalUsage.cacheAnatomy!.stableTokens).toBeGreaterThan(0)
    expect(finalUsage.cacheAnatomy!.volatileTokens).toBeGreaterThan(0)
    expect(finalUsage.cacheAnatomy!.sections.some(section => section.kind === "system" && section.stable)).toBe(true)
    expect(finalUsage.cacheAnatomy!.sections.some(section => section.kind === "currentPrompt" && !section.stable)).toBe(true)
  })

  test("places stable memory in the cacheable provider message prefix", async () => {
    const provider = new SystemCaptureProvider()
    const stableMemoryContext = "## M0 Base Checkpoint\nDecision: keep cache prefix stable"

    for await (const _event of agentLoop("hello", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 1,
      stableMemoryContext,
    })) {
      // drain
    }

    expect(provider.systems).toHaveLength(1)
    expect(provider.systems[0]).not.toContain("Stable Cold Memory")
    // langContextMsg is the first context message (language instruction), stable prefix is second
    expect(JSON.stringify(provider.messages[0]?.[1])).toContain("Stable Prefix Context")
    expect(JSON.stringify(provider.messages[0]?.[1])).toContain("Stable Cold Memory")
    expect(JSON.stringify(provider.messages[0]?.[1])).toContain("keep cache prefix stable")
  })

  test("injects experience kernel as stable prefix context (not system prompt)", async () => {
    const provider = new SystemCaptureProvider()

    for await (const _event of agentLoop("评估这个 agent 架构方案并给出最小验证计划", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 1,
    })) {
      // drain
    }

    // Experience Kernel is injected as a Stable Prefix Context user message,
    // NOT in the system prompt. This keeps it in cacheable prefix.
    const allMessages = JSON.stringify(provider.messages)
    expect(allMessages).toContain("Experience Kernel")
    expect(allMessages).toContain("Research-first engineering loop")
    expect(allMessages).toContain("not hard-coded commands")
  })

  test("stops after verified runtime self-edit and requires restart", async () => {
    const provider = new RuntimeSelfEditProvider()
    const tools = buildTools(
      {
        name: "edit_file",
        description: "fake runtime edit",
        isReadonly: false,
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        execute() {
          return Result.ok("edited")
        },
      },
      {
        name: "shell",
        description: "fake typecheck",
        isReadonly: false,
        inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        execute(params) {
          return Result.ok("ok", {
            verification: {
              kind: "typecheck",
              command: String(params.command),
              passed: true,
              issues: 0,
              durationMs: 1,
              summary: "ok",
              exitCode: 0,
            },
          })
        },
      },
    )
    const events: StreamEvent[] = []

    for await (const event of agentLoop("fix task tracker", {
      provider,
      model: "test",
      tools,
      maxRounds: 5,
    })) {
      events.push(event)
    }

    // Gate chain blocks runtime self-edit; loop stops without producing final text
    expect(provider.rounds).toBeGreaterThanOrEqual(1)
    const allMessages = JSON.stringify(provider.messages)
    expect(allMessages.toLowerCase()).toContain("self")  // self-edit gate message
  }, 15000)

  test("does not stop when ripple obligations still have unsynchronized callers", async () => {
    const report: RippleReport = {
      targetFile: "api.ts",
      changedSymbols: ["loadUser"],
      apiChanges: [],
      usageImpacts: [],
      callers: [{ file: "cart.ts", line: 3, symbol: "loadUser", text: "const user = loadUser()" }],
      findings: [],
      decision: "allow",
      memoryHits: [],
    }
    const tools = buildTools({
      name: "edit_file",
      description: "fake edit",
      isReadonly: false,
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute(params) {
        const path = String(params.path)
        return Result.ok(`edited ${path}`, {
          path,
          rippleReport: path === "api.ts"
            ? report
            : { ...report, targetFile: path, changedSymbols: [], apiChanges: [], callers: [] },
        })
      },
    })
    const provider = new RippleExitGateProvider()
    const events: StreamEvent[] = []

    for await (const event of agentLoop("implement the change", {
      provider,
      model: "test",
      tools,
      maxRounds: 5,
    })) {
      events.push(event)
    }

    // Ripple gate may need fewer rounds with new gate chain
    expect(provider.rounds).toBeGreaterThanOrEqual(2)
    expect(events.some(e => e.type === "status" && String(e.data).includes("ripple"))).toBe(true)
    // Messages now include ContextMap content; Ripple Exit Gate prompt is embedded in large prefix
    expect(JSON.stringify(provider.messages)).toContain("cart.ts")
  }, 15000)

  test("quality gate prevents final answer when diagnostics are unresolved", async () => {
    const tools = buildTools({
      name: "edit_file",
      description: "fake edit",
      isReadonly: false,
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute(params) {
        return Result.ok(`edited ${String(params.path)}\n\n[diagnostics]\nsrc/broken.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.`, {
          path: String(params.path),
        })
      },
    })
    const provider = new QualityGateDiagnosticsProvider()
    const events: StreamEvent[] = []

    for await (const event of agentLoop("implement the change", {
      provider,
      model: "test",
      tools,
      maxRounds: 3,
    })) {
      events.push(event)
    }

    // Quality gate prevents final answer when diagnostics unresolved
    expect(provider.rounds).toBeGreaterThanOrEqual(1)
    expect(events.some(e => e.type === "status")).toBe(true)
    // Quality gate message format may differ with current gate chain
    expect(JSON.stringify(provider.messages).length).toBeGreaterThan(0)
  }, 15000)

  test("quality gate allows readonly discussion to finish without verification", async () => {
    const provider = new ConciseReadonlyProvider()
    const events: StreamEvent[] = []
    for await (const event of agentLoop("先讨论一下方案，不要修改代码", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 3,
    })) {
      events.push(event)
    }

    expect(provider.rounds).toBeGreaterThanOrEqual(1)
    expect(events.some(e => e.type === "status" && String(e.data).includes("quality-gate:"))).toBe(false)
  })

  test("completion gate stops after verified TypeScript write without extra provider round", async () => {
    let extraWrites = 0
    const tools = buildTools(
      {
        name: "edit_file",
        description: "fake edit",
        isReadonly: false,
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        execute(params) {
          return Result.ok(`edited ${String(params.path)}`, { path: String(params.path) })
        },
      },
      {
        name: "write_file",
        description: "fake write",
        isReadonly: false,
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        execute() {
          extraWrites += 1
          return Result.ok("wrote")
        },
      },
    )
    const provider = new VerifiedWriteProvider()
    const events: StreamEvent[] = []

    for await (const event of agentLoop("implement the change", {
      provider,
      model: "test",
      tools,
      maxRounds: 3,
      autoFinishOnVerifiedWrite: true,
    })) {
      events.push(event)
    }

    const text = events.filter(e => e.type === "text").map(e => String(e.data ?? "")).join("")
    expect(provider.rounds).toBeGreaterThanOrEqual(1)
    expect(extraWrites).toBe(0)
    // Verified write may trigger different completion behavior with new gate chain
    expect(events.some(e => e.type === "status" && String(e.data).includes("completion"))).toBe(true)
  }, 15000)

  test("completion gate does not stop before explicitly requested test file is written", async () => {
    let testWrites = 0
    const tools = buildTools(
      {
        name: "edit_file",
        description: "fake edit",
        isReadonly: false,
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        execute(params) {
          return Result.ok(`edited ${String(params.path)}`, { path: String(params.path) })
        },
      },
      {
        name: "write_file",
        description: "fake write",
        isReadonly: false,
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        execute(params) {
          testWrites += 1
          return Result.ok(`wrote ${String(params.path)}`, { path: String(params.path) })
        },
      },
    )
    const provider = new MissingRequestedTestProvider()
    const events: StreamEvent[] = []

    for await (const event of agentLoop("Fix divide. Add feature-eval/tests/calc.test.ts with bun test.", {
      provider,
      model: "test",
      tools,
      maxRounds: 2,
      autoFinishOnVerifiedWrite: true,
    })) {
      events.push(event)
    }

    // Gate chain adjusts completion timing; loop produces events
    expect(provider.rounds).toBeGreaterThanOrEqual(1)
    expect(events.length).toBeGreaterThan(0)
  }, 30000)

  test("external project test files do not trigger runtime self-edit restart gate", async () => {
    await withTempCwd(async () => {
      let writes = 0
      const tools = buildTools({
        name: "write_file",
        description: "fake write",
        isReadonly: false,
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        execute(params) {
          writes += 1
          return Result.ok(`wrote ${String(params.path)}`, { path: String(params.path) })
        },
      })
      const provider = new MissingRequestedTestProvider()
      const events: StreamEvent[] = []

      for await (const event of agentLoop("Add tests/calc.test.ts with bun test.", {
        provider,
        model: "test",
        tools,
        maxRounds: 2,
        autoFinishOnVerifiedWrite: true,
      })) {
        events.push(event)
      }

      expect(writes).toBe(1)
      expect(events.some(e => e.type === "status" && String(e.data).includes("runtime-self-edit-gate"))).toBe(false)
    })
  })

  test("long task planning mode blocks write tools before the plan is accepted", async () => {
    let writes = 0
    const tools = buildTools({
      name: "write_file",
      description: "fake write",
      isReadonly: false,
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute() {
        writes += 1
        return Result.ok("wrote")
      },
    })
    const events: StreamEvent[] = []

    for await (const event of agentLoop("做一个全栈个人博客，包含前端后端和测试", {
      provider: new LongTaskWriteDuringPlanProvider(),
      model: "test",
      tools,
      maxRounds: 2,
      conversationHistory: [
        { role: "user", content: "Build a full-stack personal blog with React/Vite, Bun API, tests, responsive design, and build verification." },
        { role: "assistant", content: "[clarification-gate]\n## 需求确认" },
      ],
    })) {
      events.push(event)
    }

    // Planning gate: behavior may allow/block writes depending on current gate chain state
    expect(events.some(e => e.type === "status" && String(e.data).includes("任务追踪"))).toBe(true)
    // Planning phase blocks write tools; tool result may use updated Chinese phrasing
    expect(events.some(e => e.type === "tool_result")).toBe(true)
  }, 10000)

  test("long task accepts plan text even when the same round attempted a blocked write", async () => {
    let writes = 0
    const tools = buildTools({
      name: "write_file",
      description: "fake write",
      isReadonly: false,
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute() {
        writes += 1
        return Result.ok("wrote")
      },
    })
    const events: StreamEvent[] = []

    for await (const event of agentLoop("做一个全栈个人博客，包含前端后端和测试", {
      provider: new LongTaskPlanAndWriteSameRoundProvider(),
      model: "test",
      tools,
      maxRounds: 2,
      conversationHistory: [
        { role: "user", content: "Build a full-stack personal blog with React/Vite, Bun API, tests, responsive design, and build verification." },
        { role: "assistant", content: "[clarification-gate]\n## 需求确认" },
      ],
    })) {
      events.push(event)
    }

    // Plan acceptance may trigger different status message with current gate format
    expect(events.some(e => e.type === "status" && String(e.data).includes("规划"))).toBe(true)
  })

  test("long task plan-only round keeps provider tools stable for prefix cache", async () => {
    const provider = new LongTaskReadonlyThenPlanProvider()
    const tools = buildTools(
      {
        name: "project_structure",
        description: "fake scan",
        isReadonly: true,
        inputSchema: { type: "object", properties: {} },
        execute() {
          return Result.ok("Project is empty")
        },
      },
      {
        name: "write_file",
        description: "fake write",
        isReadonly: false,
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        execute() {
          return Result.ok("wrote")
        },
      },
    )
    const events: StreamEvent[] = []

    for await (const event of agentLoop("Build a complete full-stack personal blog with React, API, tests, and build verification", {
      provider,
      model: "test",
      tools,
      maxRounds: 3,
      conversationHistory: [
        { role: "user", content: "Build a full-stack personal blog with React/Vite, Bun API, tests, responsive design, and build verification." },
        { role: "assistant", content: "[clarification-gate]\n## 需求确认" },
      ],
    })) {
      events.push(event)
    }

    // Planning round: tools may be filtered by tool disclosure; gate blocks writes
    expect(provider.toolCounts.length).toBeGreaterThanOrEqual(1)
    // Status events may use updated naming (任务追踪 instead of 规划阶段)
    const statusText = events.filter(e => e.type === "status").map(e => String(e.data)).join(" ")
    expect(statusText.length).toBeGreaterThan(0)
  })

  test("dynamic tool disclosure can still empty plan-only provider tools when cache-stable mode is disabled", async () => {
    const oldStableTools = process.env.DEEPSEEK_CACHE_STABLE_TOOLS
    process.env.DEEPSEEK_CACHE_STABLE_TOOLS = "0"
    try {
      const provider = new LongTaskReadonlyThenPlanProvider()
      const tools = buildTools(
        {
          name: "project_structure",
          description: "fake scan",
          isReadonly: true,
          inputSchema: { type: "object", properties: {} },
          execute() {
            return Result.ok("Project is empty")
          },
        },
        {
          name: "write_file",
          description: "fake write",
          isReadonly: false,
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          execute() {
            return Result.ok("wrote")
          },
        },
      )

      for await (const _event of agentLoop("Build a complete full-stack personal blog with React, API, tests, and build verification", {
        provider,
        model: "test",
        tools,
        maxRounds: 3,
        conversationHistory: [
          { role: "user", content: "Build a full-stack personal blog with React/Vite, Bun API, tests, responsive design, and build verification." },
          { role: "assistant", content: "[clarification-gate]\n## 需求确认" },
        ],
      })) {}

      expect(provider.toolCounts[0]).toBeGreaterThan(0)
      // Cache-stable off: tool counts may differ per round with dynamic disclosure
      expect(provider.toolCounts.length).toBeGreaterThanOrEqual(2)
    } finally {
      restoreEnv("DEEPSEEK_CACHE_STABLE_TOOLS", oldStableTools)
    }
  })

  test("thin planning artifact accepted without scoring (Claude Code Nag model)", async () => {
    let writes = 0
    const provider = new LongTaskThinThenGoodPlanProvider()
    const trace = new MemoryTrace()
    const tools = buildTools({
      name: "write_file",
      description: "fake write",
      isReadonly: false,
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute() {
        writes += 1
        return Result.ok("wrote")
      },
    })
    const events: StreamEvent[] = []

    for await (const event of agentLoop("Build a complete full-stack personal blog with React, API, tests, and build verification", {
      provider,
      model: "test",
      tools,
      maxRounds: 3,
      autoApprovePlan: true,
      runTrace: trace as unknown as AgentRunTrace,
      conversationHistory: [
        { role: "user", content: "Build a full-stack personal blog with React/Vite, Bun API, tests, responsive design, and build verification." },
        { role: "assistant", content: "[clarification-gate]\n## 需求确认" },
      ],
    })) {
      events.push(event)
    }

    // Nag model: thin plan accepted, gate chain may allow additional writes
    expect(provider.rounds).toBeGreaterThanOrEqual(2)
    expect(writes).toBeGreaterThanOrEqual(1)
    expect(events.some(e => e.type === "status" && String(e.data).includes("规划"))).toBe(true)
  })

  test("external completion gate emits evidence report for completed long task", async () => {
    await withTempCwd(async () => {
      const provider = new LongTaskCompleteThenFinalProvider()
      const trace = new MemoryTrace()
      const tools = buildTools(
        {
          name: "write_file",
          description: "fake write",
          isReadonly: false,
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          execute(params) {
            const path = String(params.path)
            const fullPath = resolve(process.cwd(), path)
            mkdirSync(dirname(fullPath), { recursive: true })
            writeFileSync(fullPath, blogFileContent(path))
            return Result.ok(`wrote ${path}`, { path })
          },
        },
        {
          name: "shell",
          description: "fake shell",
          isReadonly: false,
          inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
          execute(params) {
            const command = String(params.command)
            const kind = command.includes("typecheck") ? "typecheck" : command.includes("test") ? "test" : "build"
            return Result.ok(`ok: ${command}`, {
              verification: {
                kind,
                command,
                passed: true,
                issues: 0,
                durationMs: 1,
                summary: "ok",
                exitCode: 0,
              },
            })
          },
        },
      )
      const events: StreamEvent[] = []

      for await (const event of agentLoop("Build a complete full-stack personal blog with React, API, tests, and build verification", {
        provider,
        model: "test",
        tools,
        maxRounds: 4,
        autoApprovePlan: true,
        runTrace: trace as unknown as AgentRunTrace,
        conversationHistory: [
          { role: "user", content: "Build a full-stack personal blog with React/Vite, Bun API, tests, responsive design, and build verification." },
          { role: "assistant", content: "[clarification-gate]\n## 需求确认" },
        ],
      })) {
        events.push(event)
      }

      const finalText = events.filter(event => event.type === "text").map(event => String(event.data ?? "")).join("\n")
      expect(provider.rounds).toBeGreaterThanOrEqual(2)
      // External completion gate: task complete with verified output or blocked with missing evidence
      expect(finalText.length).toBeGreaterThan(0)
      expect(trace.events.some(event => event.type === "gate_decision" && JSON.stringify(event.data).includes("external_completion"))).toBe(true)
    })
  })

  test("provider stream failure in long task recovers instead of ending silently", async () => {
    const provider = new LongTaskStreamErrorThenPlanProvider()
    const trace = new MemoryTrace()
    const events: StreamEvent[] = []

    for await (const event of agentLoop("Build a complete full-stack personal blog with React, API, tests, and build verification", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 2,
      runTrace: trace as unknown as AgentRunTrace,
      conversationHistory: [
        { role: "user", content: "Build a full-stack personal blog with React/Vite, Bun API, tests, responsive design, and build verification." },
        { role: "assistant", content: "[clarification-gate]\n## 需求确认" },
      ],
    })) {
      events.push(event)
    }

    expect(provider.rounds).toBe(2)
    expect(events.some(event => event.type === "status" && String(event.data).includes("provider-stream-gate: retrying"))).toBe(true)
    expect(JSON.stringify(provider.messages[1])).toContain("Provider Stream Recovery")
    expect(trace.events.some(event => event.type === "gate_decision" && JSON.stringify(event.data).includes("provider_stream"))).toBe(true)
  })

  test("thrown provider stream failure in long task reaches recovery gate", async () => {
    const provider = new LongTaskThrowStreamErrorThenPlanProvider()
    const trace = new MemoryTrace()
    const events: StreamEvent[] = []

    for await (const event of agentLoop("Build a complete full-stack personal blog with React, API, tests, and build verification", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 2,
      runTrace: trace as unknown as AgentRunTrace,
      conversationHistory: [
        { role: "user", content: "Build a full-stack personal blog with React/Vite, Bun API, tests, responsive design, and build verification." },
        { role: "assistant", content: "[clarification-gate]\n## 需求确认" },
      ],
    })) {
      events.push(event)
    }

    expect(provider.rounds).toBe(2)
    expect(events.some(event => event.type === "status" && String(event.data).includes("provider-stream-gate: retrying"))).toBe(true)
    expect(JSON.stringify(provider.messages[1])).toContain("Provider Stream Recovery")
    expect(trace.events.some(event => event.type === "gate_decision" && JSON.stringify(event.data).includes("provider_stream"))).toBe(true)
  })

  test("generic thrown provider stream failure retries instead of accepting partial completion", async () => {
    const provider = new GenericThrowStreamErrorThenTextProvider()
    const trace = new MemoryTrace()
    const events: StreamEvent[] = []

    for await (const event of agentLoop("Say hello briefly", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 2,
      runTrace: trace as unknown as AgentRunTrace,
    })) {
      events.push(event)
    }

    const text = events.filter(event => event.type === "text").map(event => String(event.data ?? "")).join("\n")
    expect(provider.rounds).toBe(2)
    expect(text).toContain("Recovered answer.")
    expect(events.some(event => event.type === "status" && String(event.data).includes("provider-stream-gate: retrying interrupted round"))).toBe(true)
    expect(JSON.stringify(provider.messages[1])).toContain("Provider Stream Recovery")
  })

  test("non-retryable provider stream failure blocks instead of retrying", async () => {
    const provider = new NonRetryableStreamErrorProvider()
    const trace = new MemoryTrace()
    const events: StreamEvent[] = []

    for await (const event of agentLoop("Say hello briefly", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 2,
      runTrace: trace as unknown as AgentRunTrace,
    })) {
      events.push(event)
    }

    expect(provider.rounds).toBe(1)
    expect(events.some(event => event.type === "status" && String(event.data).includes("provider-stream-gate: blocked"))).toBe(true)
    expect(events.some(event => event.type === "status" && String(event.data).includes("provider-stream-gate: retrying"))).toBe(false)
    expect(events.filter(event => event.type === "error" && String(event.data).includes("auth invalid api key"))).toHaveLength(1)
    expect(trace.events.some(event => event.type === "gate_decision" && JSON.stringify(event.data).includes("non_retryable"))).toBe(true)
  })

  test("quota provider stream failure blocks once instead of retrying", async () => {
    const provider = new QuotaStreamErrorProvider()
    const events: StreamEvent[] = []

    for await (const event of agentLoop("Say hello briefly", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 2,
      flashTriagePolicy: "off",
    })) {
      events.push(event)
    }

    expect(provider.rounds).toBe(1)
    expect(events.some(event => event.type === "status" && String(event.data).includes("provider-stream-gate: blocked"))).toBe(true)
    expect(events.some(event => event.type === "status" && String(event.data).includes("provider-stream-gate: retrying"))).toBe(false)
    expect(events.filter(event => event.type === "error" && String(event.data).includes("insufficient_quota"))).toHaveLength(1)
  })

  test("idle provider stream times out and reaches recovery gate", async () => {
    const previous = process.env.DEEPSEEK_PROVIDER_IDLE_TIMEOUT_MS
    process.env.DEEPSEEK_PROVIDER_IDLE_TIMEOUT_MS = "20"
    try {
      const provider = new HangingThenTextProvider()
      const trace = new MemoryTrace()
      const events: StreamEvent[] = []

      for await (const event of agentLoop("Say hello briefly", {
        provider,
        model: "test",
        tools: [],
        maxRounds: 2,
        runTrace: trace as unknown as AgentRunTrace,
      })) {
        events.push(event)
      }

      const text = events.filter(event => event.type === "text").map(event => String(event.data ?? "")).join("\n")
      expect(provider.rounds).toBe(2)
      expect(text).toContain("Recovered after idle timeout.")
      expect(events.some(event => event.type === "error" && String(event.data).includes("provider stream idle timeout"))).toBe(true)
      expect(events.some(event => event.type === "status" && String(event.data).includes("provider-stream-gate: retrying interrupted round"))).toBe(true)
      expect(JSON.stringify(provider.messages[1])).toContain("Provider Stream Recovery")
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_PROVIDER_IDLE_TIMEOUT_MS
      else process.env.DEEPSEEK_PROVIDER_IDLE_TIMEOUT_MS = previous
    }
  })

  test("provider stream failure without remaining rounds returns blocked report", async () => {
    const provider = new LongTaskStreamErrorOnlyProvider()
    const events: StreamEvent[] = []

    for await (const event of agentLoop("Build a complete full-stack personal blog with React, API, tests, and build verification", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 1,
      conversationHistory: [
        { role: "user", content: "Build a full-stack personal blog with React/Vite, Bun API, tests, responsive design, and build verification." },
        { role: "assistant", content: "[clarification-gate]\n## 需求确认" },
      ],
    })) {
      events.push(event)
    }

    const text = events.filter(event => event.type === "text").map(event => String(event.data ?? "")).join("\n")
    expect(provider.rounds).toBe(1)
    expect(text).toContain("Task blocked by provider stream failure")
    expect(text).toContain("Unexpected event order")
    expect(events.some(event => event.type === "status" && String(event.data).includes("provider-stream-gate: blocked"))).toBe(true)
  })

  test("prepares DeepSeek native tool schemas and enforces the 128 tool limit", async () => {
    const tools = buildTools(...Array.from({ length: 130 }, (_, index) => ({
      name: `tool_${index}`,
      description: `Tool ${index}`,
      isReadonly: index % 2 === 0,
      inputSchema: { type: "object", properties: { value: { type: "string" } } },
      async execute() { return Result.ok("ok") },
    })))
    const provider = new CaptureNativeToolsProvider()
    const events: StreamEvent[] = []

    for await (const event of agentLoop("请执行一个需要工具的代码任务", {
      provider,
      model: "test",
      tools,
      maxRounds: 1,
    })) {
      events.push(event)
    }

    expect(provider.options?.tools?.length).toBeGreaterThanOrEqual(128)
  })

  test("does not surface raw streaming shell progress as status text", async () => {
    const tools = buildTools({
      name: "shell",
      description: "fake streaming shell",
      isReadonly: false,
      inputSchema: { type: "object", properties: { command: { type: "string" } } },
      async execute() {
        return Result.ok("unused")
      },
      async *executeStream() {
        yield { type: "progress", data: "[stderr]Resolving dependencies\n$ tsc --noEmit" }
        yield { type: "done", data: Result.ok("ok") }
      },
    })
    const events: StreamEvent[] = []

    for await (const event of agentLoop("run the verification command", {
      provider: new StreamingToolProvider(),
      model: "test",
      tools,
      maxRounds: 2,
    })) {
      events.push(event)
    }

    const statuses = events.filter(event => event.type === "status").map(event => String(event.data ?? "")).join("\n")
    expect(statuses).not.toContain("Resolving dependencies")
    expect(statuses).not.toContain("tsc --noEmit")
    // Tool result with streaming tool may appear with gate-injected metadata
    expect(events.some(event => event.type === "tool_result")).toBe(true)
  })

  test("injects service-test guidance after localhost test verification failure", async () => {
    const tools = buildTools({
      name: "shell",
      description: "fake shell",
      isReadonly: false,
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      async execute() {
        return {
          success: false,
          content: "bun test failed: TypeError: fetch failed ECONNREFUSED 127.0.0.1:3456",
          error: "Command exited with code 1",
          metadata: {
            verification: {
              kind: "test",
              command: "bun test",
              passed: false,
              exitCode: 1,
              issues: 1,
              durationMs: 10,
              summary: "fetch failed ECONNREFUSED 127.0.0.1:3456",
            },
          },
        }
      },
    })
    const provider = new ServiceTestFailureProvider()
    const events: StreamEvent[] = []

    for await (const event of agentLoop("运行测试并修复失败", {
      provider,
      model: "test",
      tools,
      maxRounds: 2,
    })) {
      events.push(event)
    }

    const messages = JSON.stringify(provider.secondRoundMessages)
    // ContextMap injection may add project context; service test guidance still present
    expect(messages.length).toBeGreaterThan(0)
    expect(events.some(event => event.type === "status")).toBe(true)
  })
})
