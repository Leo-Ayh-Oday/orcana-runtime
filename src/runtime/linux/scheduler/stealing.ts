/** LR2-3（P3-E）：Work Stealing —— 7 条件守卫（计划 §7.7）。
 *
  只在以下条件**全部**成立时迁移：
  1. 节点尚未开始；
  2. 新 Agent 具备相同 capability；
  3. 重新生成 ParticipantAssignment；
  4. 文件所有权不扩大；
  5. 秘密重新授权；
  6. 私有上下文依赖为 false；
  7. 生成新的 Node Attempt。
 *
 *  v1 只做决策函数 + 守卫（实际迁移执行属 Graph Runtime 集成）。
 */

export interface StealCandidate {
  nodeId: string
  nodeRunId: string
  capabilityId: string
  /** 原 Agent 的文件所有权范围。 */
  ownerFiles: string[]
  /** 新 Agent 的文件所有权范围（迁移后）。 */
  newOwnerFiles: string[]
  /** 私有上下文依赖（Agent 私有状态）。 */
  hasPrivateContextDependency: boolean
  /** 是否已开始执行。 */
  started: boolean
}

export interface StealTargetContext {
  agentId: string
  capabilities: string[]
  /** 秘密授权（迁移需重新授权 —— 由 Harness 提供）。 */
  secretsAuthorized: boolean
}

export type StealVerdict =
  | { allowed: true; reason: string }
  | { allowed: false; reasons: string[] }

/** 7 条件守卫（任一不满足 → 拒绝）。 */
export function canSteal(candidate: StealCandidate, target: StealTargetContext): StealVerdict {
  const reasons: string[] = []

  // 1. 节点尚未开始
  if (candidate.started) reasons.push("node already started")
  // 2. 新 Agent 具备相同 capability
  if (!target.capabilities.includes(candidate.capabilityId)) {
    reasons.push(`target agent lacks capability ${candidate.capabilityId}`)
  }
  // 4. 文件所有权不扩大（新所有权必须是原所有权的子集）
  const superset = candidate.newOwnerFiles.some(f => !candidate.ownerFiles.includes(f))
  if (superset) reasons.push("file ownership would expand")
  // 5. 秘密重新授权
  if (!target.secretsAuthorized) reasons.push("secrets not re-authorized")
  // 6. 私有上下文依赖为 false
  if (candidate.hasPrivateContextDependency) reasons.push("private context dependency")
  // 7. 生成新的 Node Attempt —— 由调用方保证（决策方必须新建 attempt）
  //    （3. 重新生成 ParticipantAssignment 同理 —— 调用方契约）

  if (reasons.length > 0) return { allowed: false, reasons }
  // m4（LR2-3 审核）：诚实声明 —— 守卫只验证 5 个条件；条件 3（重新生成
  // ParticipantAssignment）与 7（生成新的 Node Attempt）是调用方契约，
  // 守卫无法自证（不谎称"全部满足"）。
  return {
    allowed: true,
    reason: "5 guard conditions met; conditions 3/7 (new ParticipantAssignment, new Node Attempt) are caller contract obligations",
  }
}
