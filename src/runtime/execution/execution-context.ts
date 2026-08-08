/** LR2-0D（ADR-LR2-001）：ExecutionContext —— 只能由 Harness 与
 *  Graph Runtime 构造的受信执行上下文。
 *
 *  携带批准能力、副作用类别、workspace 权威、秘密授权与批准令牌；
 *  Gateway 将其绑定到 async-local 后执行，底层 process-executor 的
 *  requireExecutionAuthority 自动生效（fail-closed）。
 */

import type { TrustedExecutionAuthority } from "../linux/contracts"
import { runWithRuntimeExecutionContext, setExecutionAuthority, createRuntimeExecutionContext, getExecutionAuthority } from "../execution-context"

export type SideEffectClass = "read" | "write" | "network" | "external"

export interface ExecutionContext {
  /** 批准能力（Harness 授权链产物）。 */
  approvedCapabilityId: string
  sideEffectClass: SideEffectClass
  /** 受信执行权威（身份 + workspace 授权）。 */
  authority: TrustedExecutionAuthority
  assignmentId?: string
  agentId?: string
  secretGrants?: string[]
  approvalToken?: string
}

/** 将受信 Context 绑定到 async-local 并执行 fn（同 AgentRunScope 机制）。 */
export function runWithExecutionContext<T>(context: ExecutionContext, fn: () => T): T {
  const runtimeContext = createRuntimeExecutionContext({ id: `execution-${context.approvedCapabilityId}` })
  return runWithRuntimeExecutionContext(runtimeContext, () => {
    setExecutionAuthority(context.authority)
    return fn()
  })
}

/** 从 async-local 读取当前受信权威（未设置时 undefined）。 */
export function currentExecutionAuthority(): TrustedExecutionAuthority | undefined {
  return getExecutionAuthority()
}
