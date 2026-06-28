/** Gate 7: Context Budget — blocks the loop when context usage exceeds thresholds.
 *
 *  Configurable via env:
 *    DEEPSEEK_CONTEXT_WARN_RATIO  (default 0.5) — degraded mode
 *    DEEPSEEK_CONTEXT_BLOCK_RATIO (default 0.6) — hard block
 */

import type { Gate, GateResult } from "./types"
import type { PreRoundContext } from "./contexts"

export type ContextBudgetMode = "normal" | "degraded" | "block"

export class ContextBudgetGate implements Gate<PreRoundContext> {
  readonly name = "policy:context_budget"

  private warnRatio: number
  private blockRatio: number

  constructor(warnRatio?: number, blockRatio?: number) {
    this.warnRatio = warnRatio ?? envRatio("DEEPSEEK_CONTEXT_WARN_RATIO", 0.5)
    this.blockRatio = blockRatio ?? envRatio("DEEPSEEK_CONTEXT_BLOCK_RATIO", 0.6)
  }

  evaluate(ctx: PreRoundContext): GateResult {
    const ratio = ctx.roundInputTokens / ctx.contextMax
    const percent = Math.round(ratio * 100)
    ctx.contextBudgetPercent = percent

    if (ratio >= this.blockRatio) {
      ctx.contextBudgetMode = "block"
      return {
        pass: false,
        reason: "context_budget_block",
        message: `Context budget exceeded (${percent}%). Compact or start a fresh continuation before more tool use.`,
      }
    }

    const mode: ContextBudgetMode = ratio >= this.warnRatio ? "degraded" : "normal"
    ctx.contextBudgetMode = mode
    ctx.budgetMessage = mode === "degraded"
      ? {
          role: "user",
          content: [
            "## Context Budget Guard",
            `The current request is using about ${percent}% of the model context window.`,
            "Continue only the current atomic stage. Do not expand scope, do not start broad exploration, and do not introduce new optional work.",
            "If the next step would require a large new search, many new files, or a multi-stage rewrite, stop after the current checkpoint and ask for compaction or a fresh continuation.",
          ].join("\n"),
        }
      : null
    return { pass: true }
  }
}

function envRatio(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : fallback
}
