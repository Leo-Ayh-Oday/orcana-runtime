/** DeepSeek V4 provider — streaming with thinking capture. */

import Anthropic from "@anthropic-ai/sdk"
import type { StreamEvent, LLMProvider, ProviderCallOptions } from "./types"
import { repairToolCall } from "../tools/repair"
import { extractProviderTokenUsage } from "./usage"
import { classifyProviderError, formatProviderRetryStatus, providerRetryDelayMs } from "./retry"

interface AnthropicLikeClient {
  messages: {
    stream(params: Anthropic.MessageCreateParams): AsyncIterable<unknown>
  }
}

interface ClosableAsyncIterable extends AsyncIterable<unknown> {
  controller?: { abort?: () => void }
  abort?: () => void
  return?: () => Promise<unknown>
}

interface DeepSeekProviderOptions {
  baseURL?: string
  client?: AnthropicLikeClient
  maxRetries?: number
  sleep?: (ms: number) => Promise<void>
}

export class DeepSeekProvider implements LLMProvider {
  private client: AnthropicLikeClient
  private maxRetries: number
  private sleep: (ms: number) => Promise<void>

  constructor(apiKey: string, baseURLOrOptions: string | DeepSeekProviderOptions = "https://api.deepseek.com/anthropic") {
    const options = typeof baseURLOrOptions === "string" ? { baseURL: baseURLOrOptions } : baseURLOrOptions
    this.client = options.client ?? new Anthropic({ apiKey, baseURL: options.baseURL ?? "https://api.deepseek.com/anthropic", timeout: 120_000 })
    this.maxRetries = options.maxRetries ?? 3
    this.sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  }

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    // ── Prefix cache optimization: mark system + first message with cache_control ──
    // DeepSeek Anthropic-compatible endpoint uses the same cache_control format.
    // System prompt is cached as a standalone prefix; first user message (stable
    // prefix) creates a second cache breakpoint. Unknown fields are ignored by
    // servers that don't support it.

    const cacheControl = { type: "ephemeral" as const }

    const systemBlock = typeof options.system === "string"
      ? [{ type: "text" as const, text: options.system, cache_control: cacheControl }]
      : options.system  // already blocks, leave as-is

    const messagesOut = options.messages.map((m, i) => {
      if (i === 0 && typeof m.content === "string") {
        return {
          role: m.role,
          content: [
            { type: "text" as const, text: m.content, cache_control: cacheControl },
          ],
        }
      }
      return m
    })

    const params: Anthropic.MessageCreateParams = {
      model: options.model as Anthropic.Model,
      max_tokens: options.maxTokens,
      system: systemBlock,
      messages: messagesOut as unknown as Anthropic.MessageParam[],
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
    let ct: { id: string; name: string; input_json: string } | null = null
    let cthink: { thinking: string; signature: string } | null = null
    const toolBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
    const thinkingBlocks: Array<{ thinking: string; signature: string }> = []
    const stream = this.client.messages.stream(params) as ClosableAsyncIterable
    let stopReason = ""

    for await (const event of stream) {
      if (options.abortSignal?.aborted) {
        closeProviderStream(stream)
        yield { type: "status", data: "provider-stream: aborted by local budget guard" }
        break
      }

      const providerUsage = extractProviderTokenUsage(event)
      if (providerUsage) {
        yield {
          type: "token_usage",
          data: {
            ...providerUsage,
            requestedModel: options.model,
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
              requestedModel: options.model,
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
                // JSON completely unrepairable — yield partial tool call with raw input
                toolBlocks.push({ id: ct.id, name: ct.name, input: { _raw: ct.input_json.slice(0, 500) } })
                ct = null
                continue
              }
            }
            toolBlocks.push({ id: ct.id, name: ct.name, input })
            ct = null
          }
          // Signature may be empty string (DeepSeek V4 sometimes omits it via Anthropic compat).
          // Only check thinking content — empty signature is valid.
          if (cthink?.thinking) {
            thinkingBlocks.push({ thinking: cthink.thinking, signature: cthink.signature ?? "" })
            cthink = null
          }
          break
        }
        case "message_delta": {
          const delta = event.delta
          if (isRecord(delta) && typeof delta.stop_reason === "string") {
            stopReason = delta.stop_reason
          }
          break
        }
      }
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
