/** Gate 7: Context Budget — graduated context-pressure policy (GATE-05).
 *
 *  GATE-05 (§十三): the static 60% hard block is gone. A runtime with
 *  epoch/compaction capability escalates instead:
 *    0.50–0.65  degraded      — continue current stage only (suggestion)
 *    0.65–0.80  compact       — proactive compaction requested
 *    0.80–0.90  aggressive    — aggressive reduction demanded
 *    >= 0.90    CONTEXT_EXHAUSTED — hard block (next call could not
 *               guarantee minimum action/context reserve)
 *
 *  Env overrides:
 *    ORCANA_CONTEXT_WARN_RATIO   (default 0.5)
 *    ORCANA_CONTEXT_BLOCK_RATIO  (default 0.9) — hard safety line
 */

import type { Gate, GateResult } from "./types"
import type { PreRoundContext } from "./contexts"

export type ContextBudgetMode = "normal" | "degraded" | "compact" | "aggressive" | "block"

export class ContextBudgetGate implements Gate<PreRoundContext> {
  readonly name = "policy:context_budget"

  private warnRatio: number
  private compactRatio: number
  private aggressiveRatio: number
  private blockRatio: number

  constructor(warnRatio?: number, blockRatio?: number) {
    this.warnRatio = warnRatio ?? envRatio("ORCANA_CONTEXT_WARN_RATIO", 0.5)
    this.compactRatio = 0.65
    this.aggressiveRatio = 0.8
    this.blockRatio = blockRatio ?? envRatio("ORCANA_CONTEXT_BLOCK_RATIO", 0.9)
  }

  evaluate(ctx: PreRoundContext): GateResult {
    const ratio = ctx.roundInputTokens / ctx.contextMax
    const percent = Math.round(ratio * 100)
    ctx.contextBudgetPercent = percent

    // 硬门只存在于：下一次调用已无法保证最小 action/context reserve。
    if (ratio >= this.blockRatio) {
      ctx.contextBudgetMode = "block"
      return {
        pass: false,
        reason: "context_budget_block",
        message: `Context exhausted (${percent}%). Compaction cannot guarantee a working envelope — start a fresh continuation.`,
      }
    }

    const mode: ContextBudgetMode = ratio >= this.aggressiveRatio
      ? "aggressive"
      : ratio >= this.compactRatio
        ? "compact"
        : ratio >= this.warnRatio
          ? "degraded"
          : "normal"
    ctx.contextBudgetMode = mode

    if (mode === "aggressive") {
      ctx.budgetMessage = {
        role: "user",
        content: [
          "## Context Budget Guard — 激进削减",
          `当前请求已使用约 ${percent}% 的上下文窗口。`,
          "立即停止任何扩大范围的行为。本轮只允许最小原子动作。",
          "本轮结束后必须触发主动压缩（compaction/epoch rollover），否则下一次调用可能无法保证动作空间。",
        ].join("\n"),
      }
    } else if (mode === "compact") {
      ctx.budgetMessage = {
        role: "user",
        content: [
          "## Context Budget Guard — 主动压缩",
          `当前请求已使用约 ${percent}% 的上下文窗口。`,
          "继续当前原子阶段，不要引入新工作；本轮结束后执行主动压缩。",
          "不要启动大范围搜索或多阶段重写。",
        ].join("\n"),
      }
    } else if (mode === "degraded") {
      ctx.budgetMessage = {
        role: "user",
        content: [
          "## Context Budget Guard",
          `The current request is using about ${percent}% of the model context window.`,
          "Continue only the current atomic stage. Do not expand scope, do not start broad exploration, and do not introduce new optional work.",
          "If the next step would require a large new search, many new files, or a multi-stage rewrite, stop after the current checkpoint and ask for compaction or a fresh continuation.",
        ].join("\n"),
      }
    } else {
      ctx.budgetMessage = null
    }
    return { pass: true }
  }
}

function envRatio(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : fallback
}
