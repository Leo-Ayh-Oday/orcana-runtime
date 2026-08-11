/** Anthropic native provider — connects to api.anthropic.com.
 *
 *  Same streaming architecture as DeepSeekProvider (Anthropic SDK under the hood),
 *  but targets the real Anthropic endpoint with native cache/thinking handling.
 *
 *  Key differences from DeepSeekProvider:
 *    - Native prompt caching (cache_control breakpoints) — not Anthropic-compatible mode
 *    - Stricter thinking block validation
 *    - Higher default timeout (Anthropic can be slower than DeepSeek)
 */

import Anthropic from "@anthropic-ai/sdk"
import type { ProviderFinishInfo, StreamEvent, LLMProvider, ProviderCallOptions } from "./types"
import { providerFinishReasonFromErrorKind } from "./types"
import { repairToolCall } from "../tools/repair"
import { extractProviderTokenUsage } from "./usage"
import { classifyProviderError, formatProviderRetryStatus, providerRetryDelayMs, providerBackoffWait, canRetryProviderAttempt, recordProviderRetry } from "./retry"
import { bindProviderAbort, type ClosableAsyncIterable } from "./stream-lifecycle"

interface AnthropicLikeClient {
  messages: { stream(params: Anthropic.MessageCreateParams): AsyncIterable<unknown> }
}

export class AnthropicProvider implements LLMProvider {
  private client: AnthropicLikeClient
  private maxRetries: number
  private sleep: (ms: number) => Promise<void>

  constructor(
    apiKey: string,
    options: {
      baseURL?: string
      maxRetries?: number
      sleep?: (ms: number) => Promise<void>
      client?: AnthropicLikeClient
    } = {},
  ) {
    this.client = options.client ?? new Anthropic({
      apiKey,
      baseURL: options.baseURL ?? "https://api.anthropic.com",
      timeout: 180_000, // Anthropic can be slower than DeepSeek
    })
    this.maxRetries = options.maxRetries ?? 3
    this.sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  }

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    const cacheControl = { type: "ephemeral" as const }
    const system = typeof options.system === "string"
      ? [{ type: "text" as const, text: options.system, cache_control: cacheControl }]
      : options.system
    const messages = options.messages.map((message, index) => {
      if (index === 0 && typeof message.content === "string") {
        return {
          role: message.role,
          content: [{ type: "text" as const, text: message.content, cache_control: cacheControl }],
        }
      }
      return message
    })
    const params: Anthropic.MessageCreateParams = {
      model: options.model as Anthropic.Model,
      max_tokens: options.maxTokens,
      system,
      messages: messages as Anthropic.MessageParam[],
    }
    if (options.tools?.length) params.tools = options.tools as unknown as Anthropic.Tool[]
    if (options.thinking) params.thinking = options.thinking as Anthropic.ThinkingConfigParam

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // RC-19 ABORT_RETRIED: an aborted request is never issued, and never
      // retried once the signal fires — including an abort landing in backoff.
      if (options.abortSignal?.aborted) {
        yield { type: "error", data: "provider request aborted" }
        yield { type: "finish", data: { finishReason: "cancelled", rawStopReason: undefined, completedToolCallCount: 0, partialToolCall: false } satisfies ProviderFinishInfo }
        return
      }
      let unsafeToRetry = false
      try {
        yield* this.streamOnce(params, value => { unsafeToRetry = value }, options)
        return
      } catch (e) {
        if (options.abortSignal?.aborted) {
          yield { type: "error", data: "provider request aborted" }
          yield { type: "finish", data: { finishReason: "cancelled", rawStopReason: undefined, completedToolCallCount: 0, partialToolCall: false } satisfies ProviderFinishInfo }
          return
        }
        const info = classifyProviderError(e)
        const canRetry = canRetryProviderAttempt(info, attempt, this.maxRetries, unsafeToRetry, options.retryLedger)
        if (!canRetry) {
          yield { type: "error", data: info.status ? `${info.kind} ${info.status}: ${info.message}` : `${info.kind}: ${info.message}` }
          yield { type: "finish", data: { finishReason: providerFinishReasonFromErrorKind(info.kind), rawStopReason: undefined, completedToolCallCount: 0, partialToolCall: false } satisfies ProviderFinishInfo }
          return
        }
        recordProviderRetry(info, options.retryLedger)
        const delayMs = providerRetryDelayMs(info, attempt)
        yield { type: "status", data: formatProviderRetryStatus(info, delayMs, attempt, this.maxRetries) }
        const waited = await providerBackoffWait(delayMs, options.abortSignal, this.sleep)
        if (!waited) {
          yield { type: "error", data: "provider request aborted during retry backoff" }
          yield { type: "finish", data: { finishReason: "cancelled", rawStopReason: undefined, completedToolCallCount: 0, partialToolCall: false } satisfies ProviderFinishInfo }
          return
        }
      }
    }
  }

  private async *streamOnce(
    params: Anthropic.MessageCreateParams,
    markUnsafeToRetry: (value: boolean) => void,
    options: ProviderCallOptions,
  ): AsyncGenerator<StreamEvent> {
    const textChunks: string[] = []
    const toolBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
    const thinkingBlocks: Array<{ thinking: string; signature: string }> = []
    let ct: { id: string; name: string; input_json: string; initialInput: Record<string, unknown> | null } | null = null
    let cthink: { thinking: string; signature: string } | null = null
    let stopReason = ""
    let toolCallError = ""

    const stream = this.client.messages.stream(params) as ClosableAsyncIterable
    const abortBinding = bindProviderAbort(stream, options.abortSignal)

    try {
      for await (const event of stream) {
        if (abortBinding.isAborted()) break

        const providerUsage = extractProviderTokenUsage(event)
        if (providerUsage) {
          yield {
            type: "token_usage",
            data: {
              ...providerUsage,
              requestedModel: params.model,
              purpose: options.purpose ?? "unknown",
            },
          }
        }

        if (!isRecord(event) || typeof event.type !== "string") continue

      if (event.type === "message_start") {
        const message = isRecord(event.message) ? event.message : null
        if (typeof message?.model === "string") {
          yield {
            type: "token_usage",
            data: {
              requestedModel: params.model,
              actualModel: message.model,
              purpose: options.purpose ?? "unknown",
              source: "provider",
            },
          }
        }
      }

        switch (event.type) {
        case "content_block_start": {
          const b = event.content_block
          if (isRecord(b) && b.type === "tool_use") {
            markUnsafeToRetry(true)
            ct = {
              id: String(b.id),
              name: String(b.name),
              input_json: "",
              initialInput: isRecord(b.input) ? b.input : null,
            }
          } else if (isRecord(b) && b.type === "thinking") {
            // RC-19 STREAM_REPLAY_SIDE_EFFECT: thinking deltas are emitted —
            // the stream is no longer replayable; a retry would duplicate
            // reasoning output.
            markUnsafeToRetry(true)
            cthink = { thinking: "", signature: String(b.signature ?? "") }
          }
          break
        }
        case "content_block_delta": {
          const d = event.delta
          if (isRecord(d) && d.type === "text_delta") {
            markUnsafeToRetry(true)
            textChunks.push(String(d.text ?? ""))
            yield { type: "text", data: String(d.text ?? "") }
          } else if (isRecord(d) && d.type === "input_json_delta" && ct) {
            ct.input_json += String(d.partial_json ?? "")
          } else if (isRecord(d) && d.type === "thinking_delta" && cthink) {
            cthink.thinking += String(d.thinking ?? "")
          } else if (isRecord(d) && d.type === "signature_delta" && cthink) {
            cthink.signature += String(d.signature ?? "")
          }
          break
        }
          case "content_block_stop": {
          if (ct) {
            let input: Record<string, unknown>
            if (!ct.input_json && ct.initialInput) {
              input = ct.initialInput
            } else {
              try {
                input = JSON.parse(ct.input_json)
              } catch {
                const repaired = repairToolCall(ct.input_json)
                if (repaired) input = repaired
                else {
                  toolCallError = `provider returned invalid tool call JSON for ${ct.name}`
                  ct = null
                  continue
                }
              }
            }
            toolBlocks.push({ id: ct.id, name: ct.name, input })
            ct = null
          }
          if (cthink?.thinking) {
            thinkingBlocks.push({ thinking: cthink.thinking, signature: cthink.signature ?? "" })
            cthink = null
          }
            break
          }
          case "message_delta": {
            const delta = event.delta
            if (isRecord(delta) && typeof delta.stop_reason === "string") stopReason = delta.stop_reason
            break
          }
        }
      }
    } catch (error) {
      if (!abortBinding.isAborted()) throw error
    } finally {
      abortBinding.dispose()
    }

    if (abortBinding.isAborted() && !stopReason) {
      yield { type: "status", data: "provider-stream: aborted by local budget guard" }
      yield { type: "finish", data: { finishReason: "cancelled", rawStopReason: undefined, completedToolCallCount: 0, partialToolCall: false } satisfies ProviderFinishInfo }
      return
    }
    if (!stopReason) {
      // IC03: malformed（结构缺失），不是 generic retryable error。
      yield { type: "error", data: "provider stream ended unexpectedly without stop_reason" }
      yield { type: "finish", data: { finishReason: "malformed", rawStopReason: undefined, completedToolCallCount: toolBlocks.length, partialToolCall: ct !== null } satisfies ProviderFinishInfo }
      return
    }
    yield { type: "status", data: `provider-stop: ${stopReason}` }
    if (toolCallError) {
      // IC03: 正常 stop 但 closed tool block 非法结构 → malformed。
      yield { type: "error", data: toolCallError }
      yield { type: "finish", data: { finishReason: "malformed", rawStopReason: stopReason, completedToolCallCount: toolBlocks.length, partialToolCall: false } satisfies ProviderFinishInfo }
      return
    }
    if (stopReason === "max_tokens") {
      // GATE-02 (GS-03/GS-05) + IC03 结构化：TRUNCATED 不是 error。
      if (ct) {
        // partial tool：本批次 0 tool_call（PARTIAL_TOOL_CALL_EXECUTED = 0）。
        if (cthink?.thinking) {
          thinkingBlocks.push({ thinking: cthink.thinking, signature: cthink.signature ?? "" })
        }
        if (thinkingBlocks.length) yield { type: "thinking_blocks", data: thinkingBlocks }
        yield { type: "truncated", data: { stopReason: "max_tokens", toolCalls: 0, incomplete: true } }
        yield { type: "finish", data: { finishReason: "truncated_partial_tool", rawStopReason: "max_tokens", completedToolCallCount: toolBlocks.length, partialToolCall: true } satisfies ProviderFinishInfo }
        return
      }
      for (const tb of toolBlocks) {
        yield { type: "tool_call", data: { id: tb.id, name: tb.name, input: tb.input } }
      }
      if (cthink?.thinking) {
        thinkingBlocks.push({ thinking: cthink.thinking, signature: cthink.signature ?? "" })
      }
      if (thinkingBlocks.length) yield { type: "thinking_blocks", data: thinkingBlocks }
      const completeCount = toolBlocks.length
      yield { type: "truncated", data: { stopReason: "max_tokens", toolCalls: completeCount } }
      yield { type: "finish", data: {
        finishReason: completeCount > 0 ? "truncated_after_action" : "truncated_before_action",
        rawStopReason: "max_tokens",
        completedToolCallCount: completeCount,
        partialToolCall: false,
      } satisfies ProviderFinishInfo }
      return
    }
    if (!NORMAL_STOP_REASONS.has(stopReason)) {
      // IC03: 未知 stop reason → malformed（结构化）。
      yield { type: "error", data: `provider stop_reason=${stopReason}: response ended before normal completion` }
      yield { type: "finish", data: { finishReason: "malformed", rawStopReason: stopReason, completedToolCallCount: toolBlocks.length, partialToolCall: ct !== null } satisfies ProviderFinishInfo }
      return
    }
    if (ct) {
      // 正常 stop 但 tool 未 closed → 不可恢复非法结构（fail-closed）。
      yield { type: "error", data: "provider stream ended with an incomplete tool call" }
      yield { type: "finish", data: { finishReason: "malformed", rawStopReason: stopReason, completedToolCallCount: toolBlocks.length, partialToolCall: true } satisfies ProviderFinishInfo }
      return
    }

    for (const tb of toolBlocks) {
      yield { type: "tool_call", data: { id: tb.id, name: tb.name, input: tb.input } }
    }
    if (cthink?.thinking) {
      thinkingBlocks.push({ thinking: cthink.thinking, signature: cthink.signature ?? "" })
    }
    if (thinkingBlocks.length) yield { type: "thinking_blocks", data: thinkingBlocks }

    const finalText = textChunks.join("")
    if (finalText && toolBlocks.length === 0) yield { type: "done", data: finalText }
    // IC03: tool_use / end_turn / stop_sequence → 结构化 finish。
    yield { type: "finish", data: {
      finishReason: toolBlocks.length > 0 ? "tool_action" : "complete",
      rawStopReason: stopReason,
      completedToolCallCount: toolBlocks.length,
      partialToolCall: false,
    } satisfies ProviderFinishInfo }
  }
}

const NORMAL_STOP_REASONS = new Set(["end_turn", "stop_sequence", "tool_use"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
