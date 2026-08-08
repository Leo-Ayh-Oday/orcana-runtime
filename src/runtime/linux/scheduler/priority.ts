/** LR2-3（P3-C）：优先级模型 —— 显式字段 + 可解释评分 + 决策日志。
 *
 *  priority = criticality + userVisibility + downstreamUnlockValue
 *           + verificationValue + cacheOpportunity
 *           - resourcePressureCost - retryRisk
 *
 *  先保留显式字段与决策日志（计划 §7.5），不把公式隐藏成不可解释评分。
 */

export interface PriorityInput {
  /** 关键路径长度（越长越优先）。 */
  criticalPathLength: number
  /** 下游阻塞任务数。 */
  downstreamBlockedCount: number
  /** 用户可见性（0-1）。 */
  userVisibility: number
  /** 验证重要性（0-1；验证类任务高）。 */
  verificationImportance: number
  /** 预估时长（ms；越长成本越高 → 降低优先）。 */
  estimatedDurationMs: number
  /** 预估资源成本（权重分）。 */
  estimatedResourceCost: number
  /** 缓存命中概率（0-1；越高越优先 —— 低成本机会）。 */
  cacheHitProbability: number
  /** 重试风险（0-1；越高越靠后）。 */
  retryRisk: number
  /** 系统压力成本（0-1；PSI CRITICAL 时升高）。 */
  resourcePressureCost: number
}

export interface PriorityDecision {
  score: number
  /** 决策日志：每个字段的贡献（可解释）。 */
  log: Record<string, number>
}

/** 显式评分（无隐藏魔法数 —— 权重集中在此，可调）。 */
export const PRIORITY_WEIGHTS = {
  criticality: 3,
  downstreamUnlock: 2,
  userVisibility: 4,
  verification: 2,
  cacheOpportunity: 1,
  durationPenalty: 0.001, // per ms（长任务降优先）
  resourceCostPenalty: 1,
  retryRiskPenalty: 2,
  pressurePenalty: 5,
} as const

export function evaluatePriority(input: PriorityInput): PriorityDecision {
  const log: Record<string, number> = {}
  const criticality = input.criticalPathLength * PRIORITY_WEIGHTS.criticality
  const downstreamUnlock = input.downstreamBlockedCount * PRIORITY_WEIGHTS.downstreamUnlock
  const userVisibility = input.userVisibility * PRIORITY_WEIGHTS.userVisibility
  const verification = input.verificationImportance * PRIORITY_WEIGHTS.verification
  const cacheOpportunity = input.cacheHitProbability * PRIORITY_WEIGHTS.cacheOpportunity
  const durationPenalty = input.estimatedDurationMs * PRIORITY_WEIGHTS.durationPenalty
  const resourceCostPenalty = input.estimatedResourceCost * PRIORITY_WEIGHTS.resourceCostPenalty
  const retryRiskPenalty = input.retryRisk * PRIORITY_WEIGHTS.retryRiskPenalty
  const pressurePenalty = input.resourcePressureCost * PRIORITY_WEIGHTS.pressurePenalty

  const score =
    criticality + downstreamUnlock + userVisibility + verification + cacheOpportunity
    - durationPenalty - resourceCostPenalty - retryRiskPenalty - pressurePenalty

  log["criticality"] = criticality
  log["downstreamUnlock"] = downstreamUnlock
  log["userVisibility"] = userVisibility
  log["verification"] = verification
  log["cacheOpportunity"] = cacheOpportunity
  log["durationPenalty"] = durationPenalty
  log["resourceCostPenalty"] = resourceCostPenalty
  log["retryRiskPenalty"] = retryRiskPenalty
  log["pressurePenalty"] = pressurePenalty

  return { score, log }
}
