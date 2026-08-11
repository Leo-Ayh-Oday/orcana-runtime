/**
 * IC04: RetryCoordinator —— run-scoped retry decision authority。
 *
 * 职责边界：
 *   RetryLedger      = retry accounting storage（只记账）
 *   RetryCoordinator = retry decision authority（唯一 policy）
 *
 * 原子决策顺序（§21/§44/Correction #13）：
 *   1. abort?（provider 层处理，不进入 coordinator）
 *   2. side-effect boundary crossed?（hard deny，优先级 > retry budget，§43）
 *   3. retry class budget?
 *   4. global physical provider request budget（numeric cap —— 先于 external
 *      reserve：所有无副作用 deny check 完成前绝不消费外部预算）
 *   5. external model-call budget（harness BudgetLedger adapter —— 其 deny
 *      触发既有 cancellation model_call_budget；external 之后不存在任何
 *      可能 DENY 的 check，budget consume 与请求发出严格绑定）
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
  /** P1-9: 初始 decision observer（如 runTrace 挂钩）。 */
  onDecision?: RetryDecisionObserver
}

export interface RetryCoordinatorSummary {
  physicalProviderRequests: number
  maxPhysicalProviderRequests: number
  retry: RetryLedgerSummary
  /** P1-9: 安全 audit snapshot（decision history）。 */
  audit: { decisions: RetryAuthorityDecision[] }
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

/**
 * P1-10: physical provider request limit 统一 resolver。
 *
 * 优先级（冻结）：
 *   1. Harness explicit budget.maxModelCalls（strict physical cap）
 *   2. AgentOptions.maxPhysicalProviderRequests
 *   3. ORCANA_MAX_PROVIDER_REQUESTS
 *   4. derived = max(logicalMaxRounds * 2, logicalMaxRounds + 8)
 *      logicalMaxRounds = resolveMaxRounds(explicit maxRounds, ORCANA_MAX_ROUNDS)
 */
export function resolvePhysicalProviderBudget(options: {
  harnessExplicitMaxModelCalls?: number
  agentOptionsMaxPhysical?: number
  envProviderRequests?: number
  logicalMaxRounds?: number
}): number {
  if (Number.isFinite(options.harnessExplicitMaxModelCalls) && options.harnessExplicitMaxModelCalls! > 0) {
    return Math.floor(options.harnessExplicitMaxModelCalls!)
  }
  if (Number.isFinite(options.agentOptionsMaxPhysical) && options.agentOptionsMaxPhysical! > 0) {
    return Math.floor(options.agentOptionsMaxPhysical!)
  }
  if (Number.isFinite(options.envProviderRequests) && options.envProviderRequests! > 0) {
    return Math.floor(options.envProviderRequests!)
  }
  return deriveMaxPhysicalProviderRequests(options.logicalMaxRounds ?? 50)
}

// ── P1-9: Retry Authority decision audit ──

export type RetryDecisionKind = "provider_initial" | "provider_retry" | "tool" | "semanticRepair"

export interface RetryAuthorityDecision {
  action: "allow" | "deny"
  kind: RetryDecisionKind
  retryClass?: RetryClass
  fingerprint?: string
  reason?: RetryBlockReason
  sideEffectBoundaryCrossed: boolean
  physicalProviderRequests: number
  maxPhysicalProviderRequests: number
}

export type RetryDecisionObserver = (decision: RetryAuthorityDecision) => void

/** P1-9: bounded run-scoped decision history（不含 prompt / tool args / 凭据）。 */
export const RETRY_AUDIT_HISTORY_LIMIT = 256

export class RetryCoordinator {
  private readonly ledger: RetryLedger
  private readonly maxPhysical: number
  private externalConsumer?: PhysicalRequestBudgetConsumer
  private readonly observers = new Set<RetryDecisionObserver>()
  private readonly decisionHistory: RetryAuthorityDecision[] = []
  private physicalCount = 0

  constructor(options: RetryCoordinatorOptions = {}) {
    this.ledger = options.ledger ?? createRetryLedger()
    this.maxPhysical = options.maxPhysicalProviderRequests ?? deriveMaxPhysicalProviderRequests(50)
    this.externalConsumer = options.externalBudgetConsumer
    if (options.onDecision) this.attachDecisionObserver(options.onDecision)
  }

  /**
   * P0-4: 安全配置 external model-call budget consumer —— 允许在 run
   * 生命周期内（fresh / resume / node 执行前）绑定 BudgetGuard adapter，
   * 但绝不 reset physicalProviderRequests / retryLedger / decision history。
   * run-scope 的 coordinator object identity 保持不变（RUN_RETRY_COORDINATOR_INSTANCE_COUNT = 1）。
   */
  configureBudgetConsumer(consumer: PhysicalRequestBudgetConsumer | undefined): void {
    this.externalConsumer = consumer
  }

  /** P1-9: 附加 decision observer（runTrace 等；可多个）。 */
  attachDecisionObserver(observer: RetryDecisionObserver): void {
    this.observers.add(observer)
  }

  private recordDecision(decision: RetryAuthorityDecision): void {
    if (this.decisionHistory.length >= RETRY_AUDIT_HISTORY_LIMIT) this.decisionHistory.shift()
    this.decisionHistory.push(decision)
    for (const observer of this.observers) observer(decision)
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
    const kind: RetryDecisionKind = input.retryClass ? "provider_retry" : "provider_initial"
    // 2. side-effect boundary —— hard deny（优先级 > retry budget，§43）
    if (input.sideEffectBoundaryCrossed) {
      const decision: RetryAuthorityDecision = {
        action: "deny", kind, retryClass: input.retryClass, fingerprint: input.fingerprint,
        reason: "side_effect_boundary", sideEffectBoundaryCrossed: true,
        physicalProviderRequests: this.physicalCount, maxPhysicalProviderRequests: this.maxPhysical,
      }
      this.recordDecision(decision)
      return { allowed: false, reason: "side_effect_boundary", retryClass: input.retryClass, fingerprint: input.fingerprint }
    }
    // 3. retry class budget（initial attempt 无 retryClass，跳过）
    if (input.retryClass) {
      if (!this.ledger.canRetry(input.retryClass, input.fingerprint ?? "")) {
        this.recordDecision({
          action: "deny", kind, retryClass: input.retryClass, fingerprint: input.fingerprint,
          reason: "class_exhausted", sideEffectBoundaryCrossed: false,
          physicalProviderRequests: this.physicalCount, maxPhysicalProviderRequests: this.maxPhysical,
        })
        return { allowed: false, reason: "class_exhausted", retryClass: input.retryClass, fingerprint: input.fingerprint }
      }
    }
    // 4. global physical provider request budget（§22，Correction #13：
    //    numeric cap 先于 external reserve —— cap 满时外部预算绝不被消费）。
    if (this.physicalCount >= this.maxPhysical) {
      // 探测式触发既有 cancellation（§44）：harness 下 external 上限与
      // numeric cap 同值，此时 tryConsume 必 deny（reserve 抛错、不 commit
      // —— fail-safe，external budget 零消费）；仅借其 abort 信号，返回值
      // 被忽略。请求不发 ⇒ 外部预算不变（Correction #13 invariant）。
      this.externalConsumer?.tryConsume()
      this.recordDecision({
        action: "deny", kind, retryClass: input.retryClass, fingerprint: input.fingerprint,
        reason: "physical_request_budget", sideEffectBoundaryCrossed: false,
        physicalProviderRequests: this.physicalCount, maxPhysicalProviderRequests: this.maxPhysical,
      })
      return { allowed: false, reason: "physical_request_budget", retryClass: input.retryClass, fingerprint: input.fingerprint }
    }
    // 5. external model-call budget（harness —— BudgetGuard cancellation，
    //    §44）。此 check 之后不存在其他 deny —— budget consume 与请求发出
    //    严格绑定（atomicity）。direct agentLoop（无 consumer）跳过。
    if (this.externalConsumer) {
      const external = this.externalConsumer.tryConsume()
      if (!external.allowed) {
        this.recordDecision({
          action: "deny", kind, retryClass: input.retryClass, fingerprint: input.fingerprint,
          reason: "physical_request_budget", sideEffectBoundaryCrossed: false,
          physicalProviderRequests: this.physicalCount, maxPhysicalProviderRequests: this.maxPhysical,
        })
        return { allowed: false, reason: "physical_request_budget", retryClass: input.retryClass, fingerprint: input.fingerprint }
      }
    }
    // 6. record retry（只有 retry 才记账；deny 路径绝不 record —— R6/R7）
    if (input.retryClass) {
      this.ledger.record(input.retryClass, input.fingerprint ?? "")
    }
    // 7. increment physical request
    this.physicalCount += 1
    this.recordDecision({
      action: "allow", kind, retryClass: input.retryClass, fingerprint: input.fingerprint,
      sideEffectBoundaryCrossed: false,
      physicalProviderRequests: this.physicalCount, maxPhysicalProviderRequests: this.maxPhysical,
    })
    return { allowed: true, retryClass: input.retryClass, fingerprint: input.fingerprint }
  }

  /**
   * §40/§41/§42: 通用 retry 授权（tool protocol constrained recovery /
   * capability retry / semantic repair）。不发起 HTTP，不消费 physical。
   */
  authorizeRetry(input: Required<Pick<RetryAuthorizationInput, "retryClass" | "fingerprint">> & RetryAuthorizationInput): RetryPermit {
    const kind: RetryDecisionKind = input.retryClass === "semanticRepair" ? "semanticRepair" : "tool"
    if (input.sideEffectBoundaryCrossed) {
      this.recordDecision({
        action: "deny", kind, retryClass: input.retryClass, fingerprint: input.fingerprint,
        reason: "side_effect_boundary", sideEffectBoundaryCrossed: true,
        physicalProviderRequests: this.physicalCount, maxPhysicalProviderRequests: this.maxPhysical,
      })
      return { allowed: false, reason: "side_effect_boundary", retryClass: input.retryClass, fingerprint: input.fingerprint }
    }
    if (!this.ledger.canRetry(input.retryClass, input.fingerprint)) {
      this.recordDecision({
        action: "deny", kind, retryClass: input.retryClass, fingerprint: input.fingerprint,
        reason: "class_exhausted", sideEffectBoundaryCrossed: false,
        physicalProviderRequests: this.physicalCount, maxPhysicalProviderRequests: this.maxPhysical,
      })
      return { allowed: false, reason: "class_exhausted", retryClass: input.retryClass, fingerprint: input.fingerprint }
    }
    this.ledger.record(input.retryClass, input.fingerprint)
    this.recordDecision({
      action: "allow", kind, retryClass: input.retryClass, fingerprint: input.fingerprint,
      sideEffectBoundaryCrossed: false,
      physicalProviderRequests: this.physicalCount, maxPhysicalProviderRequests: this.maxPhysical,
    })
    return { allowed: true, retryClass: input.retryClass, fingerprint: input.fingerprint }
  }

  /** §45: 只读观测快照（trace 用，不消费任何预算；P1-9 含安全 audit）。 */
  summary(): RetryCoordinatorSummary {
    return {
      physicalProviderRequests: this.physicalCount,
      maxPhysicalProviderRequests: this.maxPhysical,
      retry: this.ledger.summary(),
      audit: { decisions: [...this.decisionHistory] },
    }
  }

  /** P1-9: 只读 decision history（安全快照，不含敏感载荷）。 */
  get audit(): { decisions: RetryAuthorityDecision[] } {
    return { decisions: [...this.decisionHistory] }
  }
}

export { RETRY_CLASS_LIMITS }
