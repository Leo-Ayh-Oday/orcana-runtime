import { describe, expect, test } from "bun:test"
import { BudgetGuard } from "../src/harness/runtime/budget-guard"
import { createBudgetLedger, mergeRunBudget } from "../src/harness/runtime/budget-ledger"
import { HARNESS_EVENT_TYPES } from "../src/harness/contracts/events"
import type { HarnessEvent } from "../src/harness/contracts/events"

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
