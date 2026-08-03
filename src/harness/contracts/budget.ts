/**
 * H0: Budget contract.
 *
 * All resource governance flows through a BudgetLedger using Reserve→Commit so
 * concurrent nodes can never both believe the budget is free. Budget exhaustion
 * must carry an explicit reason, never a vague "max rounds reached".
 */

export interface RunBudget {
  maxWallTimeMs: number
  maxModelCalls: number
  maxToolCalls: number

  maxInputTokens: number
  maxOutputTokens: number
  maxCacheMissTokens: number

  maxWrites: number
  maxExternalActions: number
  maxRepairCycles: number
}

export interface BudgetUsage {
  wallTimeMs: number
  modelCalls: number
  toolCalls: number

  inputTokens: number
  outputTokens: number
  cacheMissTokens: number

  writes: number
  externalActions: number
  repairCycles: number
}

export type BudgetExhaustionReason =
  | "model_call_budget"
  | "tool_call_budget"
  | "token_budget"
  | "wall_time_budget"
  | "write_budget"
  | "external_action_budget"
  | "repair_budget"

export interface BudgetRequest {
  kind: "model_call" | "tool_call" | "write" | "external_action" | "repair"
  estimatedInputTokens?: number
  estimatedOutputTokens?: number
}

export interface BudgetReservation {
  id: string
  kind: BudgetRequest["kind"]
  reservedAt: number
}

/** A pure ledger — implementations live in src/harness/runtime (H4). */
export interface BudgetLedger {
  limits: RunBudget
  used: BudgetUsage

  reserve(request: BudgetRequest): BudgetReservation
  commit(reservationId: string, actual: BudgetUsage): void
  release(reservationId: string): void
  remaining(): BudgetUsage
}
