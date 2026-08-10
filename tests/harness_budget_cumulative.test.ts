import { afterAll, describe, expect, test } from "bun:test"
import { BudgetGuard } from "../src/harness/runtime/budget-guard"
import { createBudgetLedger, mergeRunBudget } from "../src/harness/runtime/budget-ledger"
import { HARNESS_EVENT_TYPES } from "../src/harness/contracts/events"
import type { HarnessEvent } from "../src/harness/contracts/events"
import { createAgentHarness } from "../src/harness/runtime/agent-harness"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { buildTools, Result } from "../src/tools/registry"

const SAVED_ORCANA_FLASH_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
process.env.ORCANA_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_ORCANA_FLASH_TRIAGE === undefined) delete process.env.ORCANA_FLASH_TRIAGE
  else process.env.ORCANA_FLASH_TRIAGE = SAVED_ORCANA_FLASH_TRIAGE
})

// H12: the kernel's provider usage events are CUMULATIVE snapshots (round N
// carries rounds 1..N). The guard must account deltas, not blind sums —
// otherwise tokens double-count on real kernel streams.

function usageEvent(round: number, inputTokens: number, outputTokens: number, cacheMiss = 0): HarnessEvent {
  return {
    schemaVersion: 1,
    eventId: `u-${round}`,
    sequence: round,
    runId: "run",
    sessionId: "s",
    type: HARNESS_EVENT_TYPES.modelUsage,
    timestamp: new Date().toISOString(),
    payload: {
      usage: { inputTokens, outputTokens, cacheMissInputTokens: cacheMiss, cacheSource: "provider", round },
    },
  } as HarnessEvent
}

describe("H12 cumulative token accounting", () => {
  test("cumulative snapshots (100 → 200) account 200, not 300", () => {
    const ledger = createBudgetLedger(mergeRunBudget({ maxInputTokens: 10_000 }))
    const guard = new BudgetGuard(ledger, () => {})
    expect(guard.observe(usageEvent(0, 100, 20))).toBe(true)
    expect(ledger.used.inputTokens).toBe(100)
    expect(guard.observe(usageEvent(1, 200, 40))).toBe(true)
    expect(ledger.used.inputTokens).toBe(200)
    expect(ledger.used.outputTokens).toBe(40)
    expect(ledger.used.cacheMissTokens).toBe(0)
  })

  test("fixed-value providers still accumulate after kernel cumulation", () => {
    const ledger = createBudgetLedger(mergeRunBudget({ maxInputTokens: 10_000 }))
    const guard = new BudgetGuard(ledger, () => {})
    // The legacy test providers emit a fixed value per round; the kernel's
    // final usage event cumulates those into 100 → 200, so the guard sees
    // cumulative snapshots and deltas reconstruct the total.
    expect(guard.observe(usageEvent(0, 100, 20))).toBe(true)
    expect(guard.observe(usageEvent(1, 200, 40))).toBe(true)
    expect(ledger.used.inputTokens).toBe(200)
  })

  test("cache miss deltas are accounted too", () => {
    const ledger = createBudgetLedger(mergeRunBudget({ maxInputTokens: 10_000 }))
    const guard = new BudgetGuard(ledger, () => {})
    expect(guard.observe(usageEvent(0, 100, 20, 5))).toBe(true)
    expect(guard.observe(usageEvent(1, 200, 40, 9))).toBe(true)
    expect(ledger.used.cacheMissTokens).toBe(9)
  })

  test("token limit trips on the cumulative value", () => {
    const ledger = createBudgetLedger(mergeRunBudget({ maxInputTokens: 150 }))
    let reason = ""
    const guard = new BudgetGuard(ledger, (r) => { reason = r })
    expect(guard.observe(usageEvent(0, 100, 20))).toBe(true)
    expect(guard.observe(usageEvent(1, 200, 40))).toBe(false)
    expect(reason).toBe("token_budget")
    expect(ledger.used.inputTokens).toBe(200)
  })
})

// ── Real kernel path: a scripted provider with a FIXED per-round cache miss
// runs through the full AgentHarness → LegacyLoopAdapter → kernel stack. The
// kernel's final usage events are cumulative snapshots (round N carries
// rounds 1..N totals for input/output/cache-miss — H12), so the guard's delta
// accounting must reconstruct the run totals exactly. Before the kernel-side
// cache-miss accumulation in round.ts the counter was round-local while
// input/output were cumulative — the guard under-counted the miss tokens.

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

class FixedValueCumulativeProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    const round = this.rounds++
    // The kernel derives round input from cacheRead + cacheMiss when the
    // cache breakdown is reported (round.ts providerRoundInputTokens) — a
    // breakdown provider must report both halves, so 95 read + 5 miss = 100.
    yield {
      type: "token_usage",
      data: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 95, cacheMissInputTokens: 5, cacheSource: "provider", round },
    }
    if (round === 0) {
      yield { type: "tool_call", data: { id: "probe-0", name: "baseline_probe", input: {} } }
      return
    }
    yield { type: "text", data: "budget ok" }
  }
}

async function runThroughHarness(
  deps: Parameters<typeof createAgentHarness>[0]["deps"],
  input: { prompt: string; maxRounds?: number; budget?: Record<string, number> },
  sessionId = "sess-cum-real",
): Promise<{
  status: string
  reason?: string
  used: { inputTokens: number; outputTokens: number; cacheMissTokens: number }
}> {
  const harness = createAgentHarness({ deps, sessionId })
  const session = await harness.createSession()
  const events: HarnessEvent[] = []
  for await (const event of harness.run(session.sessionId, input as never)) {
    events.push(event)
  }
  const snapshot = await harness.inspect(events[0]!.runId)
  const used = (snapshot.budgetState as { used: { inputTokens: number; outputTokens: number; cacheMissTokens: number } }).used
  return {
    status: snapshot.status,
    reason: snapshot.outcome?.kind === "cancelled" ? snapshot.outcome.reason : undefined,
    used,
  }
}

describe("H12 cumulative usage through the real kernel", () => {
  test("fixed per-round provider totals reconstruct exactly (200/40/10)", async () => {
    const result = await runThroughHarness(
      { provider: new FixedValueCumulativeProvider(), tools: probeTool() },
      { prompt: "inspect", maxRounds: 2 },
    )
    expect(result.status).toBe("completed")
    // Round 1's usage event carries the run total (100→200 / 20→40 / 5→10);
    // the guard's deltas must land on the exact run totals.
    expect(result.used.inputTokens).toBe(200)
    expect(result.used.outputTokens).toBe(40)
    expect(result.used.cacheMissTokens).toBe(10)
  })

  test("token limit trips on the cumulative value, not the last round's", async () => {
    const result = await runThroughHarness(
      { provider: new FixedValueCumulativeProvider(), tools: probeTool() },
      { prompt: "inspect", maxRounds: 2, budget: { maxInputTokens: 150 } },
    )
    expect(result.status).toBe("cancelled")
    expect(result.reason).toBe("token_budget")
    expect(result.used.inputTokens).toBe(200)
    expect(result.used.cacheMissTokens).toBe(10)
  })
})
