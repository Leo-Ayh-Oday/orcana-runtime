import { afterAll, describe, expect, test } from "bun:test"
import { createAgentHarness } from "../src/harness/runtime/agent-harness"
import type { HarnessEvent } from "../src/harness/contracts/events"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { buildTools, Result } from "../src/tools/registry"

// H4 acceptance: budget exhaustion cancels the run with an explicit reason
// and no further events are emitted after cancellation; a healthy run never
// trips the budget.

const SAVED_DEEPSEEK_FLASH_TRIAGE = process.env.DEEPSEEK_FLASH_TRIAGE
process.env.DEEPSEEK_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_DEEPSEEK_FLASH_TRIAGE === undefined) delete process.env.DEEPSEEK_FLASH_TRIAGE
  else process.env.DEEPSEEK_FLASH_TRIAGE = SAVED_DEEPSEEK_FLASH_TRIAGE
})

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

/** Every round: one tool call + provider usage (drives model/tool/token guards). */
class ToolEachRoundProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    const round = this.rounds++
    yield {
      type: "token_usage",
      data: { inputTokens: 100, outputTokens: 20, cacheSource: "provider", round },
    }
    yield { type: "tool_call", data: { id: `probe-${round}`, name: "baseline_probe", input: {} } }
  }
}

class ProbeThenTextProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield {
        type: "token_usage",
        data: { inputTokens: 100, outputTokens: 20, cacheSource: "provider", round: 0 },
      }
      yield { type: "tool_call", data: { id: "probe-1", name: "baseline_probe", input: {} } }
      return
    }
    yield { type: "text", data: "budget ok" }
  }
}

class HangProvider implements LLMProvider {
  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    yield { type: "status", data: "provider-ready" }
    await new Promise<void>(() => {})
  }
}

async function runForOutcome(
  deps: Parameters<typeof createAgentHarness>[0]["deps"],
  input: { prompt: string; maxRounds?: number; budget?: Record<string, number>; metadata?: Record<string, unknown> },
  sessionId = "sess-budget",
): Promise<{ status: string; reason?: string; events: HarnessEvent[]; budgetLimits: Record<string, number> }> {
  const harness = createAgentHarness({ deps, sessionId })
  const session = await harness.createSession()
  const events: HarnessEvent[] = []
  for await (const event of harness.run(session.sessionId, input as never)) {
    events.push(event)
  }
  const snapshot = await harness.inspect(events[0]!.runId)
  return {
    status: snapshot.status,
    reason: snapshot.outcome?.kind === "cancelled" ? snapshot.outcome.reason : undefined,
    events,
    budgetLimits: (snapshot.budgetState as { limits: Record<string, number> }).limits,
  }
}

describe("Harness H4 budget enforcement", () => {
  test("model call budget exhausted cancels with explicit reason and no further events", async () => {
    const result = await runForOutcome(
      { provider: new ToolEachRoundProvider(), tools: probeTool() },
      { prompt: "inspect the project", maxRounds: 5, budget: { maxModelCalls: 1 } },
    )
    expect(result.status).toBe("cancelled")
    expect(result.reason).toBe("model_call_budget")
    // Round 0 consumed the only model call; round 1's tool call never
    // surfaces — no events after cancellation.
    const toolCalls = result.events.filter(e => "toolCall" in e.payload)
    expect(toolCalls).toHaveLength(1)
    const last = result.events[result.events.length - 1]!
    expect(last.type).toBe("run.cancelled")
  })

  test("tool call budget exhausted cancels with tool_call_budget", async () => {
    const result = await runForOutcome(
      { provider: new ToolEachRoundProvider(), tools: probeTool() },
      { prompt: "inspect the project", maxRounds: 5, budget: { maxToolCalls: 1 } },
    )
    expect(result.status).toBe("cancelled")
    expect(result.reason).toBe("tool_call_budget")
    const toolCalls = result.events.filter(e => "toolCall" in e.payload)
    expect(toolCalls).toHaveLength(1)
  })

  test("token budget exhausted cancels with token_budget", async () => {
    const result = await runForOutcome(
      { provider: new ToolEachRoundProvider(), tools: probeTool() },
      { prompt: "inspect the project", maxRounds: 5, budget: { maxInputTokens: 50 } },
    )
    expect(result.status).toBe("cancelled")
    expect(result.reason).toBe("token_budget")
  })

  test("wall time budget cancels a stuck run with wall_time_budget", async () => {
    const harness = createAgentHarness({
      deps: { provider: new HangProvider(), tools: [] },
      sessionId: "sess-wall",
    })
    const session = await harness.createSession()
    const events: HarnessEvent[] = []
    for await (const event of harness.run(session.sessionId, {
      prompt: "inspect",
      maxRounds: 10,
      budget: { maxWallTimeMs: 50 },
    } as never)) {
      events.push(event)
    }
    expect(events.length).toBeGreaterThan(0)
    const snapshot = await harness.inspect(events[0]!.runId)
    expect(snapshot.status).toBe("cancelled")
    if (snapshot.outcome?.kind === "cancelled") {
      expect(snapshot.outcome.reason).toBe("wall_time_budget")
    }
  })

  test("maxRounds maps to maxModelCalls when no explicit budget is given", async () => {
    // maxRounds=2 → maxModelCalls=2: two rounds consume exactly 2 model
    // calls, then the run ends naturally on the round budget (no trip).
    const result = await runForOutcome(
      { provider: new ToolEachRoundProvider(), tools: probeTool() },
      { prompt: "inspect the project", maxRounds: 2 },
    )
    expect(result.budgetLimits.maxModelCalls).toBe(2)
    expect(result.status).toBe("paused")
    expect(result.reason).toBeUndefined()
    // Explicit budget overrides the mapping.
    const overridden = await runForOutcome(
      { provider: new ToolEachRoundProvider(), tools: probeTool() },
      { prompt: "inspect the project", maxRounds: 5, budget: { maxModelCalls: 3 } },
      "sess-budget-over",
    )
    expect(overridden.budgetLimits.maxModelCalls).toBe(3)
    expect(overridden.status).toBe("cancelled")
    expect(overridden.reason).toBe("model_call_budget")
  })

  test("a healthy run completes without tripping the budget", async () => {
    const result = await runForOutcome(
      { provider: new ProbeThenTextProvider(), tools: probeTool() },
      { prompt: "Read only: probe and summarize. Do not edit.", maxRounds: 5, budget: { maxModelCalls: 5, maxToolCalls: 5 } },
    )
    expect(result.status).toBe("completed")
    expect(result.reason).toBeUndefined()
    const texts = result.events.filter(e => "text" in e.payload)
    expect(texts).toHaveLength(1)
  })
})
