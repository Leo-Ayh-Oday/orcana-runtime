/** OpenAI provider — connects via OpenAI-compatible chat completions API.
 *
 *  Uses raw fetch() instead of the OpenAI SDK to avoid a heavy dependency.
 *  Handles the Anthropic ↔ OpenAI format conversion:
 *    - Tools: Anthropic {name, description, input_schema} ↔ OpenAI {type:"function", function:{...}}
 *    - Messages: system prompt goes into messages array (OpenAI has no separate system param)
 *    - Thinking: OpenAI doesn't have a thinking API — stripped for now
 *    - Streaming: SSE (server-sent events) parsing
 *
 *  StreamEvent output shape is identical to DeepSeekProvider/AnthropicProvider
 *  so loop.ts doesn't know the difference.
 */

import type { StreamEvent, LLMProvider, ProviderCallOptions, ProviderTokenUsage } from "./types"
import { classifyProviderError, formatProviderRetryStatus, providerRetryDelayMs, canRetryProviderAttempt, providerBackoffWait, recordProviderRetry } from "./retry"
import { repairToolCall } from "../tools/repair"
import { extractProviderTokenUsage } from "./usage"
import {
  buildToolProtocolDiagnostic,
  createToolCallAssembler,
  formatToolProtocolDiagnostic,
  validateToolCallInput,
  type ToolProtocolFailureKind,
} from "./tool-call-assembler"

interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

interface OpenAIStreamChunk {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: "function"
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export class OpenAIProvider implements LLMProvider {
  private apiKey: string
  private baseURL: string
  private maxRetries: number
  private sleep: (ms: number) => Promise<void>
  private fetchFn: typeof fetch

  private chatCompletionsURL(): string {
    const value = this.baseURL.trim().replace(/\/+$/, "")
    return /\/chat\/completions$/i.test(value) ? value : `${value}/chat/completions`
  }

  constructor(
    apiKey: string,
    options: {
      baseURL?: string
      maxRetries?: number
      sleep?: (ms: number) => Promise<void>
      fetch?: typeof fetch
    } = {},
  ) {
    this.apiKey = apiKey
    this.baseURL = options.baseURL ?? "https://api.openai.com/v1"
    this.maxRetries = options.maxRetries ?? 3
    this.sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
    this.fetchFn = options.fetch ?? fetch
  }

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    const body = this.buildRequestBody(options)

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // RC-19 ABORT_RETRIED: an aborted request is never issued, and never
      // retried once the signal fires — including an abort landing in backoff.
      if (options.abortSignal?.aborted) {
        yield { type: "error", data: "provider request aborted" }
        return
      }
      let unsafeToRetry = false
      try {
        yield* this.streamOnce(body, value => { unsafeToRetry = value }, options)
        return
      } catch (e) {
        if (options.abortSignal?.aborted) {
          yield { type: "error", data: "provider request aborted" }
          return
        }
        const info = classifyProviderError(e)
        const canRetry = canRetryProviderAttempt(info, attempt, this.maxRetries, unsafeToRetry, options.retryLedger)
        if (!canRetry) {
          yield { type: "error", data: info.status ? `${info.kind} ${info.status}: ${info.message}` : `${info.kind}: ${info.message}` }
          return
        }
        recordProviderRetry(info, options.retryLedger)
        const delayMs = providerRetryDelayMs(info, attempt)
        yield { type: "status", data: formatProviderRetryStatus(info, delayMs, attempt, this.maxRetries) }
        const waited = await providerBackoffWait(delayMs, options.abortSignal, this.sleep)
        if (!waited) {
          yield { type: "error", data: "provider request aborted during retry backoff" }
          return
        }
      }
    }
  }

  private buildRequestBody(options: ProviderCallOptions): Record<string, unknown> {
    const messages = this.convertMessages(options.system, options.messages)

    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      max_tokens: options.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    }

    if (options.tools?.length) {
      body.tools = options.tools
      body.tool_choice = "auto"
    }

    if (options.responseFormat?.type === "json_schema" && options.responseFormat.schema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: options.responseFormat.name,
          schema: options.responseFormat.schema,
          strict: options.responseFormat.strict ?? true,
        },
      }
    } else if (options.responseFormat?.type === "json_object") {
      body.response_format = { type: "json_object" }
    }

    return body
  }

  /** Convert Anthropic-format messages + system to OpenAI format. */
  private convertMessages(
    system: string,
    messages: ProviderCallOptions["messages"],
  ): OpenAIChatMessage[] {
    const result: OpenAIChatMessage[] = []

    // System prompt is a separate message in OpenAI
    if (system) {
      result.push({ role: "system", content: system })
    }

    for (const msg of messages) {
      if (msg.role === "user") {
        result.push(...this.convertUserMessage(msg))
      } else if (msg.role === "assistant") {
        result.push(this.convertAssistantMessage(msg))
      }
    }

    return result
  }

  private convertUserMessage(msg: ProviderCallOptions["messages"][number]): OpenAIChatMessage[] {
    if (typeof msg.content === "string") {
      return [{ role: "user", content: msg.content }]
    }

    const toolMessages: OpenAIChatMessage[] = []
    const textParts: string[] = []
    for (const block of msg.content) {
      if (!isRecord(block)) continue
      if (block.type === "tool_result") {
        const content = typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content ?? "")
        toolMessages.push({
          role: "tool",
          tool_call_id: String(block.tool_use_id ?? ""),
          content,
        })
      } else if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text)
      } else {
        textParts.push(JSON.stringify(block))
      }
    }

    if (textParts.length > 0) {
      toolMessages.push({ role: "user", content: textParts.join("\n") })
    }
    return toolMessages
  }

  private convertAssistantMessage(msg: ProviderCallOptions["messages"][number]): OpenAIChatMessage {
    const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content) }]

    const openaiMsg: OpenAIChatMessage = { role: "assistant", content: null }

    const textParts: string[] = []
    const toolCalls: OpenAIChatMessage["tool_calls"] = []

    for (const block of content) {
      if (!isRecord(block)) continue

      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text)
      } else if (block.type === "thinking") {
        // OpenAI doesn't support thinking blocks — skip them
        continue
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: String(block.id ?? ""),
          type: "function",
          function: {
            name: String(block.name ?? ""),
            arguments: JSON.stringify(block.input ?? {}),
          },
        })
      } else if (block.type === "tool_result") {
        // tool_result blocks are user messages in Anthropic, but in OpenAI
        // they're tool messages. This function only processes assistant messages though.
      }
    }

    if (textParts.length > 0) openaiMsg.content = textParts.join("")
    if (toolCalls.length > 0) openaiMsg.tool_calls = toolCalls

    return openaiMsg
  }

  private async *streamOnce(
    body: Record<string, unknown>,
    markUnsafeToRetry: (value: boolean) => void,
    options: ProviderCallOptions,
  ): AsyncGenerator<StreamEvent> {
    const response = await this.fetchFn(this.chatCompletionsURL(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options.abortSignal,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      const message = `OpenAI ${response.status}${text ? `: ${text.slice(0, 500)}` : ""}`
      // TB2-1: 类型化 auth/quota 失败（不再全部落入 truncation 重试账本）。
      const typedKind: ToolProtocolFailureKind | undefined =
        response.status === 401 || response.status === 403
          ? "auth_failure"
          : response.status === 402 || /quota|insufficient|额度|余额|欠费/i.test(text)
            ? "quota_failure"
            : undefined
      throw Object.assign(new Error(message), {
        status: response.status,
        kind: typedKind,
        response: {
          status: response.status,
          body: parseErrorBody(text),
        },
      })
    }

    const textChunks: string[] = []
    // TB2-1: 流式 tool call 组装状态机（真增量/累积快照/重叠/交错/repeated id）。
    const toolAssembler = createToolCallAssembler()
    const requestId = `openai-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`
    let finishReason: string | null = null
    let sawDoneSentinel = false
    let malformedSseChunk = false
    let usage: ProviderTokenUsage | undefined

    const reader = response.body?.getReader()
    if (!reader) {
      yield { type: "error", data: "No response body" }
      return
    }

    const decoder = new TextDecoder()
    let buffer = ""

    try {
      readLoop: while (true) {
        const { done, value } = await reader.read()
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = done ? "" : lines.pop() ?? ""

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith("data:")) continue
          const data = trimmed.slice(5).trimStart()
          if (data === "[DONE]") {
            sawDoneSentinel = true
            break readLoop
          }

          try {
            const chunk = JSON.parse(data) as OpenAIStreamChunk
            if (chunk.usage) usage = extractProviderTokenUsage({ usage: chunk.usage }) ?? usage

            for (const choice of chunk.choices) {
              const delta = choice.delta

              if (delta.content) {
                markUnsafeToRetry(true)
                textChunks.push(delta.content)
                yield { type: "text", data: delta.content }
              }

              if (delta.tool_calls) {
                markUnsafeToRetry(true)
                for (const tc of delta.tool_calls) {
                  toolAssembler.feed(tc.index, {
                    id: tc.id,
                    name: tc.function?.name,
                    arguments: tc.function?.arguments,
                  })
                }
              }

              if (choice.finish_reason) finishReason = choice.finish_reason
            }
          } catch {
            malformedSseChunk = true
          }
        }
        if (done) break
      }
    } finally {
      reader.releaseLock()
    }

    if (malformedSseChunk) {
      yield { type: "error", data: "provider returned a malformed SSE data chunk; response may be incomplete" }
      return
    }
    if (finishReason === "content_filter") {
      yield { type: "error", data: "provider finish_reason=content_filter: response was interrupted by the provider content filter" }
      return
    }
    // GATE-02: finish_reason=length (OpenAI native) and max_tokens (compat
    // relays) are TRUNCATED — handled after tool-call validation below.
    if (finishReason && !NORMAL_OPENAI_FINISH_REASONS.has(finishReason) && finishReason !== "length" && finishReason !== "max_tokens") {
      yield { type: "error", data: `provider finish_reason=${finishReason}: response ended before normal completion` }
      return
    }
    if (!finishReason && !sawDoneSentinel) {
      yield { type: "error", data: "provider stream ended unexpectedly without finish_reason or [DONE]" }
      return
    }

    // ── 组装 + 校验（fail-closed） ──
    // 未完整解析的工具调用绝不执行；多工具批次中有一个损坏时，不执行
    // 任何前面的副作用工具。
    const assembledCalls = toolAssembler.finish()
    const parsedToolCalls: Array<{ id: string; name: string; input: Record<string, unknown>; native: boolean }> = []
    for (const tc of assembledCalls) {
      let input: Record<string, unknown> = {}
      let native = true
      try {
        const parsed: unknown = JSON.parse(tc.arguments)
        // 工具入参必须是 JSON 对象（数组/标量 = 协议错误）。
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("tool call arguments must be a JSON object")
        }
        input = parsed as Record<string, unknown>
      } catch {
        native = false
        const repaired = repairToolCall(tc.arguments)
        if (!repaired) {
          const diagnostic = buildToolProtocolDiagnostic({
            requestId,
            toolName: tc.name,
            arguments: tc.arguments,
            fragmentCount: tc.fragmentCount,
            finishReason,
            parseFailureKind: "tool_protocol_invalid_json",
          })
          yield { type: "error", data: `provider returned invalid tool call JSON for ${tc.name}\n${formatToolProtocolDiagnostic(diagnostic)}` }
          return
        }
        input = repaired
      }
      // 修复后的参数还必须通过该工具的 schema（fail-closed，仅 required 校验）。
      const schemaCheck = validateToolCallInput(options.tools, tc.name, input)
      if (!schemaCheck.ok) {
        const diagnostic = buildToolProtocolDiagnostic({
          requestId,
          toolName: tc.name,
          arguments: tc.arguments,
          fragmentCount: tc.fragmentCount,
          finishReason,
          parseFailureKind: "tool_protocol_invalid_json",
        })
        yield { type: "error", data: `provider tool call ${tc.name} missing required fields (${schemaCheck.missing.join(",")})\n${formatToolProtocolDiagnostic(diagnostic)}` }
        return
      }
      parsedToolCalls.push({ id: tc.id, name: tc.name, input, native })
    }

    // GATE-02 (GS-03/GS-05): TRUNCATED is not an error — tool calls that
    // parsed natively before the cut are complete side effects and execute.
    // TB2-1: 被截断后"勉强补括号"（repair 过）的调用不是完整副作用——
    // 写入/删除类工具绝不自动执行；批次中任一调用不完整 → 整批不执行。
    if (finishReason === "length" || finishReason === "max_tokens") {
      const completeCalls = parsedToolCalls.filter(call => call.native)
      if (completeCalls.length !== parsedToolCalls.length) {
        const broken = parsedToolCalls.find(call => !call.native)!
        const diagnostic = buildToolProtocolDiagnostic({
          requestId,
          toolName: broken.name,
          arguments: "",
          fragmentCount: 0,
          finishReason,
          parseFailureKind: "tool_protocol_incomplete",
        })
        // 无 error 事件：这是 GATE-02 的正常截断流——kernel 以新 round 继续，
        // 不烧 truncation 重试账本；但损坏的调用绝不执行。
        yield { type: "truncated", data: { stopReason: finishReason, toolCalls: 0, incomplete: formatToolProtocolDiagnostic(diagnostic) } }
        return
      }
      for (const toolCall of completeCalls) {
        yield { type: "tool_call", data: { id: toolCall.id, name: toolCall.name, input: toolCall.input } }
      }
      yield { type: "truncated", data: { stopReason: finishReason, toolCalls: completeCalls.length } }
      return
    }

    for (const toolCall of parsedToolCalls) {
      yield { type: "tool_call", data: { id: toolCall.id, name: toolCall.name, input: toolCall.input } }
    }

    // Emit token usage
    if (usage) {
      yield {
        type: "token_usage",
        data: {
          ...usage,
          requestedModel: options.model,
          actualModel: body.model,
          source: "provider",
          purpose: options.purpose ?? "unknown",
        },
      }
    }

    const finalText = textChunks.join("")
    if (finalText && assembledCalls.length === 0) yield { type: "done", data: finalText }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

const NORMAL_OPENAI_FINISH_REASONS = new Set<string>(["stop", "tool_calls", "function_call"])

function parseErrorBody(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    return isRecord(parsed) ? parsed : { message: trimmed.slice(0, 500) }
  } catch {
    return { message: trimmed.slice(0, 500) }
  }
}
