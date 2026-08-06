/** BudgetGuard (H4): harness-layer budget enforcement over the event stream.
 *
 *  Observes bridged HarnessEvents and consumes the run's BudgetLedger:
 *    - model calls: provider-sourced model.usage events (cacheSource
 *      "provider", round-deduplicated — the kernel emits one final usage
 *      event per round);
 *    - tool calls: tool.call.requested events;
 *    - tokens: input/output/cache-miss from the same provider usage events.
 *
 *  On exhaustion the run's cancellation is triggered with the explicit
 *  BudgetExhaustionReason and observe() returns false so the event loop
 *  stops immediately (no further events are emitted after cancellation).
 *
 *  H9: tool call events carry the capability sideEffect classification, so
 *  write / external_action budgets are consumed alongside tool_call. repair
 *  stays unwired until a repair-cycle fact source exists in the event stream.
 */

import { HarnessError } from "../contracts/errors"
import type { BudgetExhaustionReason, BudgetLedger, BudgetRequest } from "../contracts/budget"
import type { HarnessEvent } from "../contracts/events"
import type { SideEffect } from "../contracts/capability"

interface UsagePayload {
  round?: number
  cacheSource?: string
  inputTokens?: number
  outputTokens?: number
  cacheMissInputTokens?: number
}

export class BudgetGuard {
  private readonly seenRounds = new Set<number>()
  // H12: the kernel's provider usage events are CUMULATIVE snapshots — round N
  // carries rounds 1..N totals for input, output AND cache-miss tokens (the
  // kernel accumulates all three across rounds). Token accounting therefore
  // takes deltas against the last seen value instead of adding blindly (which
  // double-counted on the cumulative stream).
  private lastInputTokens = 0
  private lastOutputTokens = 0
  private lastCacheMissTokens = 0

  constructor(
    private readonly ledger: BudgetLedger,
    private readonly abort: (reason: string) => void,
  ) {}

  /** Observe one event. Returns false when the budget is exhausted (abort fired). */
  observe(event: HarnessEvent): boolean {
    const payload = event.payload
    if ("usage" in payload) {
      return this.observeUsage(payload.usage as UsagePayload)
    }
    if ("toolCall" in payload) {
      if (!this.consume({ kind: "tool_call" })) return false
      // H9: capability classification on the bridged event drives the
      // write / external_action class limits (same descriptor source as the
      // CapabilityExecutor — no double counting).
      const sideEffect: SideEffect | undefined = payload.toolCall.sideEffect
      if (sideEffect === "write") return this.consume({ kind: "write" })
      if (sideEffect === "external") return this.consume({ kind: "external_action" })
      return true
    }
    return true
  }

  private observeUsage(usage: UsagePayload): boolean {
    // Model calls: the round's FIRST usage event (estimate or provider) —
    // the kernel emits an estimate before the provider-final usage, so
    // counting on the first event trips the guard before any tool of that
    // round surfaces (no events after cancellation).
    if (typeof usage.round !== "number" || this.seenRounds.has(usage.round)) {
      return this.observeTokens(usage)
    }
    this.seenRounds.add(usage.round)
    if (!this.consume({ kind: "model_call" })) return false
    return this.observeTokens(usage)
  }

  private observeTokens(usage: UsagePayload): boolean {
    // Tokens only from provider-sourced final usage; written directly to the
    // ledger's used counters with an explicit limit check (the ledger's own
    // token validation applies to direct commit() callers).
    if (usage.cacheSource !== "provider") return true
    const used = this.ledger.used
    // H12: cumulative snapshots → delta accounting. Scripted/fixed providers
    // that emit per-round values still work: current >= last keeps the sum.
    const input = usage.inputTokens ?? 0
    const output = usage.outputTokens ?? 0
    const cacheMiss = usage.cacheMissInputTokens ?? 0
    used.inputTokens += Math.max(0, input - this.lastInputTokens)
    used.outputTokens += Math.max(0, output - this.lastOutputTokens)
    used.cacheMissTokens += Math.max(0, cacheMiss - this.lastCacheMissTokens)
    this.lastInputTokens = Math.max(this.lastInputTokens, input)
    this.lastOutputTokens = Math.max(this.lastOutputTokens, output)
    this.lastCacheMissTokens = Math.max(this.lastCacheMissTokens, cacheMiss)
    if (used.inputTokens > this.ledger.limits.maxInputTokens
      || used.outputTokens > this.ledger.limits.maxOutputTokens
      || used.cacheMissTokens > this.ledger.limits.maxCacheMissTokens) {
      this.abort("token_budget")
      return false
    }
    return true
  }

  private consume(request: BudgetRequest): boolean {
    try {
      const reservation = this.ledger.reserve(request)
      this.ledger.commit(reservation.id, {
        wallTimeMs: 0,
        modelCalls: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheMissTokens: 0,
        writes: 0,
        externalActions: 0,
        repairCycles: 0,
      })
      return true
    } catch (error) {
      if (error instanceof HarnessError && error.kind === "budget_exhausted") {
        this.abort(budgetReasonFromMessage(error.message))
        return false
      }
      throw error
    }
  }
}

function budgetReasonFromMessage(message: string): BudgetExhaustionReason {
  for (const reason of [
    "model_call_budget",
    "tool_call_budget",
    "token_budget",
    "wall_time_budget",
    "write_budget",
    "external_action_budget",
    "repair_budget",
  ] as const) {
    if (message.includes(reason)) return reason
  }
  return "model_call_budget"
}
