/** LR2-3（P3-E）：只读推测执行（计划 §7.8）。
 *
 *  第一批只允许只读批次：测试发现 / 依赖扫描 / Repo Map / Reviewer
 *  预分析 / 缓存预热 / 只读索引。
 *  提交前重新验证：inputDigest / workspaceDigest / policyDigest /
 *  toolchainDigest —— 不一致则丢弃，不得将过期推测结果写入 Evidence。
 */

export type SpeculativeKind =
  | "test-discovery"
  | "dependency-scan"
  | "repo-map"
  | "reviewer-preanalysis"
  | "cache-warmup"
  | "readonly-index"

/** 只读白名单（白名单外一律拒绝）。 */
export const SPECULATIVE_WHITELIST: ReadonlySet<SpeculativeKind> = new Set<SpeculativeKind>([
  "test-discovery", "dependency-scan", "repo-map", "reviewer-preanalysis", "cache-warmup", "readonly-index",
])

export interface SpeculativeResult {
  kind: SpeculativeKind
  /** 推测执行时的环境摘要（提交前必须与当前一致）。 */
  inputDigest: string
  workspaceDigest: string
  policyDigest: string
  toolchainDigest: string
  /** 推测产出（结果数据）。 */
  output: unknown
  producedAt: number
}

export interface CurrentEnvironment {
  inputDigest: string
  workspaceDigest: string
  policyDigest: string
  toolchainDigest: string
}

/** 白名单校验：非只读批次拒绝推测。 */
export function speculativeAllowed(kind: SpeculativeKind): boolean {
  return SPECULATIVE_WHITELIST.has(kind)
}

/** 提交前 re-verify：任一 digest 不一致 → 丢弃（不写 Evidence）。
 *  m6（LR2-3 审核）：digest 必须非空 —— 未测量（undefined/空串）不等于
 *  "一致"（生产侧与消费侧同时缺失会误放行）。 */
export function verifySpeculativeResult(result: SpeculativeResult, env: CurrentEnvironment): boolean {
  const allMeasured = [
    result.inputDigest, result.workspaceDigest, result.policyDigest, result.toolchainDigest,
    env.inputDigest, env.workspaceDigest, env.policyDigest, env.toolchainDigest,
  ].every(d => typeof d === "string" && d.length > 0)
  if (!allMeasured) return false
  return (
    result.inputDigest === env.inputDigest &&
    result.workspaceDigest === env.workspaceDigest &&
    result.policyDigest === env.policyDigest &&
    result.toolchainDigest === env.toolchainDigest
  )
}
