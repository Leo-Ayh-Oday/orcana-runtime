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
