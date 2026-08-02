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
 *  write / external_action / repair are reserved-capable in the ledger but
 *  not wired here — kernel events don't classify tools yet (H8/H9).
 */

import { HarnessError } from "../contracts/errors"
import type { BudgetExhaustionReason, BudgetLedger, BudgetRequest } from "../contracts/budget"
import type { HarnessEvent } from "../contracts/events"

interface UsagePayload {
  round?: number
  cacheSource?: string
  inputTokens?: number
  outputTokens?: number
  cacheMissInputTokens?: number
}

export class BudgetGuard {
  private readonly seenRounds = new Set<number>()

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
      return this.consume({ kind: "tool_call" })
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
    used.inputTokens += usage.inputTokens ?? 0
    used.outputTokens += usage.outputTokens ?? 0
    used.cacheMissTokens += usage.cacheMissInputTokens ?? 0
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
