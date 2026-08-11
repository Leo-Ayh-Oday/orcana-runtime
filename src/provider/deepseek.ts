/** DeepSeek V4 provider — streaming with thinking capture. */

import Anthropic from "@anthropic-ai/sdk"
import type { ProviderFinishInfo, StreamEvent, LLMProvider, ProviderCallOptions } from "./types"
import { providerFinishReasonFromErrorKind } from "./types"
import { providerRetryFingerprint } from "../runtime/retry-ledger"
import { repairToolCall } from "../tools/repair"
import { extractProviderTokenUsage } from "./usage"
import { classifyProviderError, denyProviderRetryFinish, formatProviderRetryStatus, providerRetryDelayMs, providerBackoffWait, canRetryProviderAttempt, recordProviderRetry, type ProviderErrorInfo } from "./retry"
import { bindProviderAbort, type ClosableAsyncIterable } from "./stream-lifecycle"

interface AnthropicLikeClient {
  messages: {
    stream(params: Anthropic.MessageCreateParams): AsyncIterable<unknown>
  }
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

    let unsafeToRetry = false
    let lastInfo: ProviderErrorInfo | undefined
    let attempt = 0
    while (true) {
      // RC-19 ABORT_RETRIED: an aborted request is never issued, and never
      // retried once the signal fires — including an abort landing in backoff.
      if (options.abortSignal?.aborted) {
        yield { type: "error", data: "provider request aborted" }
        yield { type: "finish", data: { finishReason: "cancelled", rawStopReason: undefined, completedToolCallCount: 0, partialToolCall: false } satisfies ProviderFinishInfo }
        return
      }
      if (attempt > 0 && lastInfo) {
        // IC04 §34: retry —— 先 backoff（abort 中不得计数下一次 request，
        // R5），backoff 后再经 RetryCoordinator 授权。
        const delayMs = providerRetryDelayMs(lastInfo, attempt - 1)
        yield { type: "status", data: formatProviderRetryStatus(lastInfo, delayMs, attempt - 1, this.maxRetries) }
        const waited = await providerBackoffWait(delayMs, options.abortSignal, this.sleep)
        if (!waited) {
          yield { type: "error", data: "provider request aborted during retry backoff" }
          yield { type: "finish", data: { finishReason: "cancelled", rawStopReason: undefined, completedToolCallCount: 0, partialToolCall: false } satisfies ProviderFinishInfo }
          return
        }
        const retryClass = lastInfo.kind === "rate_limit" ? "rateLimit" as const : "transport" as const
        const fingerprint = providerRetryFingerprint(lastInfo.kind, lastInfo.status)
        if (options.retryCoordinator) {
          // IC04: coordinator 是 retry decision authority（class budget +
          // physical budget + side-effect boundary，原子）。
          const permit = options.retryCoordinator.authorizeProviderAttempt({
            retryClass,
            fingerprint,
            sideEffectBoundaryCrossed: unsafeToRetry,
          })
          if (!permit.allowed) {
            // §36/§37: coordinator 决定不再发起同 request —— 以最后一次
            // 真实 provider 失败结构化终止（不继续整个 Agent round）。
            yield* denyProviderRetryFinish(lastInfo)
            return
          }
        } else {
          // §35: standalone/legacy —— maxRetries + RetryLedger compatibility。
          // canRetryProviderAttempt 的 attempt 语义 = 上次失败尝试序号
          // （attempt 在本循环 = 已失败次数，故传 attempt - 1）。
          if (!canRetryProviderAttempt(lastInfo, attempt - 1, this.maxRetries, unsafeToRetry, options.retryLedger)) {
            yield* denyProviderRetryFinish(lastInfo)
            return
          }
          recordProviderRetry(lastInfo, options.retryLedger)
        }
      }
      try {
        yield* this.streamOnce(params, value => { unsafeToRetry = value }, options)
        return
      } catch (e) {
        if (options.abortSignal?.aborted) {
          yield { type: "error", data: "provider request aborted" }
          yield { type: "finish", data: { finishReason: "cancelled", rawStopReason: undefined, completedToolCallCount: 0, partialToolCall: false } satisfies ProviderFinishInfo }
          return
        }
        lastInfo = classifyProviderError(e)
        if (!lastInfo.retryable || unsafeToRetry) {
          yield* denyProviderRetryFinish(lastInfo)
          return
        }
        // legacy 上限（coordinator 模式下授权 deny 才是终止权威）。
        // attempt = 已失败次数：允许至多 maxRetries 次 retry。
        if (!options.retryCoordinator && attempt > this.maxRetries) {
          yield* denyProviderRetryFinish(lastInfo)
          return
        }
        attempt += 1
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
            // RC-19 STREAM_REPLAY_SIDE_EFFECT: thinking deltas are emitted
            // (buffered for the thinking store) — the stream is no longer
            // replayable; a retry would duplicate reasoning output.
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
          }
          break
        }
        case "content_block_stop": {
          if (ct) {
            let input: Record<string, unknown>
            if (!ct.input_json && ct.initialInput) {
              input = ct.initialInput
            } else {
              // 一律走 repairToolCall：其内部先做字段别名 + Python 字面量预处理，
              // 再尝试解析。直接 JSON.parse 成功会跳过字段别名修复——{"filePath":...}
              // 是合法 JSON，但字段名需规范化为 {"path":...}（repair.ts 头部注释点名的坑）。
              const repaired = repairToolCall(ct.input_json)
              if (repaired) input = repaired
              else {
                toolCallError = `provider returned invalid tool call JSON for ${ct.name}`
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
      //  - partial tool（ct 未 closed）：本批次 0 tool_call（PARTIAL_TOOL_CALL_EXECUTED = 0），
      //    即使前面已有 completed tool 也不执行（partial batch fail-closed）。
      //  - 无 partial：closed tool 是完整副作用 → exactly once emit。
      if (ct) {
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
      // IC03: 未知 stop reason → malformed（结构化），非 generic error。
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
