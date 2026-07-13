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
  fetch?: typeof fetch
  maxRetries?: number
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"

function normalizeDeepSeekBaseURL(baseURL: string | undefined): string {
  const value = (baseURL ?? DEFAULT_DEEPSEEK_ANTHROPIC_BASE_URL).trim().replace(/\/+$/, "")
  try {
    const url = new URL(value)
    if (url.hostname.toLowerCase() === "api.deepseek.com" && (url.pathname === "" || url.pathname === "/")) {
      return `${url.origin}/anthropic`
    }
  } catch {
    // Let the SDK surface malformed custom URLs with its normal diagnostics.
  }
  return value
}

export class DeepSeekProvider implements LLMProvider {
  private client: AnthropicLikeClient
  private maxRetries: number
  private sleep: (ms: number) => Promise<void>

  constructor(apiKey: string, baseURLOrOptions: string | DeepSeekProviderOptions = "https://api.deepseek.com/anthropic") {
    const options = typeof baseURLOrOptions === "string" ? { baseURL: baseURLOrOptions } : baseURLOrOptions
    this.client = options.client ?? new Anthropic({
      apiKey,
      baseURL: normalizeDeepSeekBaseURL(options.baseURL),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      timeout: 120_000,
    })
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
    let ct: { id: string; name: string; input_json: string; initialInput: Record<string, unknown> | null } | null = null
    let cthink: { thinking: string; signature: string } | null = null
    const toolBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
    const thinkingBlocks: Array<{ thinking: string; signature: string }> = []
    const stream = this.client.messages.stream(params) as ClosableAsyncIterable
    let stopReason = ""
    let toolCallError = ""
    const abortStream = () => closeProviderStream(stream)
    options.abortSignal?.addEventListener("abort", abortStream, { once: true })

    try {
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
            ct = {
              id: String(b.id),
              name: String(b.name),
              input_json: "",
              initialInput: isRecord(b.input) ? b.input : null,
            }
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
    } finally {
      options.abortSignal?.removeEventListener("abort", abortStream)
    }

    if (!stopReason) {
      yield { type: "error", data: "provider stream ended unexpectedly without stop_reason" }
      return
    }
    if (toolCallError) {
      yield { type: "error", data: toolCallError }
      return
    }
    if (ct) {
      yield { type: "error", data: "provider stream ended with an incomplete tool call" }
      return
    }
    yield { type: "status", data: `provider-stop: ${stopReason}` }
    if (!NORMAL_STOP_REASONS.has(stopReason)) {
      const detail = stopReason === "max_tokens"
        ? "response hit the output token limit before completion"
        : "response ended before normal completion"
      yield { type: "error", data: `provider stop_reason=${stopReason}: ${detail}` }
      return
    }

    for (const tb of toolBlocks) {
      yield { type: "tool_call", data: { id: tb.id, name: tb.name, input: tb.input } }
    }
    if (thinkingBlocks.length) yield { type: "thinking_blocks", data: thinkingBlocks }
    if (cthink?.thinking) {
      thinkingBlocks.push({ thinking: cthink.thinking, signature: cthink.signature ?? "" })
      yield { type: "thinking_blocks", data: thinkingBlocks }
    }
    const finalText = textChunks.join("")
    if (finalText && toolBlocks.length === 0) yield { type: "done", data: finalText }
  }
}

const NORMAL_STOP_REASONS = new Set(["end_turn", "stop_sequence", "tool_use"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function closeProviderStream(stream: ClosableAsyncIterable): void {
  try { stream.controller?.abort?.() } catch { /* best effort */ }
  try { stream.abort?.() } catch { /* best effort */ }
  try { void stream.return?.() } catch { /* best effort */ }
}
