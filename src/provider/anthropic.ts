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
import type { StreamEvent, LLMProvider, ProviderCallOptions } from "./types"
import { repairToolCall } from "../tools/repair"
import { extractProviderTokenUsage } from "./usage"
import { classifyProviderError, formatProviderRetryStatus, providerRetryDelayMs } from "./retry"

interface ClosableAsyncIterable extends AsyncIterable<unknown> {
  controller?: { abort?: () => void }
  abort?: () => void
  return?: () => Promise<unknown>
}

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
      let unsafeToRetry = false
      try {
        yield* this.streamOnce(params, value => { unsafeToRetry = value }, options)
        return
      } catch (e) {
        const info = classifyProviderError(e)
        const canRetry = info.retryable && !unsafeToRetry && attempt < this.maxRetries
        if (!canRetry) {
          yield { type: "error", data: info.status ? `${info.kind} ${info.status}: ${info.message}` : `${info.kind}: ${info.message}` }
          return
        }
        const delayMs = providerRetryDelayMs(info, attempt)
        yield { type: "status", data: formatProviderRetryStatus(info, delayMs, attempt, this.maxRetries) }
        await this.sleep(delayMs)
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
    let ct: { id: string; name: string; input_json: string } | null = null
    let cthink: { thinking: string; signature: string } | null = null
    let stopReason = ""

    const stream = this.client.messages.stream(params) as ClosableAsyncIterable
    const abortStream = () => closeProviderStream(stream)
    options.abortSignal?.addEventListener("abort", abortStream, { once: true })

    try {
      for await (const event of stream) {
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
            ct = { id: String(b.id), name: String(b.name), input_json: "" }
          } else if (isRecord(b) && b.type === "thinking") {
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
            let input: Record<string, unknown> = {}
            try {
              input = JSON.parse(ct.input_json)
            } catch {
              const repaired = repairToolCall(ct.input_json)
              if (repaired) input = repaired
              else {
                toolBlocks.push({ id: ct.id, name: ct.name, input: { _raw: ct.input_json.slice(0, 500) } })
                ct = null
                continue
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
    } finally {
      options.abortSignal?.removeEventListener("abort", abortStream)
    }

    for (const tb of toolBlocks) {
      yield { type: "tool_call", data: { id: tb.id, name: tb.name, input: tb.input } }
    }
    if (thinkingBlocks.length) yield { type: "thinking_blocks", data: thinkingBlocks }

    // Flush partial state from interrupted stream
    if (ct && ct.input_json) {
      let input: Record<string, unknown> = { _raw: ct.input_json.slice(0, 500) }
      try { input = JSON.parse(ct.input_json) } catch { /* partial, emit as is */ }
      yield { type: "tool_call", data: { id: ct.id, name: ct.name, input } }
    }
    if (cthink?.thinking) {
      thinkingBlocks.push({ thinking: cthink.thinking, signature: cthink.signature ?? "" })
      yield { type: "thinking_blocks", data: thinkingBlocks }
    }

    if (stopReason) yield { type: "status", data: `provider-stop: ${stopReason}` }
    if (stopReason === "max_tokens") {
      yield { type: "error", data: "provider stop_reason=max_tokens: response hit the output token limit before completion" }
      return
    }

    const finalText = textChunks.join("")
    if (finalText && toolBlocks.length === 0) yield { type: "done", data: finalText }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function closeProviderStream(stream: ClosableAsyncIterable): void {
  try { stream.controller?.abort?.() } catch { /* best effort */ }
  try { stream.abort?.() } catch { /* best effort */ }
  try { void stream.return?.() } catch { /* best effort */ }
}
