/**
 * Run-scoped RetryLedger（PR-GATE-06 —— Unified Retry Budget）。
 *
 * 门控清理 §十：所有层消费同一个 RetryLedger，禁止各层分别持有独立/无限
 * 重试预算（provider × capability × node × graph 的乘法爆炸）。
 *
 * 类上限（§十初始策略）：
 *   transport            <= 2
 *   rateLimit            <= 3
 *   truncation           <= 1
 *   tool                 <= 1
 *   semanticRepair       <= 2
 *
 * 指纹规范：同 fingerprint 严格限次。指纹由各接入层构造——
 *   - provider 错误：`${kind}:${status ?? "no-status"}`（同 kind 连续失败
 *     算同一指纹，限次不会被措辞变化绕过）
 *   - 轮续跑（truncation）：`truncation:<round>`（同一轮最多续跑一次）
 *   - 工具（capability）：`tool:<toolId>:<code>`（同工具同错误码限一次）
 *   - repair：复用 failure-signature（`handler|category`，无限正则白名单）
 */

/** 重试类别（§十 byClass）。 */
export type RetryClass = "transport" | "rateLimit" | "truncation" | "tool" | "semanticRepair"

export const RETRY_CLASSES: readonly RetryClass[] = [
  "transport",
  "rateLimit",
  "truncation",
  "tool",
  "semanticRepair",
]

/** §十初始策略 —— 各类别允许的最大重试次数（首次尝试不计）。 */
export const RETRY_CLASS_LIMITS: Record<RetryClass, number> = {
  transport: 2,
  rateLimit: 3,
  truncation: 1,
  tool: 1,
  semanticRepair: 2,
}

export interface RetryLedger {
  readonly totalAttempts: number
  readonly byClass: Record<RetryClass, number>
  readonly byFingerprint: ReadonlyMap<string, number>
  /** 记一次重试尝试（首次失败之后的重试），返回本次尝试计数。 */
  record(retryClass: RetryClass, fingerprint: string): number
  /** 某 fingerprint 已发生的重试次数。 */
  attempts(retryClass: RetryClass, fingerprint: string): number
  /** 该类别+指纹下是否还允许重试（attempts < 类上限）。 */
  canRetry(retryClass: RetryClass, fingerprint: string): boolean
  summary(): RetryLedgerSummary
}

/** 观测快照（诊断/inspect/trace 用，不持有 Map 引用）。 */
export interface RetryLedgerSummary {
  totalAttempts: number
  byClass: Record<RetryClass, number>
  fingerprints: Array<{ fingerprint: string; retryClass: RetryClass; attempts: number }>
}

export function createRetryLedger(): RetryLedger {
  const counts = new Map<string, number>()
  const classTotals: Record<RetryClass, number> = {
    transport: 0,
    rateLimit: 0,
    truncation: 0,
    tool: 0,
    semanticRepair: 0,
  }
  let total = 0

  const keyOf = (retryClass: RetryClass, fingerprint: string): string => `${retryClass}:${fingerprint}`

  return {
    get totalAttempts() {
      return total
    },
    get byClass() {
      return { ...classTotals }
    },
    get byFingerprint() {
      return new Map(counts)
    },
    record(retryClass, fingerprint) {
      const key = keyOf(retryClass, fingerprint)
      const next = (counts.get(key) ?? 0) + 1
      counts.set(key, next)
      classTotals[retryClass] += 1
      total += 1
      return next
    },
    attempts(retryClass, fingerprint) {
      return counts.get(keyOf(retryClass, fingerprint)) ?? 0
    },
    canRetry(retryClass, fingerprint) {
      return this.attempts(retryClass, fingerprint) < RETRY_CLASS_LIMITS[retryClass]
    },
    summary() {
      return {
        totalAttempts: total,
        byClass: { ...classTotals },
        fingerprints: [...counts.entries()].map(([key, attempts]) => {
          const sep = key.indexOf(":")
          const retryClass = key.slice(0, sep) as RetryClass
          const fingerprint = key.slice(sep + 1)
          return { retryClass, fingerprint, attempts }
        }),
      }
    },
  }
}

/** 指纹辅助：provider 错误（transport/rateLimit 共用）。 */
export function providerRetryFingerprint(
  kind: string,
  status: number | undefined,
): string {
  return `${kind}:${status ?? "no-status"}`
}
