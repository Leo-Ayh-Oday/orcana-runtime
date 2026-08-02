import { afterAll, describe, expect, test } from "bun:test"
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

const SAVED_DEEPSEEK_FLASH_TRIAGE = process.env.DEEPSEEK_FLASH_TRIAGE
process.env.DEEPSEEK_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_DEEPSEEK_FLASH_TRIAGE === undefined) delete process.env.DEEPSEEK_FLASH_TRIAGE
  else process.env.DEEPSEEK_FLASH_TRIAGE = SAVED_DEEPSEEK_FLASH_TRIAGE
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
