/** LR2-6（P6-C）：Security Gate 评估 —— 候选的安全约束不得低于基线。
 *
 *  Gate 值语义：0 = 关闭（安全），>0 = 违规数（越大越糟）。
 *  任何 Gate 值增大 → SECURITY_GATE_REGRESSION（禁止晋升）。
 *  输出可解释决策输入（gate 名 + 基线/候选值 + 原因），不隐藏成黑盒分数。
 */

export interface SecurityGateSnapshot {
  /** gate 名 → 值（0 = 无违规）。 */
  gates: Record<string, number>
  /** 快照来源描述（评估器版本/时间）。 */
  source: string
  evaluatedAt: string
}

export type SecurityGateVerdict =
  | { ok: true; reason: string }
  | { ok: false; reason: string; regressedGates: Array<{ gate: string; baseline: number; candidate: number }> }

/** 对比安全 Gate：候选任何项 > 基线 → 回归；候选缺项 → 拒绝
 *  （M6：未评估 ≠ 安全 —— 安全评估工具失效/被移除必须显式失败）。 */
export function compareSecurityGates(baseline: SecurityGateSnapshot, candidate: SecurityGateSnapshot): SecurityGateVerdict {
  const regressed: Array<{ gate: string; baseline: number; candidate: number }> = []
  const allGates = new Set([...Object.keys(baseline.gates), ...Object.keys(candidate.gates)])
  for (const gate of allGates) {
    const b = baseline.gates[gate] ?? 0
    const c = candidate.gates[gate] ?? 0
    if (!(gate in candidate.gates)) {
      regressed.push({ gate, baseline: b, candidate: -1 }) // candidate: -1 = 未评估
      continue
    }
    if (c > b) regressed.push({ gate, baseline: b, candidate: c })
  }
  if (regressed.length > 0) {
    return {
      ok: false,
      reason: `security gate regression: ${regressed.map(r => `${r.gate} ${r.baseline}→${r.candidate === -1 ? "UNEVAULATED" : r.candidate}`).join(", ")}`,
      regressedGates: regressed,
    }
  }
  return { ok: true, reason: "security gates non-regressing" }
}

/** 快速构造快照（测试/收集用）。 */
export function snapshotOf(gates: Record<string, number>, source = "unknown"): SecurityGateSnapshot {
  return { gates, source, evaluatedAt: new Date().toISOString() }
}
