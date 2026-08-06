/** ORMB 用例契约 — mock（确定性流）与 live（真实 V4-Flash）两类。 */

import type { StreamEvent } from "../../../src/provider/types"
import type { HardGateName } from "./metrics"

export interface MBEAssertion {
  label: string
  passed: boolean
  detail: string
  /** 关联的 Hard Gate —— gate 断言失败会计入对应硬门计数。 */
  gate?: HardGateName
}

/** Mock 用例上下文 — collect 单次（或 twoRound 两次）streamChat 的产物。 */
export interface MBEMockContext {
  events: StreamEvent[]
  calls: number
  closed: string[]
  sleepsMs: number[]
}

export interface MBEMockCase {
  caseId: string
  title: string
  tags: string[]
  description?: string
  /** 依次消费的 mock 流；重试场景：前 N-1 个抛错/断流，最后一个正常。 */
  streams: Array<() => AsyncGenerator<unknown>>
  maxRetries?: number
  /** 事件级 abort 脚本：返回 true 即触发本地 abort（测 ABORT_IGNORED）。 */
  abortWhen?: (event: StreamEvent) => boolean
  /** 两轮 Tool Loop：第一轮 model 发 tool_call，第二轮喂回 result 后给最终答案。 */
  twoRound?: boolean
  /** 断言校验器。 */
  assert: (ctx: MBEMockContext) => MBEAssertion[]
}

/** Live 用例 — 真实 deepseek-v4-flash，需要网络（经代理）。 */
export interface MBELiveCase {
  caseId: string
  title: string
  tags: string[]
  description?: string
  /** 传给模型的用户指令（诱导 2-5 次 Tool Loop）。 */
  prompt: string
  /** 真实工具集：name → 执行器。执行器返回字符串结果。 */
  tools: Record<string, (input: Record<string, unknown>) => Promise<string>>
  /** 期望的最少 tool 轮次。 */
  minRounds: number
  /** 期望的最多 tool 轮次（防无限循环）。 */
  maxRounds: number
  maxTokens?: number
  thinking?: boolean
  /** abort 触发：第几轮之后 abort。 */
  abortAfterRound?: number
  assert: (ctx: MBELiveContext) => MBEAssertion[]
}

export interface MBELiveContext {
  /** 每轮 provider streamChat 的事件。 */
  rounds: Array<{ events: StreamEvent[]; usage?: Record<string, unknown>; modelActual?: string; durationMs: number }>
  toolCalls: Array<{ round: number; id: string; name: string; input: Record<string, unknown> }>
  aborted: boolean
  sleepsMs: number[]
}
