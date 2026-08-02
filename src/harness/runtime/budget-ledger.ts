/** BudgetLedger (H4): Reserve → Commit resource governance.
 *
 *  Implements the H0 contract (contracts/budget.ts). A reservation claims
 *  capacity for one unit of a kind before the work starts; commit() records
 *  the actual usage and validates token limits; release() undoes a
 *  reservation on failure. Exhaustion always throws HarnessError with an
 *  explicit BudgetExhaustionReason — never a vague "max rounds reached".
 *
 *  H4 hooks model/tool/token/wall-time. write/external_action/repair are
 *  reserved-capable but not yet wired to kernel events (H8/H9 classify
 *  tools); their limits default to unlimited.
 */

import { randomUUID } from "node:crypto"
import { HarnessError } from "../contracts/errors"
import type {
  BudgetExhaustionReason,
  BudgetLedger,
  BudgetRequest,
  BudgetReservation,
  BudgetUsage,
  RunBudget,
} from "../contracts/budget"

/** Limits used when a field is not provided (unlimited = Number.MAX_SAFE_INTEGER). */
export function defaultRunBudget(): RunBudget {
  return {
    maxWallTimeMs: Number.MAX_SAFE_INTEGER,
    maxModelCalls: Number.MAX_SAFE_INTEGER,
    maxToolCalls: Number.MAX_SAFE_INTEGER,
    maxInputTokens: Number.MAX_SAFE_INTEGER,
    maxOutputTokens: Number.MAX_SAFE_INTEGER,
    maxCacheMissTokens: Number.MAX_SAFE_INTEGER,
    maxWrites: Number.MAX_SAFE_INTEGER,
    maxExternalActions: Number.MAX_SAFE_INTEGER,
    maxRepairCycles: Number.MAX_SAFE_INTEGER,
  }
}

export function mergeRunBudget(overrides: Partial<RunBudget> | undefined): RunBudget {
  const base = defaultRunBudget()
  return overrides ? { ...base, ...overrides } : base
}

function zeroUsage(): BudgetUsage {
  return {
    wallTimeMs: 0,
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheMissTokens: 0,
    writes: 0,
    externalActions: 0,
    repairCycles: 0,
  }
}

function kindReason(kind: BudgetRequest["kind"]): BudgetExhaustionReason {
  switch (kind) {
    case "model_call": return "model_call_budget"
    case "tool_call": return "tool_call_budget"
    case "write": return "write_budget"
    case "external_action": return "external_action_budget"
  }
}

function usedKind(used: BudgetUsage, kind: BudgetRequest["kind"]): number {
  switch (kind) {
    case "model_call": return used.modelCalls
    case "tool_call": return used.toolCalls
    case "write": return used.writes
    case "external_action": return used.externalActions
  }
}

function maxKind(limits: RunBudget, kind: BudgetRequest["kind"]): number {
  switch (kind) {
    case "model_call": return limits.maxModelCalls
    case "tool_call": return limits.maxToolCalls
    case "write": return limits.maxWrites
    case "external_action": return limits.maxExternalActions
  }
}

export function createBudgetLedger(limits: RunBudget): BudgetLedger {
  const used = zeroUsage()
  const reservations = new Map<string, BudgetRequest["kind"]>()

  function remaining(): BudgetUsage {
    return {
      wallTimeMs: Math.max(0, limits.maxWallTimeMs - used.wallTimeMs),
      modelCalls: Math.max(0, limits.maxModelCalls - used.modelCalls),
      toolCalls: Math.max(0, limits.maxToolCalls - used.toolCalls),
      inputTokens: Math.max(0, limits.maxInputTokens - used.inputTokens),
      outputTokens: Math.max(0, limits.maxOutputTokens - used.outputTokens),
      cacheMissTokens: Math.max(0, limits.maxCacheMissTokens - used.cacheMissTokens),
      writes: Math.max(0, limits.maxWrites - used.writes),
      externalActions: Math.max(0, limits.maxExternalActions - used.externalActions),
      repairCycles: Math.max(0, limits.maxRepairCycles - used.repairCycles),
    }
  }

  return {
    limits,
    used,

    reserve(request) {
      const usedCount = usedKind(used, request.kind)
      const pendingCount = [...reservations.values()].filter(k => k === request.kind).length
      const max = maxKind(limits, request.kind)
      if (usedCount + pendingCount >= max) {
        throw new HarnessError("budget_exhausted", `Budget exhausted: ${kindReason(request.kind)}`, undefined)
      }
      const reservation: BudgetReservation = {
        id: randomUUID(),
        kind: request.kind,
        reservedAt: Date.now(),
      }
      reservations.set(reservation.id, reservation.kind)
      return reservation
    },

    commit(reservationId, actual) {
      if (!reservations.has(reservationId)) return
      const kind = reservations.get(reservationId)!
      reservations.delete(reservationId)
      // Count units for the reserved kind.
      switch (kind) {
        case "model_call": used.modelCalls += 1; break
        case "tool_call": used.toolCalls += 1; break
        case "write": used.writes += 1; break
        case "external_action": used.externalActions += 1; break
      }
      // Actual token/wall-time usage (validated against limits).
      used.wallTimeMs = Math.max(used.wallTimeMs, actual.wallTimeMs ?? 0)
      used.inputTokens += actual.inputTokens ?? 0
      used.outputTokens += actual.outputTokens ?? 0
      used.cacheMissTokens += actual.cacheMissTokens ?? 0
      if (used.inputTokens > limits.maxInputTokens) {
        throw new HarnessError("budget_exhausted", "Budget exhausted: token_budget (input)", undefined)
      }
      if (used.outputTokens > limits.maxOutputTokens) {
        throw new HarnessError("budget_exhausted", "Budget exhausted: token_budget (output)", undefined)
      }
      if (used.cacheMissTokens > limits.maxCacheMissTokens) {
        throw new HarnessError("budget_exhausted", "Budget exhausted: token_budget (cache miss)", undefined)
      }
      if (used.wallTimeMs > limits.maxWallTimeMs) {
        throw new HarnessError("budget_exhausted", "Budget exhausted: wall_time_budget", undefined)
      }
    },

    release(reservationId) {
      reservations.delete(reservationId)
    },

    remaining,
  }
}
