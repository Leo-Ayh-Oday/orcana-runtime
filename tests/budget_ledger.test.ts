import { describe, expect, test } from "bun:test"
import { HarnessError } from "../src/harness/contracts/errors"
import { createBudgetLedger, defaultRunBudget, mergeRunBudget } from "../src/harness/runtime/budget-ledger"

// H4: BudgetLedger Reserve → Commit semantics — exhaustion carries an
// explicit reason, release restores capacity, commits are idempotent.

describe("BudgetLedger", () => {
  test("reserve/commit counts units and tokens", () => {
    const ledger = createBudgetLedger(mergeRunBudget({ maxModelCalls: 10, maxInputTokens: 1000 }))
    const reservation = ledger.reserve({ kind: "model_call", estimatedInputTokens: 100 })
    ledger.commit(reservation.id, {
      wallTimeMs: 0,
      modelCalls: 0,
      toolCalls: 0,
      inputTokens: 250,
      outputTokens: 50,
      cacheMissTokens: 0,
      writes: 0,
      externalActions: 0,
      repairCycles: 0,
    })
    expect(ledger.used.modelCalls).toBe(1)
    expect(ledger.used.inputTokens).toBe(250)
    expect(ledger.used.outputTokens).toBe(50)
    expect(ledger.remaining().modelCalls).toBe(9)
    expect(ledger.remaining().inputTokens).toBe(750)
  })

  test("reserve throws budget_exhausted with explicit reason at the limit", () => {
    const ledger = createBudgetLedger(mergeRunBudget({ maxToolCalls: 1 }))
    const first = ledger.reserve({ kind: "tool_call" })
    ledger.commit(first.id, {
      wallTimeMs: 0, modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0,
      cacheMissTokens: 0, writes: 0, externalActions: 0, repairCycles: 0,
    })
    expect(() => ledger.reserve({ kind: "tool_call" })).toThrow(HarnessError)
    try {
      ledger.reserve({ kind: "tool_call" })
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessError)
      expect((error as HarnessError).kind).toBe("budget_exhausted")
      expect((error as HarnessError).message).toContain("tool_call_budget")
    }
  })

  test("concurrent pending reservations count against the limit", () => {
    const ledger = createBudgetLedger(mergeRunBudget({ maxModelCalls: 2 }))
    const a = ledger.reserve({ kind: "model_call" })
    const b = ledger.reserve({ kind: "model_call" })
    expect(() => ledger.reserve({ kind: "model_call" })).toThrow(/model_call_budget/)
    ledger.release(a.id)
    // Capacity restored after release.
    const c = ledger.reserve({ kind: "model_call" })
    ledger.commit(b.id, {
      wallTimeMs: 0, modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0,
      cacheMissTokens: 0, writes: 0, externalActions: 0, repairCycles: 0,
    })
    ledger.commit(c.id, {
      wallTimeMs: 0, modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0,
      cacheMissTokens: 0, writes: 0, externalActions: 0, repairCycles: 0,
    })
    expect(ledger.used.modelCalls).toBe(2)
  })

  test("token limit exhaustion throws on commit", () => {
    const ledger = createBudgetLedger(mergeRunBudget({ maxInputTokens: 100 }))
    const reservation = ledger.reserve({ kind: "model_call" })
    expect(() => ledger.commit(reservation.id, {
      wallTimeMs: 0, modelCalls: 0, toolCalls: 0, inputTokens: 500, outputTokens: 0,
      cacheMissTokens: 0, writes: 0, externalActions: 0, repairCycles: 0,
    })).toThrow(/token_budget/)
  })

  test("commit and release are idempotent", () => {
    const ledger = createBudgetLedger(mergeRunBudget(undefined))
    const reservation = ledger.reserve({ kind: "tool_call" })
    ledger.commit(reservation.id, {
      wallTimeMs: 0, modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0,
      cacheMissTokens: 0, writes: 0, externalActions: 0, repairCycles: 0,
    })
    ledger.commit(reservation.id, {
      wallTimeMs: 0, modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0,
      cacheMissTokens: 0, writes: 0, externalActions: 0, repairCycles: 0,
    })
    expect(ledger.used.toolCalls).toBe(1)
    ledger.release("does-not-exist")
    expect(ledger.used.toolCalls).toBe(1)
  })

  test("defaultRunBudget is unlimited; mergeRunBudget overrides fields", () => {
    const defaults = defaultRunBudget()
    expect(defaults.maxModelCalls).toBe(Number.MAX_SAFE_INTEGER)
    const merged = mergeRunBudget({ maxModelCalls: 3 })
    expect(merged.maxModelCalls).toBe(3)
    expect(merged.maxToolCalls).toBe(Number.MAX_SAFE_INTEGER)
  })
})
