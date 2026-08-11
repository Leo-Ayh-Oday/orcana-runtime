/**
 * IC04: RetryCoordinator —— run-scoped retry decision authority。
 *
 * 职责边界：
 *   RetryLedger      = retry accounting storage（只记账）
 *   RetryCoordinator = retry decision authority（唯一 policy）
 *
 * 原子决策顺序（§21/§44）：
 *   1. abort?（provider 层处理，不进入 coordinator）
 *   2. side-effect boundary crossed?（hard deny，优先级 > retry budget，§43）
 *   3. retry class budget?
 *   4. external model-call budget（harness BudgetLedger adapter —— 先于
 *      numeric cap 触发既有 cancellation model_call_budget，§44）
 *   5. global physical provider request budget（direct agentLoop 的 numeric cap）
 *   6. record retry
 *   7. increment physical request
 *   8. ALLOW
 *
 * 任一步失败 → DENY，且后面的账本不得消费（R6/R7：deny 不 record、
 * 不 increment physical —— 账本永远不会记录一个未执行的重试）。
 *
 * Physical Provider Request（§22-24）：每次真正准备发起 HTTP/SDK stream
 * 请求（initial + transport/rate-limit retry + flash/judge/compaction 等
 * run-scoped subcall）都算 1 次 physicalProviderRequest。
 *
 * 依赖方向（§28）：Runtime 不反向依赖 Harness —— 外部预算通过最小
 * PhysicalRequestBudgetConsumer callback 接入。
 */

import {
  createRetryLedger,
  RETRY_CLASS_LIMITS,
  type RetryClass,
  type RetryLedger,
  type RetryLedgerSummary,
} from "../retry-ledger"

export type RetryBlockReason =
  | "class_exhausted"
  | "physical_request_budget"
  | "side_effect_boundary"
  | "aborted"

export interface RetryPermit {
  allowed: boolean
  reason?: RetryBlockReason
  retryClass?: RetryClass
  fingerprint?: string
}

/** §28: Harness 侧 BudgetLedger adapter 的最小 authority interface。 */
export interface PhysicalRequestBudgetConsumer {
  tryConsume(): { allowed: boolean; reason?: string }
}

export interface RetryCoordinatorOptions {
  /** run-scoped RetryLedger（唯一；§29：coordinator 与 ledger 一一对应）。 */
  ledger?: RetryLedger
  /**
   * §24: 全局 physical provider request 硬上限。
   *  derived default = max(logicalMaxRounds * 2, logicalMaxRounds + 8)。
   */
  maxPhysicalProviderRequests?: number
  /** §28: harness 外部 model-call 预算（BudgetLedger adapter）。 */
  externalBudgetConsumer?: PhysicalRequestBudgetConsumer
}

export interface RetryCoordinatorSummary {
  physicalProviderRequests: number
  maxPhysicalProviderRequests: number
  retry: RetryLedgerSummary
}

export interface RetryAuthorizationInput {
  retryClass?: RetryClass
  fingerprint?: string
  /** §43: 重放可能已发生副作用的操作 → hard deny。 */
  sideEffectBoundaryCrossed?: boolean
}

/** §24: derived physical cap。 */
export function deriveMaxPhysicalProviderRequests(logicalMaxRounds: number): number {
  return Math.max(logicalMaxRounds * 2, logicalMaxRounds + 8)
}

export class RetryCoordinator {
  private readonly ledger: RetryLedger
  private readonly maxPhysical: number
  private readonly externalConsumer?: PhysicalRequestBudgetConsumer
  private physicalCount = 0

  constructor(options: RetryCoordinatorOptions = {}) {
    this.ledger = options.ledger ?? createRetryLedger()
    this.maxPhysical = options.maxPhysicalProviderRequests ?? deriveMaxPhysicalProviderRequests(50)
    this.externalConsumer = options.externalBudgetConsumer
  }

  get physicalProviderRequests(): number {
    return this.physicalCount
  }

  get maxPhysicalProviderRequests(): number {
    return this.maxPhysical
  }

  get retryLedger(): RetryLedger {
    return this.ledger
  }

  /** §23/§34: 授权一次真实 Provider physical attempt（initial 或 retry）。 */
  authorizeProviderAttempt(input: RetryAuthorizationInput = {}): RetryPermit {
    // 2. side-effect boundary —— hard deny（优先级 > retry budget，§43）
    if (input.sideEffectBoundaryCrossed) {
      return { allowed: false, reason: "side_effect_boundary", retryClass: input.retryClass, fingerprint: input.fingerprint }
    }
    // 3. retry class budget（initial attempt 无 retryClass，跳过）
    if (input.retryClass) {
      if (!this.ledger.canRetry(input.retryClass, input.fingerprint ?? "")) {
        return { allowed: false, reason: "class_exhausted", retryClass: input.retryClass, fingerprint: input.fingerprint }
      }
    }
    // 4. external model-call budget（harness —— 先于 numeric cap，触发
    //    BudgetGuard cancellation，§44）。direct agentLoop（无 consumer）
    //    跳过，由 numeric cap 裁决。
    if (this.externalConsumer) {
      const external = this.externalConsumer.tryConsume()
      if (!external.allowed) {
        return { allowed: false, reason: "physical_request_budget", retryClass: input.retryClass, fingerprint: input.fingerprint }
      }
    }
    // 5. global physical provider request budget（§22）
    if (this.physicalCount >= this.maxPhysical) {
      return { allowed: false, reason: "physical_request_budget", retryClass: input.retryClass, fingerprint: input.fingerprint }
    }
    // 6. record retry（只有 retry 才记账；deny 路径绝不 record —— R6/R7）
    if (input.retryClass) {
      this.ledger.record(input.retryClass, input.fingerprint ?? "")
    }
    // 7. increment physical request
    this.physicalCount += 1
    return { allowed: true, retryClass: input.retryClass, fingerprint: input.fingerprint }
  }

  /**
   * §40/§41/§42: 通用 retry 授权（tool protocol constrained recovery /
   * capability retry / semantic repair）。不发起 HTTP，不消费 physical。
   */
  authorizeRetry(input: Required<Pick<RetryAuthorizationInput, "retryClass" | "fingerprint">> & RetryAuthorizationInput): RetryPermit {
    if (input.sideEffectBoundaryCrossed) {
      return { allowed: false, reason: "side_effect_boundary", retryClass: input.retryClass, fingerprint: input.fingerprint }
    }
    if (!this.ledger.canRetry(input.retryClass, input.fingerprint)) {
      return { allowed: false, reason: "class_exhausted", retryClass: input.retryClass, fingerprint: input.fingerprint }
    }
    this.ledger.record(input.retryClass, input.fingerprint)
    return { allowed: true, retryClass: input.retryClass, fingerprint: input.fingerprint }
  }

  /** §45: 只读观测快照（trace 用，不消费任何预算）。 */
  summary(): RetryCoordinatorSummary {
    return {
      physicalProviderRequests: this.physicalCount,
      maxPhysicalProviderRequests: this.maxPhysical,
      retry: this.ledger.summary(),
    }
  }
}

export { RETRY_CLASS_LIMITS }
