/** Reasoning router - decides thinking mode, depth, and token budget per round.
 *
 * Silent work should happen inside provider thinking mode. The loop only
 * decides when deeper model-internal reasoning is justified.
 */

import type { ThinkingConfig } from "../provider/types"
import type { IntentMode } from "./intent"

const READONLY_TOOLS = new Set([
  "read_file", "find_symbol", "find_references", "project_structure",
  "read_definition", "web_search", "git_status", "git_diff", "git_log", "git_blame",
  "request_deeper_thinking",
])

export interface RoundState {
  roundNum: number
  priorTools: string[]
  priorFiles: Set<string>
  hadError: boolean
  hadFim: boolean
}

export interface ThinkingProfile {
  prompt?: string
  intentMode?: IntentMode
  planningPhase?: boolean
  contextUsagePercent?: number
  /** Objective auto-max triggers (model self-upgrade signal) */
  autoMaxSignals?: AutoMaxSignals
  /**
   * GATE-02: response budget stage. Decides the action-token reserve that
   * must survive thinking. Errors push the run into recovery (reasoning
   * shrinks, action reserve grows) — never into deeper thinking (that was
   * the OTS-013 feedback amplifier).
   */
  stage?: ThinkingStage
  /**
   * GATE-03: ProgressGovernor ACTION_FIRST mode — reasoning is cut to a
   * small budget so the round has room to emit an actual tool call.
   */
  actionFirst?: boolean
}

export type ThinkingStage = "planning" | "execution" | "recovery" | "verification"

/**
 * GATE-02 (GS-04): ResponseBudget invariant.
 *
 * Thinking and tool action share one provider output envelope
 * (max_tokens counts thinking tokens). OTS-013 starved tool calls by pairing
 * a 32K thinking intent with a 6K max_tokens cap: thinking burned the whole
 * envelope, the response truncated before the tool block could be emitted,
 * and the loop retried the same doomed request forever.
 *
 * reasoningCap + actionReserve <= maxTokens  (always)
 *
 * Initial reserves per stage (tunable via benchmark):
 *   planning 25% — the plan itself is cheap, keep room to act on it
 *   execution 40% — the working stage needs the most tool space
 *   recovery  50% — recovery must act, not think
 */
const STAGE_ACTION_RESERVE: Record<ThinkingStage, number> = {
  planning: 0.25,
  execution: 0.4,
  recovery: 0.5,
  verification: 0.4,
}

export interface AutoMaxSignals {
  consecutiveErrors: number
  modifiedFiles: number
}

export interface ThinkingDecision {
  thinking: ThinkingConfig | undefined
  maxTokens: number
  score: number
  reason: string
  factors: string[]
  visibleStatus: string
}

export function createState(): RoundState {
  return { roundNum: 0, priorTools: [], priorFiles: new Set(), hadError: false, hadFim: false }
}

const STRUCTURAL_PATTERNS = [
  /architecture|architectural|runtime|router|provider|agent|tool\s*use|tooling/i,
  /refactor|redesign|migration|cascade|impact|dependency|contract|quality\s*gate/i,
  /ripple|codegraph|lsp|ast|typecheck|compiler|verification|benchmark|eval/i,
  /cache|memory|context|compaction|checkpoint|resume|long[-\s]?task/i,
  /deep\s*thinking|think\s*deep|self[-\s]?critique|self[-\s]?reflect|reorganize|capability/i,
  /security|auth|permission|transaction|rollback|database|api|full[-\s]?stack/i,
  /架构|重构|运行时|推理|深度思考|深思|反思|自我反驳|自我推翻|重组|能力|测试|验证/i,
  /缓存|记忆|上下文|全栈|多文件|长任务/i,
]

const BROAD_SCOPE_PATTERNS = [
  /complete|entire|whole|end[-\s]?to[-\s]?end|production|project/i,
  /optimi[sz]e|improve|harden|stabili[sz]e|quality|polish/i,
  /完整|整个|生产|优化|深化|稳定|质量/i,
]

function matchCount(patterns: RegExp[], text: string): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0)
}

function scoreThinkingNeed(state: RoundState, profile?: ThinkingProfile): { score: number; factors: string[] } {
  const factors: string[] = []
  let score = 0
  const prompt = profile?.prompt?.trim() ?? ""

  if (/深度思考|深度分析|深思|认真思考|仔细思考|推演|反方|反驳|自我推翻|推翻自己|重组自己|智能体.*能力|agent.*capability/i.test(prompt)) {
    score += 7
    factors.push("明确要求深思")
  }

  if (profile?.intentMode === "long_task") {
    score += 5
    factors.push("长任务")
  }
  if (profile?.planningPhase) {
    score += 8
    factors.push("规划阶段（高优先级）")
  }
  if (prompt.length > 300) {
    score += 1
    factors.push("非简单问题")
  }
  if (prompt.length > 1200) {
    score += 2
    factors.push("长提示词")
  }

  const structural = matchCount(STRUCTURAL_PATTERNS, prompt)
  if (structural > 0) {
    score += Math.min(6, structural * 2)
    factors.push(`结构信号 x${structural}`)
  }

  const broad = matchCount(BROAD_SCOPE_PATTERNS, prompt)
  if (broad > 0) {
    score += Math.min(3, broad)
    factors.push(`范围较大 x${broad}`)
  }

  if (state.hadError) {
    score += 4
    factors.push("前轮有错误")
  }
  if (state.hadFim) {
    score += 4
    factors.push("FIM 编辑")
  }
  if (state.priorFiles.size >= 3) {
    score += 3
    factors.push(`多文件影响 ${state.priorFiles.size}`)
  } else if (state.priorFiles.size >= 2) {
    score += 1
    factors.push("双文件影响")
  }

  const hadWrite = state.priorTools.some(tool => !READONLY_TOOLS.has(tool))
  if (hadWrite) {
    score += 2
    factors.push("已经写入")
  }

  if (typeof profile?.contextUsagePercent === "number" && profile.contextUsagePercent >= 50) {
    score += 2
    factors.push(`上下文 ${profile.contextUsagePercent}%`)
  }

  return { score, factors }
}

export function decideThinkingPlan(
  state: RoundState,
  effortOverride?: "high" | "max",
  profile?: ThinkingProfile,
): ThinkingDecision {
  const { score, factors } = scoreThinkingNeed(state, profile)
  const hadWrite = state.priorTools.some(tool => !READONLY_TOOLS.has(tool))
  const readonlyOnly = state.priorTools.length > 0 && !hadWrite

  // ── Objective auto-max: broad edits may justify deeper thinking, error
  // cascades must NOT (GATE-02). Errors ≥3 used to force max thinking here —
  // that was the OTS-013 amplifier: truncation → error → deeper thinking →
  // more truncation. Error-rich runs now route to the recovery stage, which
  // shrinks reasoning and grows the action reserve instead. ──
  const autoMax = profile?.autoMaxSignals
  const forceMax = profile?.intentMode !== "readonly" && (autoMax?.modifiedFiles ?? 0) >= 5
  if (forceMax && effortOverride !== "high") {
    const bounded = applyResponseBudget({ type: "enabled", budget_tokens: 32768, effort: "max" }, state, profile)
    return {
      thinking: bounded.thinking,
      maxTokens: bounded.maxTokens,
      score: Math.max(score, 11),
      reason: `auto-max: ${autoMax!.modifiedFiles} files`,
      factors: [...factors, "auto-max"],
      visibleStatus: `深度思考：最高 ${Math.round((bounded.thinking.budget_tokens ?? 0) / 1024)}K · auto-max · ${autoMax!.modifiedFiles} files`,
    }
  }

  const complexFirstRound = state.roundNum === 0 && score >= (profile?.intentMode === "readonly" ? 7 : 6)

  if (!complexFirstRound) {
    if (state.roundNum === 0) return noThinkingDecision(state, score, factors, "简单首轮")
    if (state.priorTools.length === 0) return noThinkingDecision(state, score, factors, "没有工具信号")
    if (readonlyOnly && score < 7) return noThinkingDecision(state, score, factors, "简单只读路径")
  }

  let thinking: ThinkingConfig
  let reason = "聚焦编辑"

  if (effortOverride === "max" || score >= 11) {
    thinking = { type: "enabled", budget_tokens: 32768, effort: "max" }
    reason = score >= 11 ? "深度结构预检" : "手动最高深度"
  } else if (state.hadFim || state.hadError || state.priorFiles.size >= 3 || score >= 6) {
    thinking = { type: "enabled", budget_tokens: 16384, effort: effortOverride ?? "max" }
    reason = "结构或修复路径"
  } else {
    thinking = { type: "enabled", budget_tokens: 8192, effort: effortOverride ?? "high" }
  }

  const bounded = applyResponseBudget(thinking, state, profile)

  return {
    thinking: bounded.thinking,
    maxTokens: bounded.maxTokens,
    score,
    reason,
    factors,
    visibleStatus: formatThinkingStatus(bounded.thinking, score, reason, factors),
  }
}

/**
 * GATE-02: apply the ResponseBudget invariant to a thinking intent.
 *
 * The provider output envelope (maxTokens) is fixed first, then the thinking
 * budget is capped so `reasoningCap + actionReserve <= maxTokens` always
 * holds. Without this, a 32K thinking intent paired with a 6K cap lets
 * thinking burn the entire envelope and starve tool emission (OTS-013).
 */
function applyResponseBudget(
  thinking: ThinkingConfig,
  state: RoundState,
  profile?: ThinkingProfile,
): { thinking: ThinkingConfig; maxTokens: number } {
  const maxTokens = decideMaxTokens(thinking, state)
  const stage = profile?.stage ?? (state.hadError ? "recovery" : "execution")
  const reserve = STAGE_ACTION_RESERVE[stage]
  let reasoningCap = Math.floor(maxTokens * (1 - reserve))
  // GATE-03: ACTION_FIRST 模式下思考预算压到 2K——本轮必须发出工具调用，
  // 深度思考不是进展。
  if (profile?.actionFirst) reasoningCap = Math.min(reasoningCap, 2048)
  if (thinking.budget_tokens && thinking.budget_tokens > reasoningCap) {
    return { thinking: { ...thinking, budget_tokens: reasoningCap }, maxTokens }
  }
  return { thinking, maxTokens }
}

function noThinkingDecision(
  state: RoundState,
  score: number,
  factors: string[],
  reason: string,
): ThinkingDecision {
  return {
    thinking: undefined,
    maxTokens: decideMaxTokens(undefined, state),
    score,
    reason,
    factors,
    visibleStatus: "思考中",
  }
}

function formatThinkingStatus(thinking: ThinkingConfig, score: number, reason: string, factors: string[]): string {
  const budget = thinking.budget_tokens ? `${Math.round(thinking.budget_tokens / 1024)}k` : "auto"
  const effort = thinking.effort === "max" ? "最高" : "高"
  const factorText = factors.slice(0, 3).join("，") || "模型预检"
  return `深度思考：${effort} ${budget} · ${reason} · ${factorText} · 分数 ${score}`
}

export function decideThinking(
  state: RoundState,
  effortOverride?: "high" | "max",
  profile?: ThinkingProfile,
): ThinkingConfig | undefined {
  return decideThinkingPlan(state, effortOverride, profile).thinking
}

export function decideMaxTokens(thinking: ThinkingConfig | undefined, state: RoundState): number {
  // GATE-02: maxTokens is the full output envelope (thinking + text + tool
  // input all count against it). The old caps (6144 @ 32K thinking intent)
  // made the envelope smaller than the thinking budget it was supposed to
  // contain — truncation was structural. Envelopes now leave room for the
  // stage action reserve inside applyResponseBudget.
  if (state.hadFim) return 8192
  if (state.priorTools.includes("write_file")) return 16384
  if (thinking?.budget_tokens && thinking.budget_tokens >= 16384) return 16384
  if (thinking) return 12288
  return 4096
}

export function updateState(state: RoundState, toolNames: string[], filePaths: string[], hadError: boolean): void {
  state.roundNum++
  state.priorTools = toolNames
  state.priorFiles = new Set(filePaths)
  state.hadError = hadError
  state.hadFim = toolNames.includes("edit_fim")
}
