/** 确定性 mock Anthropic client —— 把脚本化事件流喂给 DeepSeekProvider 解析层。
 *
 *  不碰网络：DeepSeekProvider 构造可注入 client，解析层只消费 messages.stream()
 *  返回的 AsyncIterable。流带 controller.abort / stream.abort / return 关闭机制
 *  （stream-lifecycle 的 bindProviderAbort 会调用），用于验证本地 abort 是否真正
 *  关闭了底层流。
 */

/** Anthropic SSE 事件构造器 —— 生成解析层认识的事件对象。 */
export const sse = {
  messageStart: (model: string, usage?: Record<string, unknown>) => ({
    type: "message_start",
    message: { model, ...(usage ? { usage } : {}) },
  }),
  contentBlockStart: (block: Record<string, unknown>) => ({ type: "content_block_start", content_block: block }),
  toolUseStart: (id: string, name: string, input?: unknown) =>
    sse.contentBlockStart({ type: "tool_use", id, name, ...(input !== undefined ? { input } : {}) }),
  thinkingStart: (signature?: string) =>
    sse.contentBlockStart(signature !== undefined ? { type: "thinking", signature } : { type: "thinking" }),
  textDelta: (text: string) => ({ type: "content_block_delta", delta: { type: "text_delta", text } }),
  inputJsonDelta: (partial: string) => ({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: partial } }),
  thinkingDelta: (thinking: string) => ({ type: "content_block_delta", delta: { type: "thinking_delta", thinking } }),
  contentBlockStop: () => ({ type: "content_block_stop" }),
  messageDelta: (stopReason: string, usage?: Record<string, unknown>) => ({
    type: "message_delta",
    delta: { stop_reason: stopReason },
    ...(usage ? { usage } : {}),
  }),
  messageStop: () => ({ type: "message_stop" }),
}

export interface MockClientHarness {
  client: {
    messages: { stream(_params: unknown): AsyncIterable<unknown> }
  }
  get calls(): number
  get closed(): string[]
}

export function makeMockClient(streams: Array<() => AsyncGenerator<unknown>>): MockClientHarness {
  let calls = 0
  const closed: string[] = []

  function wrap(gen: AsyncGenerator<unknown>): AsyncGenerator<unknown> & Record<string, unknown> {
    const g = gen as AsyncGenerator<unknown> & Record<string, unknown>
    g.controller = { abort: () => closed.push("controller.abort") }
    g.abort = () => closed.push("stream.abort")
    g.return = async () => {
      closed.push("stream.return")
      return { done: true, value: undefined } as IteratorResult<unknown>
    }
    return g
  }

  return {
    client: {
      messages: {
        stream: () => {
          const factory = streams[Math.min(calls, streams.length - 1)]!
          calls += 1
          return wrap(factory())
        },
      },
    },
    get calls() {
      return calls
    },
    get closed() {
      return closed
    },
  }
}
