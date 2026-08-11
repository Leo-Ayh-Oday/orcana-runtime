import type { ProviderFinishReason, ProviderTokenUsage } from "../../provider/types"
import type {
  ProviderFailure,
  RoundToolCall,
  ThinkingBlock,
} from "../run/types"

export interface ProviderRoundResult {
  textChunks: string[]
  finalText: string
  thinkingBlocks: ThinkingBlock[]
  toolCalls: RoundToolCall[]
  usage: ProviderTokenUsage | null
  failure?: ProviderFailure
  bufferedTextEmitted: boolean
  aborted: boolean
  /**
   * IC03: 结构化 Provider 结束原因 —— Kernel production decision 的唯一
   * 事实来源。complete/tool_action/truncated_* 不是 failure。
   */
  finishReason: ProviderFinishReason
  /** Provider 原生 stop_reason（end_turn / max_tokens / length ...）。 */
  rawStopReason?: string
  /** finish 事件声明的已完成 Tool Call 数量。 */
  completedToolCallCount: number
  /** 流结束时存在未 closed 的 tool block。 */
  partialToolCall: boolean
  /**
   * GATE-02 legacy: "truncated"（max_tokens — tool calls were still emitted
   * and execute; no failure is recorded, so no blind retry is possible）。
   * Deprecated compatibility only —— 新的 Kernel production decision 不得
   * 继续依赖这个旧 stopReason。
   */
  stopReason?: "truncated"
  /** RC-19 Phase 1: provider round identity + side-effect boundary. */
  requestId?: string
  sideEffectBoundaryCrossed?: boolean
}

export function createProviderRoundResult(): ProviderRoundResult {
  return {
    textChunks: [],
    finalText: "",
    thinkingBlocks: [],
    toolCalls: [],
    usage: null,
    bufferedTextEmitted: false,
    aborted: false,
    finishReason: "complete",
    completedToolCallCount: 0,
    partialToolCall: false,
  }
}
