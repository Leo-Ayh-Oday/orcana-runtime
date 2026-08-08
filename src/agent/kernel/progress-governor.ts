/** GATE-03 v2（GS-P1~P6）: ProgressGovernor —— run-scoped liveness 控制器。
 *
 *  v1 只认状态变化（计数白名单），把合法的 epistemic/evidence 进展排除在外，
 *  导致 OTS-013 重考中 17 轮真实侦察后误判 STALLED。v2 按 GS-P1~P6 修订：
 *
 *    EffectiveProgress = execution ∨ novel epistemic ∨ evidence ∨ control
 *    纯文本 / 重复观察 / 同结果重复验证 / 未来承诺 ≠ progress（GS-P1）
 *    连续 4 轮无 EffectiveProgress → STALLED（GS-P2，窗口不变）
 *    阶段感知评分（GS-P3）：IMPLEMENT 只认 execution + control
 *    Action Commitment（GS-P4）：动作类 + 显式目标兼容，成功非偿付条件
 *    Recon 预算（GS-P5）：novel 侦察限量，超限后只读不再产生 epistemic
 *    ProgressDelta 可观测（GS-P6）：每轮 4 维 delta + 指纹 + 阶段
 *
 *  streak 时序（与 v1 等价）：2 → ACTION_FIRST，3 → REPLAN_ONCE，4 → STALLED。
 *  P4 debt 计时器与 streak 并行，优先级：
 *    commitment-stalled > streak-stalled > action_required > replan > action_first > proceed
 */

import type { AgentState } from "../state-machine"
import type { RoundToolCall } from "../run/types"
import type { VerificationResult } from "../../verification/result"
import type { ProviderMessage } from "../../provider/types"
import {
  FingerprintLedger,
  ReconBudget,
  PROGRESS_RECON_BUDGET_DEFAULT,
  PROGRESS_SEEN_CAP_DEFAULT,
} from "./progress-fingerprint"
import {
  CommitmentRegistry,
  detectCommitment,
  toolActionClass,
  COMMITMENT_DEBT_DEFAULT,
  type ActionCommitment,
} from "./progress-commitment"
import { derivePhase, PHASE_RULES, type ProgressPhase } from "./progress-phase"

// ── 配置 ──

export interface ProgressConfig {
  /** GS-P2：连续多少轮无 EffectiveProgress → STALLED（默认 4，不改）。 */
  stallRounds: number
  /** GS-P5：novel 侦察预算（默认 20，随阶段切换重置）。 */
  reconBudget: number
  /** GS-P4：连续多少轮未偿付 → ACTION_REQUIRED（默认 2）。 */
  commitmentDebt: number
  /** 观察指纹 seen-set 上限（默认 1024）。 */
  seenCap: number
}

export const PROGRESS_DEFAULTS: ProgressConfig = {
  stallRounds: 4,
  reconBudget: PROGRESS_RECON_BUDGET_DEFAULT,
  commitmentDebt: COMMITMENT_DEBT_DEFAULT,
  seenCap: PROGRESS_SEEN_CAP_DEFAULT,
}

export function resolveProgressConfig(env: Record<string, string | undefined> = process.env): ProgressConfig {
  const num = (v: string | undefined, fallback: number): number => {
    const n = v === undefined ? NaN : Number.parseInt(v, 10)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  return {
    stallRounds: num(env.ORCANA_PROGRESS_STALL_ROUNDS, PROGRESS_DEFAULTS.stallRounds),
    reconBudget: num(env.ORCANA_PROGRESS_RECON_BUDGET, PROGRESS_DEFAULTS.reconBudget),
    commitmentDebt: num(env.ORCANA_PROGRESS_COMMITMENT_DEBT, PROGRESS_DEFAULTS.commitmentDebt),
    seenCap: num(env.ORCANA_PROGRESS_SEEN_CAP, PROGRESS_DEFAULTS.seenCap),
  }
}

// ── 每轮输入（round.ts 构造，替代 v1 ProgressSnapshot） ──

export interface RoundProgressInput {
  round: number
  /** 本轮末端的状态机状态（round.ts 在 evaluate 前已 updateStateMachine）。 */
  agentState: AgentState
  /** 本轮最终文本（GS-P4 承诺检测用）。 */
  finalText: string
  committedToolCalls: RoundToolCall[]
  /** roundState.toolResults —— {type:"tool_result", tool_use_id, content}。 */
  toolResults: Array<Record<string, unknown>>
  /** 本轮已解析的验证结果（tsc/test 等）。 */
  verificationResults: VerificationResult[]
  /** 跟踪工作区文件集大小（增长 = 真实工件变化）。 */
  fileCount: number
  /** Master-plan 节点 done 数。 */
  completedNodes: number
  /** TaskTracker 步骤 done 数。 */
  completedSteps: number
  /** 当前激活计划节点 id（切换 = 前进）。 */
  currentNode: string
  /** Evidence ledger 条目数。 */
  evidenceEntries: number
  /** 未完成义务摘要（GS-02：digest 变化不算进展；报告用）。 */
  pendingObligationDigest: string
}

// ── 每轮可观测输出（GS-P6） ──

export interface ProgressDelta {
  round: number
  phase: ProgressPhase
  /** 写类提交 / 文件集增长 / 新命令或新输出指纹。 */
  execution: number
  /** 新证据（verification 新结果 / FAIL↔PASS 翻转 / evidence ledger 增长）。 */
  evidence: number
  /** 新颖观察（预算内 novel read）。 */
  epistemic: number
  /** 计划节点/步骤/当前节点推进、阶段转换。 */
  control: number
  novelty: { count: number; budget: number; exhausted: boolean }
  /** 本轮新增指纹（审计，每类截 20）。 */
  fingerprints: { reads: string[]; commands: string[]; verifications: string[] }
  /** 当前挂起承诺（GS-P4）。 */
  commitment: ActionCommitment | null
  effective: boolean
  reasons: string[]
}

export type GovernorDecision =
  | { action: "proceed"; delta: ProgressDelta | null }
  | { action: "action_first"; delta: ProgressDelta | null }
  | { action: "replan_once"; delta: ProgressDelta | null }
  | { action: "action_required"; delta: ProgressDelta | null; commitment: ActionCommitment }
  | { action: "stalled"; delta: ProgressDelta | null; report: string; reason: "streak" | "commitment" }

/** 只读工具白名单（v1 保留）——非只读即写类。 */
const READONLY_TOOL_NAMES = new Set([
  "read_file", "find_symbol", "find_references", "project_structure",
  "read_definition", "web_search", "git_status", "git_diff", "git_log", "git_blame",
  "request_deeper_thinking",
])

/** Tool call counts as a write-class side effect when it is not readonly. */
export function isWriteClassTool(name: string): boolean {
  return !READONLY_TOOL_NAMES.has(name)
}

/** Deterministic digest of what still blocks completion (titles only). */
export function obligationDigest(
  pendingSteps: string[],
  pendingNodes: string[],
): string {
  return [...pendingSteps, ...pendingNodes].slice(0, 8).join("|")
}

export class ProgressGovernor {
  private ledger: FingerprintLedger
  private recon: ReconBudget
  private commitments: CommitmentRegistry
  private last: RoundProgressInput | null = null
  private lastPhase: ProgressPhase | null = null
  private lastObligationDigest = ""
  private streak = 0
  private totalToolCalls = 0
  private totalWriteTools = 0
  private deltaHistory: Array<Pick<ProgressDelta, "round" | "phase" | "execution" | "evidence" | "epistemic" | "control">> = []
  private phaseChanges = 0

  constructor(readonly config: ProgressConfig = PROGRESS_DEFAULTS) {
    this.ledger = new FingerprintLedger(config.seenCap)
    this.recon = new ReconBudget(config.reconBudget)
    this.commitments = new CommitmentRegistry(config.commitmentDebt)
  }

  /** 连续无进展轮数（供下一轮 thinking 降级判断）。 */
  get consecutiveNoProgress(): number {
    return this.streak
  }

  /** 当前挂起承诺的未偿付轮数（GS-P4，trace/报告用）。 */
  get pendingCommitmentDebt(): number {
    return this.commitments.pendingDebt
  }

  /** 每轮结束后调用一次。 */
  evaluate(input: RoundProgressInput): GovernorDecision {
    const delta = this.computeDelta(input)

    // ── GS-P4：无工具轮检测文本承诺（有工具轮不设承诺——动作已在执行） ──
    // 注册轮不计债务（"后续 2 轮" = 承诺之后的完整两轮）；新文本承诺不重置
    // 既有债务（防"每 2 轮再承诺一次"Goodhart）。
    let commitmentState: { discharged: boolean; debtRemaining: number; status: "ok" | "action_required" | "stalled" }
    if (input.committedToolCalls.length === 0) {
      const commitment = detectCommitment(input.finalText, input.round)
      if (commitment) {
        this.commitments.register(commitment)
        commitmentState = { discharged: false, debtRemaining: this.commitments.pendingDebt, status: "ok" }
      } else {
        commitmentState = this.commitments.tickRound(input.committedToolCalls)
      }
    } else {
      commitmentState = this.commitments.tickRound(input.committedToolCalls)
    }
    // delta.commitment 反映 tick 后状态（偿付轮 → null；未偿付 → 挂起承诺）
    delta.commitment = this.commitments.active

    // ── streak（GS-P2）：effective → 清零；否则递增。
    // 首轮无基准（this.last 为 null）不计入 streak —— 与 v1 一致：
    // 连续 4 轮无进展 = 第 2~5 轮（首轮是基准轮）。 ──
    if (this.last) {
      if (delta.effective) {
        this.streak = 0
      } else {
        this.streak += 1
      }
    }

    this.totalToolCalls += input.committedToolCalls.length
    this.totalWriteTools += input.committedToolCalls.filter(tc => isWriteClassTool(tc.name)).length
    this.deltaHistory.push({
      round: delta.round,
      phase: delta.phase,
      execution: delta.execution,
      evidence: delta.evidence,
      epistemic: delta.epistemic,
      control: delta.control,
    })
    if (this.deltaHistory.length > 4) this.deltaHistory.shift()
    this.last = input

    // ── 决策优先级：commitment-stalled > streak-stalled > action_required
    //    > replan_once > action_first > proceed ──
    if (commitmentState.status === "stalled" && !delta.effective) {
      return {
        action: "stalled",
        delta,
        report: this.buildStallReport(input, delta, "commitment"),
        reason: "commitment",
      }
    }
    if (this.streak >= this.config.stallRounds) {
      return {
        action: "stalled",
        delta,
        report: this.buildStallReport(input, delta, "streak"),
        reason: "streak",
      }
    }
    if (commitmentState.status === "action_required" && this.commitments.active) {
      return { action: "action_required", delta, commitment: this.commitments.active }
    }
    if (this.streak === this.config.stallRounds - 1) {
      return { action: "replan_once", delta }
    }
    if (this.streak === this.config.stallRounds - 2) {
      return { action: "action_first", delta }
    }
    return { action: "proceed", delta }
  }

  // ── 四维 Delta 计算（GS-P1/P3/P5） ──

  private computeDelta(input: RoundProgressInput): ProgressDelta {
    const phase = derivePhase(input.agentState, {
      failedThisRound: input.verificationResults.some(r => !r.passed),
      passedThisRound: input.verificationResults.some(r => r.passed),
    })
    const reasons: string[] = []
    const fingerprints: ProgressDelta["fingerprints"] = { reads: [], commands: [], verifications: [] }
    let execution = 0
    let evidence = 0
    let epistemic = 0
    let control = 0
    let novelCount = 0

    // ── 阶段转换 = control 进展（DIAGNOSIS_COMPLETE → IMPLEMENT 等）；预算随阶段重置 ──
    if (this.lastPhase !== null && phase !== this.lastPhase) {
      control += 1
      this.phaseChanges += 1
      reasons.push(`阶段转换 ${this.lastPhase}→${phase}`)
      this.recon.reset()
    }
    this.lastPhase = phase

    // ── 工具观察（GS-P5 指纹；按 Capability Class 三分类） ──
    for (const tc of input.committedToolCalls) {
      const result = this.resultFor(input.toolResults, tc.id)
      const cls = toolActionClass(tc.name, JSON.stringify(tc.input))
      if (cls === "inspect") {
        // read 类：novel → epistemic（预算内）；重复 → 不算（GS-P1 负面清单）
        const novel = this.ledger.noteRead(tc.name, tc.input, result)
        if (novel) {
          novelCount += 1
          if (this.recon.trySpend()) {
            epistemic += 1
            reasons.push(`新观察 ${tc.name}`)
          } else {
            reasons.push(`新观察 ${tc.name}（recon 预算耗尽不计）`)
          }
          if (fingerprints.reads.length < 20) fingerprints.reads.push(`${tc.name}:${tc.id.slice(0, 6)}`)
        } else {
          this.ledger.noteRepeat()
          reasons.push(`重复观察 ${tc.name}`)
        }
      } else if (cls === "execute" || cls === "verify") {
        // 命令类：新命令或新输出 = 探索增量（execution 维度）；完全重复不算
        const { cmdNovel, outNovel } = this.ledger.noteCommand(tc.name, tc.input, result)
        if (cmdNovel || outNovel) {
          execution += 1
          reasons.push(outNovel ? `新输出 ${tc.name}` : `新命令 ${tc.name}`)
          if (fingerprints.commands.length < 20) fingerprints.commands.push(`${tc.name}:${tc.id.slice(0, 6)}`)
        } else {
          this.ledger.noteRepeat()
          reasons.push(`重复命令 ${tc.name}`)
        }
      } else {
        // 写/删除/服务/外部类：真实 dispatch 即 execution
        // （GS-P4 §3 精神；成败由 ErrorTracker/Obligation 系统接管）
        execution += 1
        reasons.push(`写类 ${tc.name}`)
      }
    }

    // ── 验证结果（evidence 维度；FAIL↔PASS 翻转是修复/新发现证据） ──
    for (const v of input.verificationResults) {
      const { resultNovel, verdictChanged } = this.ledger.noteVerification(v.kind, v.command, v.passed)
      if (resultNovel || verdictChanged) {
        evidence += verdictChanged ? 2 : 1
        reasons.push(verdictChanged ? `验证翻转 ${v.kind}:${v.passed}` : `新验证 ${v.kind}:${v.passed}`)
        if (fingerprints.verifications.length < 20) fingerprints.verifications.push(`${v.kind}:${v.passed}`)
      } else {
        this.ledger.noteRepeat()
        reasons.push(`重复验证 ${v.kind}:${v.passed}`)
      }
    }

    // ── 控制状态（v1 语义保留：文件/节点/步骤/证据增长；digest 变化不算） ──
    if (this.last) {
      if (input.fileCount !== this.last.fileCount) {
        execution += 1
        reasons.push("文件集增长")
      }
      if (input.evidenceEntries !== this.last.evidenceEntries) {
        evidence += 1
        reasons.push("evidence 增长")
      }
      if (input.completedNodes !== this.last.completedNodes || input.completedSteps !== this.last.completedSteps) {
        control += 1
        reasons.push("节点/步骤推进")
      }
      if (input.currentNode !== this.last.currentNode) {
        control += 1
        reasons.push("计划节点切换")
      }
    }

    // ── 阶段规则掩码（GS-P3） ──
    const rule = PHASE_RULES[phase]
    if (!rule.execution) execution = 0
    if (!rule.evidence) evidence = 0
    if (!rule.epistemic) epistemic = 0
    if (!rule.control) control = 0

    const effective = execution > 0 || evidence > 0 || epistemic > 0 || control > 0
    return {
      round: input.round,
      phase,
      execution,
      evidence,
      epistemic,
      control,
      novelty: { count: novelCount, budget: this.recon.limit, exhausted: this.recon.exhausted },
      fingerprints,
      commitment: this.commitments.active,
      effective,
      reasons,
    }
  }

  private resultFor(toolResults: Array<Record<string, unknown>>, toolCallId: string): unknown {
    if (toolCallId.length === 0) return undefined
    for (const r of toolResults) {
      if (r && typeof r === "object" && !Array.isArray(r) && r.tool_use_id === toolCallId) return r
    }
    return undefined
  }

  // ── STALLED 报告 v2（GS-P6） ──

  private buildStallReport(input: RoundProgressInput, delta: ProgressDelta, reason: "streak" | "commitment"): string {
    const title = reason === "commitment"
      ? "## ProgressGovernor: 运行停滞（GS-P4 承诺未履行）"
      : "## ProgressGovernor: 运行停滞（GS-P2 连续 4 轮无有效进展）"
    const pending = input.pendingObligationDigest || "(无记录)"
    const commit = this.commitments.active
    const rows = this.deltaHistory.map(d =>
      `| ${d.round} | ${d.phase} | ${d.execution} | ${d.evidence} | ${d.epistemic} | ${d.control} |`,
    ).join("\n")
    return [
      title,
      `- 轮次: ${input.round}（阶段: ${delta.phase}，状态机: ${input.agentState}）`,
      reason === "commitment" && commit
        ? `- 未执行承诺: round ${commit.createdRound}「${commit.text}」（class=${commit.actionClass}${commit.target?.value ? `, target=${commit.target.value}` : ""}）`
        : "",
      `- 近 4 轮 Delta 明细（P6）:`,
      `| 轮 | 阶段 | execution | evidence | epistemic | control |`,
      `|---|---|---|---|---|---|`,
      rows || "（无）",
      `- 工具调用: 累计 ${this.totalToolCalls} 次 / 写类 ${this.totalWriteTools} 次 / 本轮 ${input.committedToolCalls.length} 次`,
      `- Recon 预算: ${this.recon.used}/${this.recon.limit} 已用${this.recon.exhausted ? "（已耗尽）" : ""}`,
      `- 重复观察: 累计 ${this.ledger.repeatCount} 次（重读/同命令同输出/同验证结果）`,
      `- 跟踪文件: ${input.fileCount} 个 / 计划节点 done ${input.completedNodes} 个 / 步骤 done ${input.completedSteps} 个 / 证据 ${input.evidenceEntries} 条 / 当前节点: ${input.currentNode || "(无)"}`,
      `- 未完成义务: ${pending.slice(0, 200)}`,
      `- 判定理由: [execution=${delta.execution}, evidence=${delta.evidence}, epistemic=${delta.epistemic}, control=${delta.control}]`,
      ``,
      `不再继续注入提示或重跑 —— 无进展在预算上限内终止（GS-01 由 GS-P2 承接）。`,
    ].filter(Boolean).join("\n")
  }
}

// ── 注入提示 ──

export function actionFirstPrompt(): ProviderMessage {
  return {
    role: "user",
    content: [
      "## 执行模式：连续 2 轮无进展",
      "停止规划与重述。从计划中选择一项**可以立即执行**的下一步，",
      "并发出一个具体的工具调用（读/写/运行皆可）。",
      "如果第一步需要调查，就发出调查工具调用。",
      "**本轮禁止只输出文本。**",
    ].join("\n"),
  }
}

export function replanOncePrompt(): ProviderMessage {
  return {
    role: "user",
    content: [
      "## 重新规划（仅此一次）",
      "此前提示未产生任何进展。请重新制定**最小下一步**——只做一件事。",
      "不要重复之前的规划文本。",
    ].join("\n"),
  }
}

export function commitmentPrompt(): ProviderMessage {
  return {
    role: "user",
    content: [
      "## 承诺未执行",
      "你上轮承诺的下一步动作尚未发出对应的工具调用。",
      "**本轮必须发出与该承诺同类（写/验证/执行/删除等）的工具调用**，",
      "并针对承诺的目标（文件/命令/测试套件）执行。",
      "如果承诺不再成立，请用工具调用重新规划（例如写入修订后的计划），",
      "不要只用文本解释。",
    ].join("\n"),
  }
}
