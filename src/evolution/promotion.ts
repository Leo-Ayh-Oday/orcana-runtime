/** LR2-6（P6-D）：晋升管线 —— 状态机 + Canary + 人工批准 + 回归监视。
 *
 *  强制路径：PROPOSED → EVALUATED（重放+安全+性能全绿）→ CANARY →
 *  APPROVED（人工）→ PROMOTED → Regression Watch。
 *  候选永远不能写入基线 —— 基线只由 Promotion 动作更新。
 */

import type { EvolutionManifest } from "./manifest"
import type { DifferentialReport } from "./report"
import type { SecurityGateVerdict } from "./security"
import type { PerfVerdict } from "./performance"

export type PromotionState =
  | "PROPOSED"
  | "EVALUATED"
  | "CANARY"
  | "APPROVED"
  | "PROMOTED"
  | "REJECTED_CRITERIA"
  | "SECURITY_REGRESSION"
  | "PERF_REGRESSION"
  | "CANARY_FAILED"
  | "HUMAN_DECLINED"
  | "EVALUATOR_CHANGED"

export interface CanaryResult {
  ok: boolean
  /** canary 窗口内的新回归数。 */
  newRegressions: number
  detail?: string
}

export interface PromotionRecord {
  state: PromotionState
  manifestId: string
  candidateRef: string
  /** 晋升后的基线更新引用（仅 PROMOTED 后设置）。 */
  promotedBaselineRef?: string
  /** 晋级时间线。 */
  transitions: Array<{ from: PromotionState | null; to: PromotionState; at: string; reason: string }>
}

const VALID_TERMINAL: ReadonlySet<PromotionState> = new Set([
  "PROMOTED", "REJECTED_CRITERIA", "SECURITY_REGRESSION", "PERF_REGRESSION",
  "EVALUATOR_CHANGED",
])

const ALLOWED_FROM: Record<PromotionState, ReadonlySet<PromotionState>> = {
  PROPOSED: new Set(["EVALUATED", "REJECTED_CRITERIA", "SECURITY_REGRESSION", "PERF_REGRESSION", "EVALUATOR_CHANGED"]),
  EVALUATED: new Set(["CANARY", "CANARY_FAILED", "REJECTED_CRITERIA", "SECURITY_REGRESSION", "PERF_REGRESSION", "EVALUATOR_CHANGED"]),
  CANARY: new Set(["APPROVED", "HUMAN_DECLINED", "CANARY_FAILED", "EVALUATOR_CHANGED"]),
  APPROVED: new Set(["PROMOTED", "HUMAN_DECLINED"]),
  PROMOTED: new Set(),
  REJECTED_CRITERIA: new Set(["PROPOSED"]), // 可重新提案（新 manifest/candidate）
  SECURITY_REGRESSION: new Set(["PROPOSED"]),
  PERF_REGRESSION: new Set(["PROPOSED"]),
  CANARY_FAILED: new Set(["CANARY"]), // 修复后可重试 canary
  HUMAN_DECLINED: new Set(["CANARY"]), // 人工驳回后可重新提交 canary
  EVALUATOR_CHANGED: new Set(),
}

export function createPromotion(manifest: EvolutionManifest, candidateRef: string): PromotionRecord {
  const rec: PromotionRecord = {
    state: "PROPOSED",
    manifestId: manifest.manifestId,
    candidateRef,
    transitions: [{ from: null, to: "PROPOSED", at: new Date().toISOString(), reason: "proposal created" }],
  }
  return rec
}

export interface EvaluationEvidence {
  differential: DifferentialReport
  security: SecurityGateVerdict
  performance: PerfVerdict
  /** 当前实际评测器版本（EVALUATOR_CHANGED 检测：必须 == manifest.evaluatorVersion）。 */
  actualEvaluatorVersion: string
}

/** 完整评估入口：重放差异 + 安全 + 性能 三合一。 */
export function evaluateCandidate(record: PromotionRecord, manifest: EvolutionManifest, evidence: EvaluationEvidence): PromotionRecord {
  assertState(record, "PROPOSED")
  if (evidence.actualEvaluatorVersion !== manifest.evaluatorVersion) {
    return transition(record, "EVALUATOR_CHANGED", `evaluator changed: manifest=${manifest.evaluatorVersion} actual=${evidence.actualEvaluatorVersion}`)
  }
  if (!evidence.differential.replayPassable) {
    return transition(record, "REJECTED_CRITERIA", `replay blockers: ${evidence.differential.blockers.join("; ")}`)
  }
  if (!evidence.security.ok) {
    return transition(record, "SECURITY_REGRESSION", evidence.security.reason)
  }
  if (!evidence.performance.ok) {
    return transition(record, "PERF_REGRESSION", evidence.performance.reason)
  }
  return transition(record, "EVALUATED", `all evaluation dimensions green: ${evidence.differential.unchangedPass + evidence.differential.improved} pass (${evidence.differential.improved} improved)`)
}

/** Canary：小流量真实场景。通过 → 等待人工批准；失败 → CANARY_FAILED。 */
export function runCanary(record: PromotionRecord, result: CanaryResult): PromotionRecord {
  assertState(record, "EVALUATED")
  if (!result.ok || result.newRegressions > 0) {
    return transition(record, "CANARY_FAILED", `canary failed: ${result.detail ?? `newRegressions=${result.newRegressions}`}`)
  }
  return transition(record, "CANARY", `canary passed: ${result.detail ?? "no regressions"}`)
}

/** 重试 Canary（从 CANARY_FAILED / HUMAN_DECLINED 直接回到 CANARY）。 */
export function retryCanary(record: PromotionRecord, result: CanaryResult): PromotionRecord {
  if (record.state !== "CANARY_FAILED" && record.state !== "HUMAN_DECLINED") {
    throw new Error(`canary retry requires CANARY_FAILED/HUMAN_DECLINED, got ${record.state}`)
  }
  if (!result.ok || result.newRegressions > 0) {
    return transition(record, "CANARY_FAILED", `canary retry failed: ${result.detail ?? `newRegressions=${result.newRegressions}`}`)
  }
  return transition(record, "CANARY", `canary retry passed: ${result.detail ?? "no regressions"}`)
}

/** 人工批准（PROMOTION_WITHOUT_HUMAN_APPROVAL = 0）。 */
export function humanApprove(record: PromotionRecord, approved: boolean, reason?: string): PromotionRecord {
  assertState(record, "CANARY")
  if (!approved) return transition(record, "HUMAN_DECLINED", reason ?? "human declined")
  return transition(record, "APPROVED", reason ?? "human approved")
}

/** Promotion：更新基线引用（候选写入基线只允许经此入口）。 */
export function promote(record: PromotionRecord, newBaselineRef: string): PromotionRecord {
  assertState(record, "APPROVED")
  const rec = transition(record, "PROMOTED", `promoted: baseline → ${newBaselineRef}`)
  rec.promotedBaselineRef = newBaselineRef
  return rec
}

/** Regression Watch：晋升后监视窗口内新回归 → 记录（不自动撤销晋升，
 *  但暴露给上层触发降级流程）。 */
export function watchRegressions(record: PromotionRecord, newRegressions: number, windowMs: number): { regressed: boolean; reason?: string } {
  if (record.state !== "PROMOTED") {
    return { regressed: false, reason: "not promoted; watch applies only to promoted candidates" }
  }
  if (newRegressions > 0) {
    return { regressed: true, reason: `${newRegressions} new regression(s) within ${windowMs}ms watch window` }
  }
  return { regressed: false }
}

function assertState(record: PromotionRecord, expected: PromotionState): void {
  if (record.state !== expected) {
    throw new Error(`promotion state mismatch: expected ${expected}, got ${record.state}`)
  }
}

function transition(record: PromotionRecord, to: PromotionState, reason: string): PromotionRecord {
  if (VALID_TERMINAL.has(record.state) && record.state !== to) {
    throw new Error(`promotion already terminal: ${record.state} cannot move to ${to}`)
  }
  const allowed = ALLOWED_FROM[record.state]
  if (!allowed.has(to)) {
    throw new Error(`illegal promotion transition: ${record.state} → ${to}`)
  }
  const from = record.state
  record.state = to
  record.transitions.push({ from, to, at: new Date().toISOString(), reason })
  return record
}
