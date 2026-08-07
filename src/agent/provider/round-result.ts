import type { ProviderTokenUsage } from "../../provider/types"
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
   * GATE-02: how the provider round ended. "normal" (end_turn/tool_use),
   * "truncated" (max_tokens — tool calls were still emitted and execute;
   * no failure is recorded, so no blind retry is possible), or "interrupted"
   * (stream ended without stop_reason).
   */
  stopReason?: "normal" | "truncated" | "interrupted"
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
  }
}
