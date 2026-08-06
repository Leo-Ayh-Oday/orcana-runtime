import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { agentLoop } from "../src/agent/loop"
import { drainPhase, wrapEvents } from "../src/agent/kernel/effects"
import type { LoopDecision, RunEffect, RunPhaseContext } from "../src/agent/kernel/types"
import type { AgentRunTrace } from "../src/agent/run-trace"
import { HookEvent, HookSystem } from "../src/hooks"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { buildTools, Result } from "../src/tools/registry"

// ALK PR-L7 acceptance: the kernel's terminal switch emits final text and
// completion events exactly once, every exit routes through finalizeRun
// (single Stop hook, correct reason), and the close protocol propagates
// consumer close into phase generators.

const SAVED_ORCANA_FLASH_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
process.env.ORCANA_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_ORCANA_FLASH_TRIAGE === undefined) delete process.env.ORCANA_FLASH_TRIAGE
  else process.env.ORCANA_FLASH_TRIAGE = SAVED_ORCANA_FLASH_TRIAGE
})

class MemoryTrace {
  events: Array<{ type: string; data?: unknown }> = []
  record(type: string, data?: unknown) {
    this.events.push({ type, data })
  }
}

/** Round 0 tool probe, then final text — buffered readonly path. */
class ProbeThenTextProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "probe-1", name: "baseline_probe", input: {} } }
      return
    }
    yield { type: "text", data: "L7 final answer." }
  }
}

/** Always asks for a tool — forces natural round-budget exhaustion. */
class AlwaysToolProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.rounds++
    yield { type: "tool_call", data: { id: `probe-${this.rounds}`, name: "baseline_probe", input: {} } }
  }
}

/** Yields nothing — hits the empty-round break path. */
class EmptyProvider implements LLMProvider {
  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    return
  }
}

function probeTool() {
  return buildTools({
    name: "baseline_probe",
    description: "Return a deterministic read-only probe result",
    isReadonly: true,
    isConcurrencySafe: true,
    inputSchema: { type: "object", properties: {}, required: [] },
    execute() {
      return Result.ok("probe-ok")
    },
  })
}

async function collect(iterable: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

describe("Agent kernel L7 terminal switch", () => {
  test("emits the final text exactly once across buffered readonly rounds", async () => {
    const trace = new MemoryTrace()
    const stopReasons: string[] = []
    const hooks = new HookSystem()
    hooks.on(HookEvent.Stop, input => {
      stopReasons.push(input.reason)
      return {}
    })
    const events = await collect(agentLoop(
      "Read only: inspect the kernel and summarize it. Do not edit or write files.",
      {
        provider: new ProbeThenTextProvider(),
        model: "test",
        tools: probeTool(),
        hooks,
        runTrace: trace as unknown as AgentRunTrace,
        contextMapPolicy: "off",
        maxRounds: 3,
      },
    ))

    const finalTexts = events.filter(event =>
      event.type === "text" && event.data === "L7 final answer."
    )
    expect(finalTexts).toHaveLength(1)
    expect(stopReasons).toEqual(["completed"])
    expect(trace.events.filter(event => event.type === "agent_loop_finished")).toHaveLength(1)
  })

  test("round budget exhaustion emits one budget message and one Stop hook", async () => {
    const trace = new MemoryTrace()
    const stopReasons: string[] = []
    const hooks = new HookSystem()
    hooks.on(HookEvent.Stop, input => {
      stopReasons.push(input.reason)
      return {}
    })
    const provider = new AlwaysToolProvider()
    const events = await collect(agentLoop("inspect the project state", {
      provider,
      model: "test",
      tools: probeTool(),
      hooks,
      runTrace: trace as unknown as AgentRunTrace,
      contextMapPolicy: "off",
      maxRounds: 2,
    }))

    expect(provider.rounds).toBe(2)
    expect(events.filter(event =>
      event.type === "status" && String(event.data).startsWith("round-budget: exhausted")
    )).toHaveLength(1)
    expect(events.filter(event => event.type === "text")).toHaveLength(1)
    expect(stopReasons).toEqual(["completed"])
    expect(trace.events.filter(event => event.type === "agent_loop_finished")).toHaveLength(1)
  })

  test("empty round breaks to the completed terminal with no final text", async () => {
    const stopReasons: string[] = []
    const hooks = new HookSystem()
    hooks.on(HookEvent.Stop, input => {
      stopReasons.push(input.reason)
      return {}
    })
    const events = await collect(agentLoop("inspect without edits", {
      provider: new EmptyProvider(),
      model: "test",
      tools: [],
      hooks,
      contextMapPolicy: "off",
      maxRounds: 2,
    }))

    expect(events.some(event =>
      event.type === "status" && event.data === "empty-round: no tool calls or final text"
    )).toBe(true)
    expect(events.filter(event => event.type === "text")).toHaveLength(0)
    expect(stopReasons).toEqual(["completed"])
  })
})

// ── K21: epoch compression acts immediately + forceCompress warning timing ──

/** Captures every provider request; always answers with plain text. */
class CaptureTextProvider implements LLMProvider {
  requests: ProviderCallOptions[] = []

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.requests.push(options)
    yield { type: "text", data: "done" }
  }
}

/** Seed a conversation whose early turns carry large `shell` tool results.
 *
 *  compactHistoricalToolResults keeps the most recent `keepRecentRounds=8`
 *  assistant turns untouched and compacts older ones, so the history needs
 *  >8 assistant turns for anything to be compacted — and it must open with a
 *  user message (a leading assistant message is dropped on load). With 9 turns
 *  the first turn (assistant index 0 < 9−8) is the only compactable one.
 *  Cast via `as never`: the loop's conversationHistory option only accepts
 *  string content, while the epoch-compact path needs block content. */
function seededToolHistory(turns: number, resultChars: number): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [{ role: "user", content: "start" }]
  for (let i = 0; i < turns; i++) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `shell-${i + 1}`, name: "shell", input: {} }],
    })
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `shell-${i + 1}`, content: "y".repeat(resultChars) }],
    })
  }
  return messages
}

describe("Agent kernel K21 epoch compression", () => {
  const savedBlockRatio = process.env.ORCANA_CONTEXT_BLOCK_RATIO
  const savedWarnRatio = process.env.ORCANA_CONTEXT_WARN_RATIO

  // The fixed per-round overhead (~13k chars: system prompt + the orcana
  // project's context kernel) makes the compress/force bands unreachable at a
  // contextMaxTokens that also clears the context-budget gate. The budget gate
  // is not under test here (the epoch tiers are), so neutralise it for these
  // two tests — the same override the L0 baseline applies in reverse.
  beforeEach(() => {
    process.env.ORCANA_CONTEXT_BLOCK_RATIO = "0.99"
    process.env.ORCANA_CONTEXT_WARN_RATIO = "0.99"
  })
  afterEach(() => {
    if (savedBlockRatio === undefined) delete process.env.ORCANA_CONTEXT_BLOCK_RATIO
    else process.env.ORCANA_CONTEXT_BLOCK_RATIO = savedBlockRatio
    if (savedWarnRatio === undefined) delete process.env.ORCANA_CONTEXT_WARN_RATIO
    else process.env.ORCANA_CONTEXT_WARN_RATIO = savedWarnRatio
  })

  test("compress tier immediately compacts existing historical tool results", async () => {
    const provider = new CaptureTextProvider()
    const statuses: string[] = []
    for await (const event of agentLoop("run", {
      provider: provider as never,
      model: "test",
      tools: [],
      contextMapPolicy: "off",
      // 9 historical shell turns × 5k-char results → round-0 raw scope ≈ 45k
      // chars. contextMaxTokens=50000 puts that in the compress band
      // (compress=37500, forceCompress=57000).
      conversationHistory: seededToolHistory(9, 5_000) as never,
      contextMaxTokens: 50_000,
      maxRounds: 2,
    })) {
      if (event.type === "status") statuses.push(String(event.data))
    }

    expect(statuses.some(s => s.startsWith("epoch-compress: "))).toBe(true)

    // The immediate compaction ran BEFORE the round-0 request was built, so
    // the request must carry the compacted first tool_result, not the full
    // 5k-char shell output.
    const round0 = provider.requests[0]
    expect(round0).toBeDefined()
    const toolResults: string[] = []
    for (const m of round0!.messages ?? []) {
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if ((b as { type?: string }).type === "tool_result") {
            toolResults.push(String((b as { content?: string }).content ?? ""))
          }
        }
      }
    }
    expect(toolResults.length).toBeGreaterThan(0)
    expect(toolResults[0]!).toContain("[Microcompact: historical")
  })

  test("forceCompress warning reaches the model in the same round", async () => {
    const provider = new CaptureTextProvider()
    for await (const _event of agentLoop("continue", {
      provider: provider as never,
      model: "test",
      tools: [],
      contextMapPolicy: "off",
      // 24k chars of raw history + prompt puts the raw-only epoch scope in the
      // forceCompress band for contextMaxTokens=20000 (force=22800, rollover=27000).
      conversationHistory: [{ role: "user", content: "x".repeat(24_000) }],
      contextMaxTokens: 20_000,
      maxRounds: 2,
    })) {
      // drain
    }

    expect(provider.requests.length).toBeGreaterThan(0)
    const round0 = provider.requests[0]!.messages
    const hasWarning = round0.some(m =>
      typeof m.content === "string" && m.content.includes("Context Epoch Budget Warning")
    )
    expect(hasWarning).toBe(true)
  })
})

describe("Agent kernel close protocol", () => {
  test("drainPhase propagates consumer close into the phase generator", async () => {
    let phaseFinallyRan = false
    async function* phase(): AsyncGenerator<RunEffect, LoopDecision, unknown> {
      try {
        yield { kind: "stream", event: { type: "status", data: "phase-ready" } }
        await new Promise<void>(() => {}) // hang until closed
      } finally {
        phaseFinallyRan = true
      }
      // Unreachable (the generator hangs until closed); satisfies the return type.
      return { kind: "return", reason: "aborted" }
    }
    const fakeCtx = { runTrace: undefined, runState: {} } as unknown as RunPhaseContext
    const iterator = drainPhase(phase(), fakeCtx)

    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect((first.value as StreamEvent).data).toBe("phase-ready")

    await iterator.return(undefined as never)
    expect(phaseFinallyRan).toBe(true)
  })

  test("wrapEvents forwards stream events and passes through the return value", async () => {
    async function* inner(): AsyncGenerator<StreamEvent, number, unknown> {
      yield { type: "status", data: "inner-1" }
      yield { type: "status", data: "inner-2" }
      return 42
    }
    const wrapped = wrapEvents(inner())
    const kinds: string[] = []
    let returnValue: unknown
    while (true) {
      const step = await wrapped.next()
      if (step.done) {
        returnValue = step.value
        break
      }
      kinds.push(step.value.kind)
    }
    expect(kinds).toEqual(["stream", "stream"])
    expect(returnValue).toBe(42)
  })
})
