/** Flash Judge — independent completion evaluator using Flash model.
 *
 *  Unlike the regex-based completion-gate, this reads the actual conversation
 *  tail and makes a semantic judgment about whether the task is truly complete.
 *
 *  Design invariants:
 *    - Zero identity bias: Flash has no "skin in the game", unlike the main agent
 *    - Circuit breaker: max 3 evaluations per task (prevents judge-loop)
 *    - Flash-only: deepseek-v4-flash, ~1/10 cost of Pro, no thinking needed
 *    - Structured output: SATISFIED / NOT_SATISFIED (with gaps) / IMPOSSIBLE
 *
 *  Inspired by MiMo Code's Goal/Judge system, adapted for DeepSeek V4 Flash.
 */

import type { LLMProvider, ProviderMessage } from "../provider/types"
import type { VerificationResult } from "../verification/result"
import type { RippleObligation } from "../ripple/obligations"
import type { TaskTracker } from "./task-tracker"
import { shouldSkipProviderPurpose } from "../provider/cost-policy"

// ── Judge input ──

export interface FlashJudgeInput {
  finalText: string
  taskTracker: TaskTracker | null
  missingTaskRequirements: string[]
  pendingRippleObligations: RippleObligation[]
  verificationResults: VerificationResult[]
  changedFiles: string[]
  taskHadWrite: boolean
  toolErrors: number
  round: number
  /** Recent conversation tail (last ~3 user+assistant turns) for context */
  recentTurns: Array<{ role: string; content: string }>
  /** Optional: testimony ledger from previous judge rounds */
  testimonyLedger?: TestimonyLedger
}

export type FlashJudgeVerdict = "SATISFIED" | "NOT_SATISFIED" | "IMPOSSIBLE"

export interface FlashJudgeOutput {
  verdict: FlashJudgeVerdict
  /** Specific gaps the agent must address (only for NOT_SATISFIED) */
  gaps: string[]
  /** What evidence the judge found convincing */
  evidenceFound: string[]
  /** Estimated token cost of judge call */
  tokenCost: number
  /** Raw verdict string for debugging */
  rawVerdict: string
}

// ── Config ──

const MAX_JUDGE_CALLS_PER_TASK = 3
const JUDGE_MODEL = "deepseek-v4-flash"
const JUDGE_MAX_TOKENS = 512

// ── Prompt builder ──

function buildJudgePrompt(input: FlashJudgeInput): string {
  const lines: string[] = [
    "你是独立的完成度评估器。你的任务是判断 AI 编程助手是否真正完成了用户的任务。",
    "",
    "## 你必须输出以下三选一",
    "",
    "SATISFIED — 任务已完成，有验证证据，没有遗漏项",
    "NOT_SATISFIED — 任务未完成，有具体缺口（列出缺口）",
    "IMPOSSIBLE — 任务在当前条件下无法完成，继续尝试无意义",
    "",
    "## 判断标准",
    "",
    "判定 SATISFIED 必须同时满足:",
    "- 有外部验证证据（typecheck 通过 / test 通过 / build 成功）",
    "- 所有必须步骤已完成",
    "- 模型没有在提问式结束（「需要我...吗」「要不要我...」）",
    "- ripple obligations 全部解决",
    "",
    "判定 NOT_SATISFIED 的条件:",
    "- 声称完成但没有运行验证（写了代码但没跑 typecheck/test）",
    "- task tracker 步骤未全部 done",
    "- 模型在向用户提问而非交付结果",
    "- 验证失败但忽略",
    "",
    "判定 IMPOSSIBLE 的条件:",
    "- 工具反复失败且搜索无解",
    "- 用户请求在技术上不可能（如「在一个文件里同时用 React 和 Vue」）",
    "- 缺少必要的外部条件（如没给 API key）",
  ]

  // Task context
  if (input.taskTracker) {
    lines.push("", "## 任务目标", input.taskTracker.goal)
    const stepStatus = input.taskTracker.steps.map(s =>
      `${s.status === "done" ? "✅" : s.status === "failed" ? "❌" : "⬜"} ${s.title} [${s.status}]`
    ).join("\n")
    lines.push("", "## 任务步骤", stepStatus)
  }

  // Missing requirements
  if (input.missingTaskRequirements.length > 0) {
    lines.push("", "## 未完成项", ...input.missingTaskRequirements.map(m => `- ${m}`))
  }

  // Verification evidence
  if (input.verificationResults.length > 0) {
    lines.push("", "## 验证证据")
    for (const v of input.verificationResults) {
      lines.push(`- ${v.kind}: ${v.passed ? "PASS" : "FAIL"}${v.issues > 0 ? ` (${v.issues} issues)` : ""}`)
    }
  } else if (input.taskHadWrite) {
    lines.push("", "## 验证证据", "⚠️ 有文件写入但没有收集验证结果")
  }

  // Ripple obligations
  if (input.pendingRippleObligations.length > 0) {
    lines.push("", "## 待解决 Ripple Obligations", `共 ${input.pendingRippleObligations.length} 项未解决`)
  }

  // Tool errors
  if (input.toolErrors > 0) {
    lines.push("", `## 工具错误: ${input.toolErrors} 次`)
  }

  // Changed files
  if (input.changedFiles.length > 0) {
    lines.push("", `## 变更文件 (${input.changedFiles.length})`, ...input.changedFiles.slice(0, 10).map(f => `- ${f}`))
  }

  // Agent's final claim
  lines.push("", "## Agent 的最终陈述", input.finalText.slice(0, 3000) || "(空)")

  // Recent turns for context
  if (input.recentTurns.length > 0) {
    const recent = input.recentTurns.slice(-6)
    lines.push("", "## 最近对话")
    for (const turn of recent) {
      const label = turn.role === "assistant" ? "Agent" : "用户"
      lines.push(`### ${label}`, turn.content.slice(0, 800))
    }
  }

  // ── Testimony ledger: detect circular promises ──
  const ledger = input.testimonyLedger
  if (ledger && ledger.rounds.length > 0) {
    const circular = ledger.detectCircularPromises()
    if (circular.length > 0) {
      lines.push("", "## 证词账本 — 检测到重复未兑现承诺", ...circular.map(c => `- ⚠️ ${c}`))
      lines.push("", "如果 Agent 在反复承诺同一事项但从未交付，判定为 NOT_SATISFIED。")
    }
    const allEvidence = ledger.allEvidence()
    if (allEvidence.length > 0) {
      lines.push("", "## 历史验证证据", ...allEvidence.slice(0, 10).map(e => `- ✅ ${e}`))
    }
  }

  lines.push("", "## 输出格式", "严格输出 JSON，不要其他文字：")
  lines.push("", '{"verdict":"SATISFIED|NOT_SATISFIED|IMPOSSIBLE","gaps":["缺口1"],"evidence_found":["证据1"]}')

  return lines.join("\n")
}

// ── Response parser ──

function parseJudgeResponse(text: string): { verdict: FlashJudgeVerdict; gaps: string[]; evidence: string[] } {
  // Try JSON parse
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0])
      const rawVerdict = String(parsed.verdict ?? "").toUpperCase()
      let verdict: FlashJudgeVerdict = "NOT_SATISFIED"
      if (rawVerdict.includes("SATISFIED") && !rawVerdict.includes("NOT_SATISFIED")) verdict = "SATISFIED"
      else if (rawVerdict.includes("IMPOSSIBLE")) verdict = "IMPOSSIBLE"

      return {
        verdict,
        gaps: Array.isArray(parsed.gaps) ? parsed.gaps.filter(Boolean) : [],
        evidence: Array.isArray(parsed.evidence_found) ? parsed.evidence_found.filter(Boolean) : [],
      }
    } catch { /* fall through to text parsing */ }
  }

  // Fallback: text heuristics
  const upper = text.toUpperCase()
  if (upper.includes("SATISFIED") && !upper.includes("NOT_SATISFIED")) {
    return { verdict: "SATISFIED", gaps: [], evidence: [] }
  }
  if (upper.includes("IMPOSSIBLE")) {
    return { verdict: "IMPOSSIBLE", gaps: ["模型判定任务不可能完成"], evidence: [] }
  }
  return { verdict: "NOT_SATISFIED", gaps: ["无法解析 Judge 输出，默认为未完成"], evidence: [] }
}

// ── Testimony Ledger ──

export interface TestimonyRound {
  round: number
  /** What the agent claimed it would do (e.g. "运行测试", "修复类型错误") */
  promises: string[]
  /** What evidence was actually gathered this round */
  evidence: string[]
}

/**
 * TestimonyLedger tracks what the agent promised vs what it delivered across
 * judge evaluation rounds. This prevents the judge from being fooled by
 * circular promises ("I'll test next round" repeated N times without delivery).
 */
export class TestimonyLedger {
  rounds: TestimonyRound[] = []

  record(round: number, promises: string[], evidence: string[]): void {
    this.rounds.push({ round, promises, evidence })
  }

  /** Detect promises repeated across rounds without delivery. */
  detectCircularPromises(): string[] {
    const promiseCounts = new Map<string, { firstSeen: number; count: number }>()
    const delivered = new Set<string>()

    for (const r of this.rounds) {
      for (const e of r.evidence) delivered.add(e)
      for (const p of r.promises) {
        const existing = promiseCounts.get(p)
        if (existing) {
          existing.count++
        } else {
          promiseCounts.set(p, { firstSeen: r.round, count: 1 })
        }
      }
    }

    const circular: string[] = []
    for (const [promise, info] of promiseCounts) {
      if (info.count >= 2 && !delivered.has(promise)) {
        circular.push(`[R${info.firstSeen}→R${this.rounds[this.rounds.length-1]?.round ?? "?"}] "${promise}" 承诺 ${info.count} 次但未交付`)
      }
    }
    return circular
  }

  /** All evidence gathered across all rounds. */
  allEvidence(): string[] {
    return [...new Set(this.rounds.flatMap(r => r.evidence))]
  }

  reset(): void { this.rounds = [] }
}

// ── Circuit breaker ──

class JudgeCircuitBreaker {
  private count = 0
  private taskId = ""

  reset(taskId: string) { this.count = 0; this.taskId = taskId }
  increment() { this.count++ }
  get isOpen() { return this.count >= MAX_JUDGE_CALLS_PER_TASK }
  get remaining() { return Math.max(0, MAX_JUDGE_CALLS_PER_TASK - this.count) }
}

// ── Main class ──

export class FlashJudge {
  private provider: LLMProvider
  private breaker = new JudgeCircuitBreaker()
  private judgeModel: string

  constructor(provider: LLMProvider, judgeModel = JUDGE_MODEL) {
    this.provider = provider
    this.judgeModel = judgeModel
  }

  /** Call before a new task starts to reset the circuit breaker. */
  resetForTask(taskId: string) {
    this.breaker.reset(taskId)
  }

  /** Whether the judge should be invoked for this input. */
  shouldEvaluate(input: Pick<FlashJudgeInput, "taskTracker" | "taskHadWrite" | "toolErrors" | "round">): boolean {
    if (shouldSkipProviderPurpose("completion_judge")) return false
    if (this.breaker.isOpen) return false
    if (input.round < 3) return false  // too early to judge
    if (!input.taskTracker && !input.taskHadWrite && input.toolErrors === 0) return false
    return true
  }

  /**
   * Evaluate task completion. Calls Flash model with structured prompt.
   *
   * Cost: ~1/10 of a Pro round. Circuit breaker limits to 3 calls per task.
   */
  async evaluate(input: FlashJudgeInput): Promise<FlashJudgeOutput> {
    this.breaker.increment()

    const prompt = buildJudgePrompt(input)
    const system = "你是独立的代码审查评估器。只输出 JSON，不做其他解释。"
    const messages: ProviderMessage[] = [{ role: "user", content: prompt }]

    let rawVerdict = ""
    let tokenCost = Math.round((system.length + prompt.length) / 3)

    try {
      let responseText = ""
      // RC-02: judge 必须有硬超时（对齐 flash-triage 的 30s）；超时→catch→NOT_SATISFIED（unavailable 语义，不 pass）。
      const judgeAbort = AbortSignal.timeout(30_000)
      for await (const event of this.provider.streamChat({
        model: this.judgeModel,
        purpose: "completion_judge",
        system,
        messages,
        maxTokens: JUDGE_MAX_TOKENS,
        abortSignal: judgeAbort,
      })) {
        if (event.type === "text" && typeof event.data === "string") {
          responseText += event.data
        }
        if (event.type === "token_usage" && event.data) {
          const usage = event.data as { inputTokens?: number; outputTokens?: number }
          tokenCost = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        }
      }

      rawVerdict = responseText
      const parsed = parseJudgeResponse(responseText)

      return {
        verdict: parsed.verdict,
        gaps: parsed.gaps,
        evidenceFound: parsed.evidence,
        tokenCost,
        rawVerdict: responseText.slice(0, 200),
      }
    } catch {
      // Flash unavailable → fall through with NOT_SATISFIED as safety default
      return {
        verdict: "NOT_SATISFIED",
        gaps: ["Flash Judge 调用失败，保守判定为未完成"],
        evidenceFound: [],
        tokenCost,
        rawVerdict,
      }
    }
  }

  /** Build a recovery prompt for NOT_SATISFIED verdict. */
  static formatUnsatisfiedPrompt(gaps: string[]): string {
    return [
      "## 独立完成度评估",
      "",
      "外部评估器检查了你的工作，发现以下缺口：",
      ...gaps.map((g, i) => `${i + 1}. ${g}`),
      "",
      "请逐个解决以上缺口。完成后重新尝试交付。",
      "不要跳过验证步骤。不要问「需要我继续吗」——直接执行。",
    ].join("\n")
  }

  /** Build a terminal message for IMPOSSIBLE verdict. */
  static formatImpossiblePrompt(gaps: string[]): string {
    return [
      "## 独立完成度评估: 任务无法完成",
      "",
      "评估器判定当前任务在当前条件下无法完成：",
      ...gaps.map((g, i) => `${i + 1}. ${g}`),
      "",
      "请诚实向用户说明阻碍，列出已尝试的方法，建议替代方案。",
    ].join("\n")
  }

  get callsRemaining(): number { return this.breaker.remaining }
}
