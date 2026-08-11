/**
 * IC04: LoopSupervisor —— Loop Liveness Authority（§6-§18）。
 *
 * 职责边界：
 *   ProgressGovernor = progress fact engine（四维 Delta 事实计算）
 *   LoopSupervisor   = liveness decision authority（是否允许下一个 Provider round）
 *   CompletionOrchestrator = completion truth（任务是否完成，不得重新实现）
 *
 * LoopSupervisor 拥有 ProgressGovernor（RunPhaseContext.loopSupervisor →
 * .governor），production main path 不得再直接读 governor 的
 * consecutiveNoProgress / 自行解释 action_first/replan/stalled（§7）。
 *
 * 决策要素：
 *   - ProgressGovernor.evaluate()（每 logical round 最多一次，§10）
 *   - Truncation Ladder（§12-§14）：no-action truncation 三阶
 *     #1 → LOWER_THINKING（thinking <= 2048）
 *     #2 → ACTION_FIRST（thinking <= 2048 + runtime action requirement）
 *     #3 → STALLED(reason=truncation)
 *   - deterministic precedence（§16）
 *
 * 唯一输入 truncation 事实：ProviderFinishReason（IC03 结构化 finish，
 * 禁止 rawStopReason / max_tokens / length 字符串猜测，§11）。
 */

import type { ProviderFinishReason, ProviderMessage } from "../../provider/types"
import type {
  GovernorDecision,
  ProgressDelta,
  ProgressGovernor,
  RoundProgressInput,
} from "./progress-governor"

export type LoopRecoveryMode =
  | "normal"
  | "lower_thinking"
  | "action_first"

export interface NextRoundPolicy {
  recoveryMode: LoopRecoveryMode
  /** §17: router 只收 policy —— liveness 导致的 thinking cap（2048）。 */
  thinkingCapTokens?: number
}

export interface LoopSupervisorObservation {
  round: number
  finishReason?: ProviderFinishReason
  executableToolCallCount: number
  sideEffectBoundaryCrossed: boolean
  /**
   * 每 completed logical round 必须提供（P0-1：
   * PROGRESS_EVALUATION_PER_COMPLETED_ROUND = 1）—— early-continue
   * 路径（provider recovery / orchestrator continue / master-plan
   * next-node）同样必须构造 buildProgressInput(...) 后经唯一 seam。
   * LoopSupervisor 每轮 EXACTLY ONCE evaluate，double-evaluation
   * fail closed（§10）。
   */
  progressInput: RoundProgressInput
}

export type LoopStallReason = "progress" | "commitment" | "truncation"

export type LoopSupervisorDecision =
  | {
      action: "proceed"
      nextRoundPolicy: NextRoundPolicy
      governor?: GovernorDecision
    }
  | {
      action: "lower_thinking" | "action_first" | "replan_once" | "action_required"
      nextRoundPolicy: NextRoundPolicy
      message?: ProviderMessage
      governor?: GovernorDecision
    }
  | {
      action: "stalled"
      reason: LoopStallReason
      report: string
      governor?: GovernorDecision
      nextRoundPolicy: NextRoundPolicy
    }

export interface LoopSupervisorConfig {
  /** IC04: no-action truncation 阶梯上限（固定 3，§13）。 */
  truncationLadderLimit: number
}

export const LOOP_SUPERVISOR_DEFAULTS: LoopSupervisorConfig = {
  truncationLadderLimit: 3,
}

/** §13: LOWER_THINKING / ACTION_FIRST 的 thinking cap。 */
export const LIVENESS_THINKING_CAP_TOKENS = 2048

function policyFor(recoveryMode: LoopRecoveryMode): NextRoundPolicy {
  return recoveryMode === "normal"
    ? { recoveryMode }
    : { recoveryMode, thinkingCapTokens: LIVENESS_THINKING_CAP_TOKENS }
}

export class LoopSupervisor {
  private readonly config: LoopSupervisorConfig
  private truncationStreakValue = 0
  private lastEvaluatedRound = -1
  private lastPolicy: NextRoundPolicy = { recoveryMode: "normal" }

  constructor(
    readonly governor: ProgressGovernor,
    config: Partial<LoopSupervisorConfig> = {},
  ) {
    this.config = { ...LOOP_SUPERVISOR_DEFAULTS, ...config }
  }

  get currentPolicy(): NextRoundPolicy {
    return this.lastPolicy
  }

  get truncationStreak(): number {
    return this.truncationStreakValue
  }

  /** §15: governor 连续无进展轮数（观测/trace 用，非行为决策源）。 */
  get consecutiveNoProgress(): number {
    return this.governor.consecutiveNoProgress
  }

  /** §8: physical round boundary —— 是否允许开始下一次 main Provider round。 */
  beforeRound(round: number, maxRounds: number): "START" | "ROUND_BUDGET" {
    if (round >= maxRounds) return "ROUND_BUDGET"
    return "START"
  }

  /**
   * 每 completed logical round 一次（唯一入口）。所有 continue path 必须
   * 经过本方法（CONTINUE_PATH_WITHOUT_SUPERVISION = 0）。
   */
  afterRound(observation: LoopSupervisorObservation): LoopSupervisorDecision {
    // §10: PROGRESS_EVALUATION_PER_ROUND_MAX = 1 —— 同 round 重复评价
    // fail closed（显式拒绝，绝不静默让 streak +2）。
    // P0-1: 每 completed logical round EXACTLY ONCE evaluate —— contract 必选。
    if (this.lastEvaluatedRound === observation.round) {
      throw new Error(`LoopSupervisor: double progress evaluation for round ${observation.round}`)
    }
    this.lastEvaluatedRound = observation.round
    const governor = this.governor.evaluate(observation.progressInput)
    const delta = governor.delta

    // P1-11: effective progress 优先 reset —— 即使 finishReason 同属
    // no-action truncation class（truncation ladder 不吞没真实进展）。
    // §12-§14: truncation streak —— 唯一输入 ProviderFinishReason。
    const noActionTruncation = observation.finishReason === "truncated_before_action"
      || (observation.finishReason === "truncated_partial_tool" && observation.executableToolCallCount === 0)
    if (delta?.effective) {
      this.truncationStreakValue = 0
    } else if (noActionTruncation) {
      this.truncationStreakValue += 1
    } else if (observation.finishReason !== undefined) {
      // §14: 离开 no-action truncation class（含 truncated_after_action）→ reset。
      this.truncationStreakValue = 0
    }

    const decision = this.decide(governor, delta)
    this.lastPolicy = decision.nextRoundPolicy
    return decision
  }

  /** §16: deterministic precedence（冻结，tests 覆盖）。 */
  private decide(governor: GovernorDecision | undefined, delta: ProgressDelta | null): LoopSupervisorDecision {
    // 1. ProgressGovernor commitment STALLED
    if (governor?.action === "stalled" && governor.reason === "commitment") {
      return { action: "stalled", reason: "commitment", report: governor.report, governor, nextRoundPolicy: policyFor("normal") }
    }
    // 2. Truncation streak >= 3 → STALLED(truncation)
    if (this.truncationStreakValue >= this.config.truncationLadderLimit) {
      return {
        action: "stalled",
        reason: "truncation",
        report: `## LoopSupervisor: 运行停滞（连续 ${this.truncationStreakValue} 轮 no-action truncation）\n- 第 ${this.config.truncationLadderLimit} 次同类截断 —— 不再发起下一个 Provider round。\n- 轮次: ${delta?.round ?? "?"}（effective=${delta?.effective ?? "n/a"}）`,
        governor,
        nextRoundPolicy: policyFor("normal"),
      }
    }
    // 3. ProgressGovernor streak STALLED
    if (governor?.action === "stalled") {
      return { action: "stalled", reason: "progress", report: governor.report, governor, nextRoundPolicy: policyFor("normal") }
    }
    // 4. Action Commitment ACTION_REQUIRED
    if (governor?.action === "action_required") {
      return { action: "action_required", nextRoundPolicy: policyFor("normal"), governor }
    }
    // 5. Truncation streak == 2 → ACTION_FIRST
    if (this.truncationStreakValue === 2) {
      return { action: "action_first", nextRoundPolicy: policyFor("action_first"), governor }
    }
    // 6. ProgressGovernor REPLAN_ONCE
    if (governor?.action === "replan_once") {
      return { action: "replan_once", nextRoundPolicy: policyFor("normal"), governor }
    }
    // 7. ProgressGovernor ACTION_FIRST
    if (governor?.action === "action_first") {
      return { action: "action_first", nextRoundPolicy: policyFor("action_first"), governor }
    }
    // 8. Truncation streak == 1 → LOWER_THINKING
    if (this.truncationStreakValue === 1) {
      return { action: "lower_thinking", nextRoundPolicy: policyFor("lower_thinking"), governor }
    }
    // 9. PROCEED
    return { action: "proceed", nextRoundPolicy: policyFor("normal"), governor }
  }
}
