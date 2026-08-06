/** ORMB-PP mock stream 用例（30 题）— 确定性事件流喂给 DeepSeekProvider 解析层。
 *
 *  覆盖计划 §6 点名的全部 mock 场景：正常 thinking→tool→final、thinking signature
 *  缺失、Tool JSON 分片/损坏（repair 五级）/断流、text 后断网、429+Retry-After、
 *  500、capacity、quota、401、本地 abort、stop_reason 缺失、max_tokens、
 *  actualModel 不一致，外加多 tool 顺序、usage 遥测、混合流、两轮 Tool Loop 连续性。
 */

import { sse } from "./mock-client"
import type { StreamEvent } from "../../../src/provider/types"
import type { MBEMockCase, MBEAssertion, MBEMockContext } from "../contracts/case"
import type { HardGateName } from "../contracts/metrics"

// ── 断言 helpers ──

const pass = (label: string, detail = ""): MBEAssertion => ({ label, passed: true, detail })
const fail = (label: string, detail: string, gate?: HardGateName): MBEAssertion => ({ label, passed: false, detail, gate })

function toolCalls(ctx: MBEMockContext): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  return ctx.events
    .filter((e) => e.type === "tool_call")
    .map((e) => e.data as { id: string; name: string; input: Record<string, unknown> })
}

function textOf(ctx: MBEMockContext): string {
  return ctx.events.filter((e) => e.type === "text").map((e) => String(e.data)).join("")
}

function thinkingBlocks(ctx: MBEMockContext): Array<{ thinking: string; signature?: string }> | null {
  const ev = ctx.events.find((e) => e.type === "thinking_blocks")
  return ev ? (ev.data as Array<{ thinking: string; signature?: string }>) : null
}

function errorOf(ctx: MBEMockContext): string | null {
  const ev = ctx.events.find((e) => e.type === "error")
  return ev ? String(ev.data) : null
}

function hasStatus(ctx: MBEMockContext, needle: string): boolean {
  return ctx.events.some((e) => e.type === "status" && String(e.data).includes(needle))
}

function hasDone(ctx: MBEMockContext): boolean {
  return ctx.events.some((e) => e.type === "done")
}

function usageEvents(ctx: MBEMockContext): Array<Record<string, unknown>> {
  return ctx.events.filter((e) => e.type === "token_usage").map((e) => e.data as Record<string, unknown>)
}

const TOOL_USE_STOP = sse.messageDelta("tool_use")
const END_TURN = sse.messageDelta("end_turn")

// ── 30 个用例 ──

export const MOCK_CASES: MBEMockCase[] = [
  {
    caseId: "PP-M01",
    title: "正常 thinking → tool → final 三阶段完整流",
    tags: ["mock", "normal"],
    description: "thinking block 完整捕获 + tool call 完整解析，stop_reason=tool_use。",
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.thinkingStart("sig-1")
        yield sse.thinkingDelta("让我先分析")
        yield sse.contentBlockStop()
        yield sse.toolUseStart("t1", "read_file")
        yield sse.inputJsonDelta('{"path":')
        yield sse.inputJsonDelta('"a.ts"')
        yield sse.inputJsonDelta("}")
        yield sse.contentBlockStop()
        yield TOOL_USE_STOP
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      const tb = thinkingBlocks(ctx)
      const tc = toolCalls(ctx)
      return [
        tb ? pass("thinking 完整捕获", JSON.stringify(tb)) : fail("thinking 完整捕获", "缺 thinking_blocks"),
        tb?.length === 1 && tb[0]!.thinking === "让我先分析" && tb[0]!.signature === "sig-1"
          ? pass("thinking 内容与签名正确")
          : fail("thinking 内容与签名正确", `got ${JSON.stringify(tb)}`),
        tc.length === 1 && tc[0]!.id === "t1" && tc[0]!.name === "read_file" && JSON.stringify(tc[0]!.input) === '{"path":"a.ts"}'
          ? pass("tool call 完整解析")
          : fail("tool call 完整解析", `got ${JSON.stringify(tc)}`, "LOST_TOOL_CALL"),
        errorOf(ctx) === null ? pass("无错误") : fail("无错误", `got error: ${errorOf(ctx)}`),
        !hasDone(ctx) ? pass("tool_use 轮不产 done") : fail("tool_use 轮不产 done", "tool_use stop 后不应 done"),
      ]
    },
  },

  {
    caseId: "PP-M02",
    title: "无 thinking 的 tool → final 两轮 Tool Loop",
    tags: ["mock", "two-round", "normal"],
    description: "round1 模型发 tool_call，round2 喂回结果后给最终答案。验证轮间无重复 tool call。",
    twoRound: true,
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.toolUseStart("t1", "read_file")
        yield sse.inputJsonDelta('{"path":"a.ts"}')
        yield sse.contentBlockStop()
        yield TOOL_USE_STOP
        yield sse.messageStop()
      },
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.textDelta("文件内容是 42")
        yield END_TURN
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      const tc = toolCalls(ctx)
      return [
        tc.length === 1 && tc[0]!.name === "read_file"
          ? pass("tool call 恰好一次", "round2 无重复")
          : fail("tool call 恰好一次", `got ${tc.length}`, "DUPLICATE_TOOL_CALL"),
        textOf(ctx).includes("文件内容是 42")
          ? pass("round2 final 文本正确")
          : fail("round2 final 文本正确", `got "${textOf(ctx)}"`),
        hasDone(ctx) ? pass("round2 产 done") : fail("round2 产 done", "纯文本轮应 done"),
        errorOf(ctx) === null ? pass("无错误") : fail("无错误", `got error: ${errorOf(ctx)}`),
      ]
    },
  },

  {
    caseId: "PP-M03",
    title: "thinking signature 缺失仍正常",
    tags: ["mock", "thinking"],
    description: "DeepSeek V4 经 Anthropic 兼容层有时省略 signature —— signature 必须容忍为空串。",
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.thinkingStart()
        yield sse.thinkingDelta("分析内容")
        yield sse.contentBlockStop()
        yield sse.textDelta("答案")
        yield END_TURN
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      const tb = thinkingBlocks(ctx)
      return [
        tb?.length === 1 && tb[0]!.thinking === "分析内容" && tb[0]!.signature === ""
          ? pass("signature 缺失被容忍", `thinking=${JSON.stringify(tb[0]!.thinking)}`)
          : fail("signature 缺失被容忍", `got ${JSON.stringify(tb)}`),
        errorOf(ctx) === null ? pass("无错误") : fail("无错误", `got error: ${errorOf(ctx)}`),
        hasDone(ctx) ? pass("产 done") : fail("产 done", "纯文本轮应 done"),
      ]
    },
  },

  {
    caseId: "PP-M04",
    title: "thinking 空内容不产 thinking_blocks",
    tags: ["mock", "thinking"],
    description: "cthink.thinking 为空串时不 push —— 记录当前契约行为。",
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.thinkingStart("sig")
        yield sse.contentBlockStop()
        yield sse.textDelta("ok")
        yield END_TURN
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      const tb = thinkingBlocks(ctx)
      return [
        tb === null ? pass("空 thinking 不 emit") : fail("空 thinking 不 emit", `got ${JSON.stringify(tb)}`),
        errorOf(ctx) === null ? pass("无错误") : fail("无错误", `got error: ${errorOf(ctx)}`),
        hasDone(ctx) ? pass("产 done") : fail("产 done", "纯文本轮应 done"),
      ]
    },
  },

  {
    caseId: "PP-M05",
    title: "Tool JSON 分片累积（3 片拼接）",
    tags: ["mock", "tool-json"],
    description: "input_json_delta 分片到达，必须正确拼接后解析，不得错配。",
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.toolUseStart("t1", "write_file")
        yield sse.inputJsonDelta('{"path":"x.txt"')
        yield sse.inputJsonDelta(', "content"')
        yield sse.inputJsonDelta(': "hi"}')
        yield sse.contentBlockStop()
        yield TOOL_USE_STOP
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      const tc = toolCalls(ctx)
      const expected = JSON.stringify({ path: "x.txt", content: "hi" })
      return [
        tc.length === 1 && JSON.stringify(tc[0]!.input) === expected
          ? pass("分片拼接后解析正确", `input=${JSON.stringify(tc[0]!.input)}`)
          : fail("分片拼接后解析正确", `got ${JSON.stringify(tc)}`, "TOOL_RESULT_MISMATCH"),
        errorOf(ctx) === null ? pass("无错误") : fail("无错误", `got error: ${errorOf(ctx)}`),
      ]
    },
  },

  {
    caseId: "PP-M06",
    title: "Tool JSON 尾逗号修复",
    tags: ["mock", "tool-json", "repair"],
    description: '{"path":"x","content":"hi",} → repair 去掉尾逗号。',
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.toolUseStart("t1", "write_file")
        yield sse.inputJsonDelta('{"path":"x.txt","content":"hi",}')
        yield sse.contentBlockStop()
        yield TOOL_USE_STOP
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      const tc = toolCalls(ctx)
      return [
        tc.length === 1 && JSON.stringify(tc[0]!.input) === '{"path":"x.txt","content":"hi"}'
          ? pass("尾逗号修复", `input=${JSON.stringify(tc[0]!.input)}`)
          : fail("尾逗号修复", `got ${JSON.stringify(tc)}`, "TOOL_RESULT_MISMATCH"),
        errorOf(ctx) === null ? pass("无错误") : fail("无错误", `got error: ${errorOf(ctx)}`),
      ]
    },
  },

  {
    caseId: "PP-M07",
    title: "Tool JSON Python 字面量修复",
    tags: ["mock", "tool-json", "repair"],
    description: "True/False/None → true/false/null（模型常见错误）。",
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.toolUseStart("t1", "run_process")
        yield sse.inputJsonDelta('{"enabled": True, "retries": 3}')
        yield sse.contentBlockStop()
        yield TOOL_USE_STOP
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      const tc = toolCalls(ctx)
      return [
        tc.length === 1 && JSON.stringify(tc[0]!.input) === '{"enabled":true,"retries":3}'
          ? pass("Python 字面量修复", `input=${JSON.stringify(tc[0]!.input)}`)
          : fail("Python 字面量修复", `got ${JSON.stringify(tc)}`, "TOOL_RESULT_MISMATCH"),
        errorOf(ctx) === null ? pass("无错误") : fail("无错误", `got error: ${errorOf(ctx)}`),
      ]
    },
  },

  {
    caseId: "PP-M08",
    title: "Tool JSON 缺闭合括号修复",
    tags: ["mock", "tool-json", "repair"],
    description: '{"path":"x.txt" → repair 补齐 "}"。',
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.toolUseStart("t1", "read_file")
        yield sse.inputJsonDelta('{"path":"x.txt"')
        yield sse.contentBlockStop()
        yield TOOL_USE_STOP
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      const tc = toolCalls(ctx)
      return [
        tc.length === 1 && JSON.stringify(tc[0]!.input) === '{"path":"x.txt"}'
          ? pass("缺闭合括号修复", `input=${JSON.stringify(tc[0]!.input)}`)
          : fail("缺闭合括号修复", `got ${JSON.stringify(tc)}`, "TOOL_RESULT_MISMATCH"),
        errorOf(ctx) === null ? pass("无错误") : fail("无错误", `got error: ${errorOf(ctx)}`),
      ]
    },
  },

  {
    caseId: "PP-M09",
    title: "Tool JSON 字段别名修复",
    tags: ["mock", "tool-json", "repair"],
    description: "filePath → path（字段别名表）。",
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.toolUseStart("t1", "read_file")
        yield sse.inputJsonDelta('{"filePath":"x.txt","content":"hi"}')
        yield sse.contentBlockStop()
        yield TOOL_USE_STOP
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      const tc = toolCalls(ctx)
      return [
        tc.length === 1 && JSON.stringify(tc[0]!.input) === '{"path":"x.txt","content":"hi"}'
          ? pass("字段别名修复", `input=${JSON.stringify(tc[0]!.input)}`)
          : fail("字段别名修复", `got ${JSON.stringify(tc)}`, "TOOL_RESULT_MISMATCH"),
        errorOf(ctx) === null ? pass("无错误") : fail("无错误", `got error: ${errorOf(ctx)}`),
      ]
    },
  },

  {
    caseId: "PP-M10",
    title: "Tool JSON 不可修复 → 拒绝执行",
    tags: ["mock", "tool-json", "repair"],
    description: "完全非 JSON 载荷 → 必须报 invalid tool call JSON，不得产生 tool_call。",
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.toolUseStart("t1", "write_file")
        yield sse.inputJsonDelta("not-json-at-all")
        yield sse.contentBlockStop()
        yield TOOL_USE_STOP
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      const err = errorOf(ctx)
      const tc = toolCalls(ctx)
      return [
        err !== null && err.includes("invalid tool call JSON")
          ? pass("不可修复 JSON 报错", `error=${err}`)
          : fail("不可修复 JSON 报错", `got error=${err}`),
        tc.length === 0 ? pass("无 tool_call 泄漏") : fail("无 tool_call 泄漏", `got ${tc.length}`, "DUPLICATE_TOOL_CALL"),
      ]
    },
  },

  {
    caseId: "PP-M11",
    title: "Tool Call 输出一半断流 → incomplete",
    tags: ["mock", "tool-json"],
    description: "content_block_start 后 JSON 未闭合且流结束 → 报 incomplete tool call。",
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.toolUseStart("t1", "read_file")
        yield sse.inputJsonDelta('{"path":')
        yield END_TURN
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      const err = errorOf(ctx)
      return [
        err !== null && err.includes("incomplete tool call")
          ? pass("半途断流报 incomplete", `error=${err}`)
          : fail("半途断流报 incomplete", `got error=${err}`),
        toolCalls(ctx).length === 0 ? pass("无 tool_call 泄漏") : fail("无 tool_call 泄漏", "半途不应 emit"),
      ]
    },
  },

  {
    caseId: "PP-M12",
    title: "content_block_start 携带完整 tool input",
    tags: ["mock", "tool-json"],
    description: "DeepSeek 有时在 content_block_start 直接带 input，无 input_json_delta —— 直接使用。",
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.toolUseStart("t1", "list_files", { path: "/src" })
        yield sse.contentBlockStop()
        yield TOOL_USE_STOP
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      const tc = toolCalls(ctx)
      return [
        tc.length === 1 && JSON.stringify(tc[0]!.input) === '{"path":"/src"}'
          ? pass("initialInput 直接使用", `input=${JSON.stringify(tc[0]!.input)}`)
          : fail("initialInput 直接使用", `got ${JSON.stringify(tc)}`, "TOOL_RESULT_MISMATCH"),
        errorOf(ctx) === null ? pass("无错误") : fail("无错误", `got error: ${errorOf(ctx)}`),
      ]
    },
  },

  {
    caseId: "PP-M13",
    title: "text 输出后断网 → 不重试",
    tags: ["mock", "retry", "network"],
    description: "已流式输出 text 后网络断 → unsafeToRetry，绝不重试（防副作用重复）。",
    maxRetries: 3,
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.textDelta("部分回答")
        throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" })
      },
      async function* () {
        yield sse.textDelta("不应发生")
        yield END_TURN
      },
    ],
    assert(ctx) {
      const err = errorOf(ctx)
      return [
        ctx.calls === 1 ? pass("断流后不重试", `calls=${ctx.calls}`) : fail("断流后不重试", `calls=${ctx.calls}`, "RETRY_AFTER_SIDE_EFFECT"),
        textOf(ctx).includes("部分回答") ? pass("已输出 text 保留") : fail("已输出 text 保留", `got "${textOf(ctx)}"`),
        !textOf(ctx).includes("不应发生") ? pass("无第二次流输出") : fail("无第二次流输出", "retry 不该发生"),
        err !== null && err.includes("network") ? pass("报 network 错误", `error=${err}`) : fail("报 network 错误", `got error=${err}`),
      ]
    },
  },

  {
    caseId: "PP-M14",
    title: "429 + Retry-After → 重试成功",
    tags: ["mock", "retry", "rate-limit"],
    description: "流开始前 429，尊重 Retry-After 延迟后重试。",
    maxRetries: 2,
    streams: [
      async function* () {
        throw { status: 429, headers: { "retry-after": "1" }, message: "rate limited" }
      },
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.textDelta("ok")
        yield END_TURN
      },
    ],
    assert(ctx) {
      return [
        ctx.calls === 2 ? pass("429 后重试", `calls=${ctx.calls}`) : fail("429 后重试", `calls=${ctx.calls}`),
        JSON.stringify(ctx.sleepsMs) === "[1000]" ? pass("Retry-After 生效", `sleeps=${JSON.stringify(ctx.sleepsMs)}`) : fail("Retry-After 生效", `sleeps=${JSON.stringify(ctx.sleepsMs)}`),
        hasStatus(ctx, "provider retry: rate_limit 429") ? pass("retry 状态上报") : fail("retry 状态上报", "缺 retry status"),
        textOf(ctx) === "ok" && hasDone(ctx) ? pass("最终正常完成") : fail("最终正常完成", `text="${textOf(ctx)}" done=${hasDone(ctx)}`),
      ]
    },
  },

  {
    caseId: "PP-M15",
    title: "500 → 指数退避重试成功",
    tags: ["mock", "retry", "server"],
    description: "流开始前 5xx → 可重试，指数退避（1s → 2s）。",
    maxRetries: 2,
    streams: [
      async function* () {
        throw { status: 500, message: "server exploded" }
      },
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.textDelta("recovered")
        yield END_TURN
      },
    ],
    assert(ctx) {
      return [
        ctx.calls === 2 ? pass("500 后重试", `calls=${ctx.calls}`) : fail("500 后重试", `calls=${ctx.calls}`),
        ctx.sleepsMs.length === 1 && ctx.sleepsMs[0] === 1000 ? pass("基础退避 1s") : fail("基础退避 1s", `sleeps=${JSON.stringify(ctx.sleepsMs)}`),
        textOf(ctx) === "recovered" && hasDone(ctx) ? pass("最终正常完成") : fail("最终正常完成", `text="${textOf(ctx)}"`),
      ]
    },
  },

  {
    caseId: "PP-M16",
    title: "capacity_error → 长退避重试",
    tags: ["mock", "retry", "capacity"],
    description: "模型过载 capacity_error → 可重试，基础退避 5s（容量类更长）。",
    maxRetries: 2,
    streams: [
      async function* () {
        throw {
          status: 503,
          response: { body: { type: "capacity_error", message: "model overloaded" } },
          message: "model overloaded",
        }
      },
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.textDelta("up")
        yield END_TURN
      },
    ],
    assert(ctx) {
      return [
        ctx.calls === 2 ? pass("capacity 重试", `calls=${ctx.calls}`) : fail("capacity 重试", `calls=${ctx.calls}`),
        ctx.sleepsMs.length === 1 && ctx.sleepsMs[0] === 5000 ? pass("capacity 退避 5s") : fail("capacity 退避 5s", `sleeps=${JSON.stringify(ctx.sleepsMs)}`),
        hasStatus(ctx, "provider retry: capacity") ? pass("capacity 状态上报") : fail("capacity 状态上报", "缺 retry status"),
      ]
    },
  },

  {
    caseId: "PP-M17",
    title: "quota 耗尽 → 不重试",
    tags: ["mock", "retry", "quota"],
    description: "insufficient_quota → 非重试，直接报错（重试是烧钱）。",
    maxRetries: 2,
    streams: [
      async function* () {
        throw {
          status: 429,
          response: { status: 429, body: { error: { code: "insufficient_quota", message: "Your account balance is too low" } } },
          message: "insufficient_quota: Your account balance is too low",
        }
      },
      async function* () {
        yield sse.textDelta("should not")
        yield END_TURN
      },
    ],
    assert(ctx) {
      const err = errorOf(ctx)
      return [
        ctx.calls === 1 ? pass("quota 不重试", `calls=${ctx.calls}`) : fail("quota 不重试", `calls=${ctx.calls}`),
        !hasStatus(ctx, "provider retry") ? pass("无 retry 状态") : fail("无 retry 状态", "quota 不应重试"),
        err !== null && err.startsWith("quota") ? pass("报 quota 错误", `error=${err}`) : fail("报 quota 错误", `got error=${err}`),
      ]
    },
  },

  {
    caseId: "PP-M18",
    title: "401 认证失败 → 不重试",
    tags: ["mock", "retry", "auth"],
    description: "401 → auth，非重试。",
    maxRetries: 2,
    streams: [
      async function* () {
        throw { status: 401, message: "invalid api key" }
      },
      async function* () {
        yield sse.textDelta("should not")
      },
    ],
    assert(ctx) {
      const err = errorOf(ctx)
      return [
        ctx.calls === 1 ? pass("401 不重试", `calls=${ctx.calls}`) : fail("401 不重试", `calls=${ctx.calls}`),
        err !== null && err.includes("auth") ? pass("报 auth 错误", `error=${err}`) : fail("报 auth 错误", `got error=${err}`),
      ]
    },
  },

  {
    caseId: "PP-M19",
    title: "本地 abort → 流关闭 + 无残留",
    tags: ["mock", "abort"],
    description: "收到本地 abort 后：底层流被关闭（controller.abort/stream.abort/return 之一），不再产出。",
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.textDelta("a")
        yield sse.textDelta("b")
        yield sse.textDelta("c")
        yield END_TURN
        yield sse.messageStop()
      },
    ],
    abortWhen: (ev) => ev.type === "text" && String(ev.data) === "b",
    assert(ctx) {
      const closed = ctx.closed
      const hasClose = closed.includes("controller.abort") || closed.includes("stream.abort") || closed.includes("stream.return")
      return [
        hasClose ? pass("底层流已关闭", `closed=${JSON.stringify(closed)}`) : fail("底层流已关闭", `closed=${JSON.stringify(closed)}`, "ABORT_IGNORED"),
        !textOf(ctx).includes("c") ? pass("abort 后不再产出", `text="${textOf(ctx)}"`) : fail("abort 后不再产出", `text="${textOf(ctx)}"`, "ABORT_IGNORED"),
        hasStatus(ctx, "aborted") ? pass("abort 状态上报") : fail("abort 状态上报", "缺 aborted status"),
        errorOf(ctx) === null ? pass("abort 非错误") : fail("abort 非错误", `got error: ${errorOf(ctx)}`),
        !hasDone(ctx) ? pass("abort 无 done") : fail("abort 无 done", "abort 后不应 done"),
      ]
    },
  },

  {
    caseId: "PP-M20",
    title: "EOF 无 stop_reason → interrupted",
    tags: ["mock", "stop-reason"],
    description: "流安静结束无 stop_reason → 不得当作正常结束产 done。",
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.textDelta("partial answer")
      },
    ],
    maxRetries: 0,
    assert(ctx) {
      const err = errorOf(ctx)
      return [
        err !== null && err.includes("ended unexpectedly") ? pass("EOF 报 interrupted") : fail("EOF 报 interrupted", `got error=${err}`),
        !hasDone(ctx) ? pass("无 done") : fail("无 done", "EOF 不应 done", "MISSING_STOP_REASON_ACCEPTED"),
      ]
    },
  },

  {
    caseId: "PP-M21",
    title: "max_tokens 截断 → 可恢复错误",
    tags: ["mock", "stop-reason"],
    description: "stop_reason=max_tokens → status + error，不产 done。",
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.textDelta("partial table")
        yield sse.messageDelta("max_tokens")
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      const err = errorOf(ctx)
      return [
        hasStatus(ctx, "provider-stop: max_tokens") ? pass("max_tokens 状态上报") : fail("max_tokens 状态上报", "缺 status"),
        err !== null && err.includes("max_tokens") ? pass("报 max_tokens 错误", `error=${err}`) : fail("报 max_tokens 错误", `got error=${err}`),
        !hasDone(ctx) ? pass("无 done") : fail("无 done", "max_tokens 不应 done"),
        textOf(ctx).includes("partial table") ? pass("已输出文本保留") : fail("已输出文本保留", `got "${textOf(ctx)}"`),
      ]
    },
  },

  {
    caseId: "PP-M22",
    title: "actualModel 与 requestedModel 不一致 → 上报",
    tags: ["mock", "model", "telemetry"],
    description: "服务端返回不同 model → token_usage 必须带 actualModel（防静默切换）。",
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash-0123")
        yield sse.textDelta("x")
        yield END_TURN
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      const usages = usageEvents(ctx)
      const actual = usages.find((u) => u.actualModel !== undefined)
      return [
        actual !== undefined && actual.actualModel === "deepseek-v4-flash-0123"
          ? pass("actualModel 已上报", `actual=${actual.actualModel}`)
          : fail("actualModel 已上报", `usages=${JSON.stringify(usages)}`, "SILENT_MODEL_SWITCH"),
        actual !== undefined && actual.requestedModel === "deepseek-v4-flash"
          ? pass("requestedModel 保留")
          : fail("requestedModel 保留", `requested=${actual?.requestedModel}`),
      ]
    },
  },

  {
    caseId: "PP-M23",
    title: "actualModel 与 requestedModel 一致",
    tags: ["mock", "model", "telemetry"],
    description: "正常一致时 actualModel 同样上报。",
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.textDelta("x")
        yield END_TURN
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      const usages = usageEvents(ctx)
      const actual = usages.find((u) => u.actualModel !== undefined)
      return [
        actual !== undefined && actual.actualModel === "deepseek-v4-flash"
          ? pass("actualModel 一致上报")
          : fail("actualModel 一致上报", `usages=${JSON.stringify(usages)}`, "SILENT_MODEL_SWITCH"),
      ]
    },
  },

  {
    caseId: "PP-M24",
    title: "多 tool call 顺序保持，无重复无丢失",
    tags: ["mock", "multi-tool"],
    description: "两个 tool_use blocks 按序 emit，id 不重复。",
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.toolUseStart("t1", "read_file", { path: "a.ts" })
        yield sse.contentBlockStop()
        yield sse.toolUseStart("t2", "write_file", { path: "b.ts", content: "x" })
        yield sse.inputJsonDelta('{"path":"b.ts","content":"x"}')
        yield sse.contentBlockStop()
        yield TOOL_USE_STOP
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      const tc = toolCalls(ctx)
      const ids = tc.map((t) => t.id)
      return [
        tc.length === 2 ? pass("2 个 tool call") : fail("2 个 tool call", `got ${tc.length}`, "LOST_TOOL_CALL"),
        ids[0] === "t1" && ids[1] === "t2" ? pass("顺序保持", ids.join(",")) : fail("顺序保持", ids.join(","), "TOOL_RESULT_MISMATCH"),
        new Set(ids).size === ids.length ? pass("id 无重复") : fail("id 无重复", ids.join(","), "DUPLICATE_TOOL_CALL"),
        errorOf(ctx) === null ? pass("无错误") : fail("无错误", `got error: ${errorOf(ctx)}`),
      ]
    },
  },

  {
    caseId: "PP-M25",
    title: "usage 遥测完整捕获",
    tags: ["mock", "telemetry"],
    description: "message_start 带 usage → token_usage 必须完整转发 input/output/cache 三类。",
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash", {
          input_tokens: 100,
          output_tokens: 5,
          cache_read_input_tokens: 60,
          cache_creation_input_tokens: 30,
        })
        yield sse.textDelta("ok")
        yield END_TURN
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      const usages = usageEvents(ctx)
      const u = usages.find((x) => x.inputTokens !== undefined || x.cacheReadInputTokens !== undefined)
      return [
        u !== undefined && u.inputTokens === 100 ? pass("inputTokens=100") : fail("inputTokens=100", `usages=${JSON.stringify(usages)}`, "TOKEN_TELEMETRY_MISSING"),
        u !== undefined && u.outputTokens === 5 ? pass("outputTokens=5") : fail("outputTokens=5", `usages=${JSON.stringify(usages)}`, "TOKEN_TELEMETRY_MISSING"),
        u !== undefined && u.cacheReadInputTokens === 60 ? pass("cacheRead=60") : fail("cacheRead=60", `usages=${JSON.stringify(usages)}`, "TOKEN_TELEMETRY_MISSING"),
        u !== undefined && u.cacheCreationInputTokens === 30 ? pass("cacheCreation=30") : fail("cacheCreation=30", `usages=${JSON.stringify(usages)}`, "TOKEN_TELEMETRY_MISSING"),
      ]
    },
  },

  {
    caseId: "PP-M26",
    title: "thinking + 2 tool 混合流顺序",
    tags: ["mock", "thinking", "multi-tool"],
    description: "thinking block + 两个 tool call 混合，顺序与完整性。",
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.thinkingStart("sig")
        yield sse.thinkingDelta("先思考")
        yield sse.contentBlockStop()
        yield sse.toolUseStart("t1", "search_files", { query: "x" })
        yield sse.contentBlockStop()
        yield sse.toolUseStart("t2", "read_file", { path: "y" })
        yield sse.contentBlockStop()
        yield TOOL_USE_STOP
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      const tb = thinkingBlocks(ctx)
      const tc = toolCalls(ctx)
      return [
        tb !== null && tb[0]!.thinking === "先思考" ? pass("thinking 捕获") : fail("thinking 捕获", `got ${JSON.stringify(tb)}`),
        tc.length === 2 && tc[0]!.name === "search_files" && tc[1]!.name === "read_file"
          ? pass("tool 顺序正确", tc.map((t) => t.name).join(","))
          : fail("tool 顺序正确", `got ${JSON.stringify(tc.map((t) => t.name))}`, "LOST_TOOL_CALL"),
        errorOf(ctx) === null ? pass("无错误") : fail("无错误", `got error: ${errorOf(ctx)}`),
      ]
    },
  },

  {
    caseId: "PP-M27",
    title: "text + tool + text 混合（无 done）",
    tags: ["mock", "mixed"],
    description: "文本与 tool 共存一轮：text 流式给出，tool call 完整；有 tool 时本轮不产 done。",
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.textDelta("先分析")
        yield sse.toolUseStart("t1", "read_file", { path: "a.ts" })
        yield sse.contentBlockStop()
        yield sse.textDelta("后结论")
        yield END_TURN
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      return [
        textOf(ctx) === "先分析后结论" ? pass("text 流式完整", `"${textOf(ctx)}"`) : fail("text 流式完整", `got "${textOf(ctx)}"`),
        toolCalls(ctx).length === 1 ? pass("tool call 完整") : fail("tool call 完整", `got ${toolCalls(ctx).length}`, "LOST_TOOL_CALL"),
        !hasDone(ctx) ? pass("有 tool 的轮不产 done") : fail("有 tool 的轮不产 done", "toolBlocks 非空时无 done（当前契约）"),
        errorOf(ctx) === null ? pass("无错误") : fail("无错误", `got error: ${errorOf(ctx)}`),
      ]
    },
  },

  {
    caseId: "PP-M28",
    title: "两轮 Tool Loop 连续性（tool→final）",
    tags: ["mock", "two-round", "normal"],
    description: "round1 tool_use，round2 final。验证 provider 层轮间无状态泄漏、无重复 emit。",
    twoRound: true,
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.toolUseStart("t1", "read_file")
        yield sse.inputJsonDelta('{"path":"a.ts"}')
        yield sse.contentBlockStop()
        yield TOOL_USE_STOP
        yield sse.messageStop()
      },
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.textDelta("答案 = 42")
        yield END_TURN
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      const tc = toolCalls(ctx)
      const finalEvents = ctx.events.slice(-6)
      return [
        tc.length === 1 ? pass("tool_call 全程一次", `got ${tc.length}`) : fail("tool_call 全程一次", `got ${tc.length}`, "DUPLICATE_TOOL_CALL"),
        finalEvents.some((e) => e.type === "text" && e.data === "答案 = 42") ? pass("round2 final 文本") : fail("round2 final 文本", `tail=${JSON.stringify(finalEvents.map((e) => e.type))}`),
        finalEvents.some((e) => e.type === "done") ? pass("round2 产 done") : fail("round2 产 done", "纯文本轮应 done"),
        errorOf(ctx) === null ? pass("无错误") : fail("无错误", `got error: ${errorOf(ctx)}`),
      ]
    },
  },

  {
    caseId: "PP-M29",
    title: "空响应正常结束（无内容无 tool）",
    tags: ["mock", "edge"],
    description: "无 content_block、无 usage，仅 end_turn —— 空但正常，不得误报 error。",
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield END_TURN
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      return [
        errorOf(ctx) === null ? pass("无错误") : fail("无错误", `got error: ${errorOf(ctx)}`),
        toolCalls(ctx).length === 0 ? pass("无 tool_call") : fail("无 tool_call", `got ${toolCalls(ctx).length}`),
        textOf(ctx) === "" && !hasDone(ctx) ? pass("空响应无 done 无 text") : fail("空响应无 done 无 text", `text="${textOf(ctx)}" done=${hasDone(ctx)}`),
        hasStatus(ctx, "provider-stop: end_turn") ? pass("stop 状态上报") : fail("stop 状态上报", "缺 provider-stop status"),
      ]
    },
  },

  {
    caseId: "PP-M30",
    title: "thinking 无 content_block_stop → recovery 捕获",
    tags: ["mock", "thinking", "edge"],
    description: "thinking block 缺 content_block_stop 但 message_delta(end_turn) —— 循环外 recovery 必须捕获已累积的 thinking。",
    streams: [
      async function* () {
        yield sse.messageStart("deepseek-v4-flash")
        yield sse.thinkingStart("sig")
        yield sse.thinkingDelta("只分析了半段")
        yield END_TURN
        yield sse.messageStop()
      },
    ],
    assert(ctx) {
      const tb = thinkingBlocks(ctx)
      return [
        tb !== null && tb[0]!.thinking === "只分析了半段"
          ? pass("recovery 捕获 thinking", JSON.stringify(tb))
          : fail("recovery 捕获 thinking", `got ${JSON.stringify(tb)}`),
        errorOf(ctx) === null ? pass("无错误") : fail("无错误", `got error: ${errorOf(ctx)}`),
      ]
    },
  },
]
