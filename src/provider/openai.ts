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
import { classifyProviderError, formatProviderRetryStatus, providerRetryDelayMs } from "./retry"
import { repairToolCall } from "../tools/repair"
import { extractProviderTokenUsage } from "./usage"

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
      try {
        yield* this.streamOnce(body, options)
        return
      } catch (e) {
        const info = classifyProviderError(e)
        const canRetry = info.retryable && attempt < this.maxRetries
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
      throw Object.assign(new Error(message), {
        status: response.status,
        response: {
          status: response.status,
          body: parseErrorBody(text),
        },
      })
    }

    const textChunks: string[] = []
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
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
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

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
                textChunks.push(delta.content)
                yield { type: "text", data: delta.content }
              }

              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const existing = toolCalls.get(tc.index)
                  if (tc.id) {
                    toolCalls.set(tc.index, { id: tc.id, name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? "" })
                  } else if (existing && tc.function?.arguments) {
                    existing.arguments += tc.function.arguments
                  }
                }
              }

              if (choice.finish_reason) finishReason = choice.finish_reason
            }
          } catch {
            malformedSseChunk = true
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    if (malformedSseChunk) {
      yield { type: "error", data: "provider returned a malformed SSE data chunk; response may be incomplete" }
      return
    }
    if (finishReason === "length") {
      yield { type: "error", data: "provider finish_reason=length: response hit the output token limit before completion" }
      return
    }
    if (finishReason === "content_filter") {
      yield { type: "error", data: "provider finish_reason=content_filter: response was interrupted by the provider content filter" }
      return
    }
    if (!finishReason && !sawDoneSentinel) {
      yield { type: "error", data: "provider stream ended unexpectedly without finish_reason or [DONE]" }
      return
    }

    // Validate every tool call before emitting any of them. A partially parsed
    // batch must never execute its valid prefix and then fail halfway through.
    const parsedToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
    for (const [, tc] of toolCalls) {
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(tc.arguments)
      } catch {
        const repaired = repairToolCall(tc.arguments)
        if (!repaired) {
          yield { type: "error", data: `provider returned invalid tool call JSON for ${tc.name}` }
          return
        }
        input = repaired
      }
      parsedToolCalls.push({ id: tc.id, name: tc.name, input })
    }
    for (const toolCall of parsedToolCalls) {
      yield { type: "tool_call", data: toolCall }
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
    if (finalText && toolCalls.size === 0) yield { type: "done", data: finalText }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

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
