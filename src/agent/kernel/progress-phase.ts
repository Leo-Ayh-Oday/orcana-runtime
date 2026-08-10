/** GS-P3 phase mapping —— AgentState → ProgressPhase 纯映射 + 各阶段认可规则。
 *
 *  DIAGNOSE/FINALIZE 无独立 AgentState，用"状态 + 本轮验证结果"合成：
 *    VERIFY + 本轮有 failed → DIAGNOSE（隔离失败/根因诊断期）
 *    VERIFY + 无 failed     → VERIFY
 *    DONE                   → FINALIZE
 *
 *  认可规则（PHASE_RULES）：IMPLEMENT 只认 execution + control（read 类不续命，
 *  有意收紧——v1 中任何工具调用都算进展）；PLAN 不认 evidence/epistemic
 *  （计划文本重写不是进展）；VERIFY/FINALIZE 认 evidence。
 */

import { AgentState } from "../state-machine"

export type ProgressPhase =
  | "RECON"
  | "DIAGNOSE"
  | "PLAN"
  | "IMPLEMENT"
  | "VERIFY"
  | "FINALIZE"
  | "RECOVER"

export interface PhaseRule {
  execution: boolean
  evidence: boolean
  epistemic: boolean
  control: boolean
}

export const PHASE_RULES: Record<ProgressPhase, PhaseRule> = {
  RECON: { execution: true, evidence: true, epistemic: true, control: true },
  DIAGNOSE: { execution: true, evidence: true, epistemic: true, control: true },
  PLAN: { execution: true, evidence: false, epistemic: false, control: true },
  IMPLEMENT: { execution: true, evidence: false, epistemic: false, control: true },
  VERIFY: { execution: true, evidence: true, epistemic: false, control: true },
  FINALIZE: { execution: false, evidence: true, epistemic: false, control: true },
  RECOVER: { execution: true, evidence: true, epistemic: true, control: true },
}

export interface PhaseMeta {
  /** 本轮是否存在 failed verification（驱动 DIAGNOSE）。 */
  failedThisRound: boolean
  /** 本轮是否存在 passed verification。 */
  passedThisRound: boolean
}

/** 确定性映射（无 I/O、无 LLM）。 */
export function derivePhase(agentState: AgentState, meta: PhaseMeta): ProgressPhase {
  switch (agentState) {
    case AgentState.UNDERSTAND:
    case AgentState.SEARCH:
    case AgentState.IDLE:
      return "RECON"
    case AgentState.PLAN:
      return "PLAN"
    case AgentState.CODE:
      return "IMPLEMENT"
    case AgentState.VERIFY:
      return meta.failedThisRound ? "DIAGNOSE" : "VERIFY"
    case AgentState.REPAIR:
      return "RECOVER"
    case AgentState.DONE:
      return "FINALIZE"
    case AgentState.BLOCKED:
    case AgentState.STALLED:
      // 终态：governor 不会以它们为输入评分（防御性兜底）。
      return "FINALIZE"
  }
}
