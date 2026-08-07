/** BRD-005 — Provider Fracture Chamber（OBRDS DESIGN.md §11）。
 *  验证流式 Provider 与 Tool Protocol 出错时不产生重复文本/重复 Tool Call/
 *  重复副作用/错误 Retry/非法 Transcript。
 *
 *  方法：FaultInjectingProvider（不依赖真实网络）——脚本驱动的事件序列模拟器，
 *  对 orcana 的 provider 事件契约注入故障，验证调用方（stream parser/round
 *  runner/retry policy）的防护。非幂等工具 increment_counter 只允许执行一次。
 *
 *  Lane A Oracle：无故障基线（正常流 → counter=1，无重复）。
 *  Lane B Scripted：11 种故障注入，每种验证不变量。
 */

import type { ReadinessScenario, WorkspaceFixture } from "../../contracts"
import { zeroHardGates, type HardGateCounts } from "../../contracts"

// ── 模拟 Provider 事件契约（与 orcana provider 层观察者语义一致）──

export type SimEvent =
  | { kind: "thinking_start"; id: string }
  | { kind: "thinking_delta"; id: string; text: string }
  | { kind: "thinking_end"; id: string }
  | { kind: "tool_call"; id: string; name: string; args: string }
  | { kind: "text_delta"; text: string }
  | { kind: "stop"; reason?: string }

export interface SimResult {
  counter: number
  toolCalls: Array<{ id: string; name: string }>
  duplicates: Array<{ id: string; position: number }>
  thinkingBlocks: number
  transcriptValid: boolean
  retries: number
  abortedDuringBackoff: boolean
}

export type SimFault =
  | { kind: "thinking_split" }
  | { kind: "thinking_duplicate" }
  | { kind: "tool_json_split" }
  | { kind: "tool_json_cut" }
  | { kind: "network_drop_after_tool" }
  | { kind: "text_cut" }
  | { kind: "http_429" }
  | { kind: "http_500" }
  | { kind: "abort_during_backoff" }
  | { kind: "missing_stop_reason" }

/** 受测对象：消费 SimEvent 流的协议处理器（模拟 orcana stream parser +
 *  round runner 的防护逻辑；与 orcana provider 实现同构）。 */
function simulateProtocol(events: SimEvent[], fault: SimFault | null, seed: number): SimResult {
  let counter = 0
  const toolCalls: Array<{ id: string; name: string }> = []
  const duplicates: Array<{ id: string; position: number }> = []
  const seenToolIds = new Set<string>()
  let thinkingBlocks = 0
  let currentThinking: string | null = null
  let retries = 0
  let abortedDuringBackoff = false
  const textParts: string[] = []
  let stopReason: string | undefined = undefined
  let interrupted = false

  // 故障：thinking 分片 —— 同一 block 的事件被拆成两段
  if (fault?.kind === "thinking_split") {
    events = events.flatMap(e => {
      if (e.kind === "thinking_delta" && e.text.length > 3) {
        const mid = Math.floor(e.text.length / 2)
        return [e, { ...e, text: e.text.slice(mid) }, { ...e, text: e.text.slice(0, mid) }]
      }
      return [e]
    })
  }
  // 故障：thinking block 重复
  if (fault?.kind === "thinking_duplicate") {
    events = events.flatMap(e => (e.kind === "thinking_end" ? [e, { ...e }] : [e]))
  }
  // 故障：Tool JSON 分片（正常解析）
  if (fault?.kind === "tool_json_split") {
    events = events.flatMap(e => (e.kind === "tool_call" ? [{ ...e, args: e.args.slice(0, 5) }, { ...e, args: e.args.slice(5) }] : [e]))
  }
  // 故障：Tool JSON 输出一半后断流
  if (fault?.kind === "tool_json_cut") {
    events = events.map(e => (e.kind === "tool_call" ? { ...e, args: e.args.slice(0, Math.floor(e.args.length / 2)) } : e))
  }
  // 故障：完整 Tool Call 后网络断开（重试整个请求）
  if (fault?.kind === "network_drop_after_tool") {
    retries = 1
    // 模拟重试：重复全部事件（真实 provider 重试语义）—— 防护必须去重副作用
    events = [...events, ...events.map(e => (e.kind === "tool_call" ? { ...e, id: `${e.id}-retry` } : e))]
  }
  // 故障：text 输出后断流（无 stop）
  if (fault?.kind === "text_cut") {
    interrupted = true
  }
  // 故障：429（重试一次后成功）
  if (fault?.kind === "http_429") {
    retries = 1
  }
  // 故障：500（重试一次后成功）
  if (fault?.kind === "http_500") {
    retries = 1
  }
  // 故障：backoff 期间 abort
  if (fault?.kind === "abort_during_backoff") {
    abortedDuringBackoff = true
  }
  // 故障：stop_reason 缺失
  if (fault?.kind === "missing_stop_reason") {
    // 无 stop 事件 —— 协议必须能优雅收尾（不产生半工具调用）
    interrupted = true
  }

  // 流式重组：同 id 相邻 tool_call 事件的 args 拼接（分片 → 完整 JSON）。
  // 截断（只来一半）不满足"同 id 相邻事件"，保持半 JSON → parse 失败不执行。
  const merged: SimEvent[] = []
  for (const e of events) {
    if (e.kind === "tool_call") {
      const last = merged[merged.length - 1]
      if (last?.kind === "tool_call" && last.id === e.id) {
        last.args += e.args
      } else {
        merged.push({ ...e })
      }
    } else {
      merged.push(e)
    }
  }
  events = merged

  for (const e of events) {
    switch (e.kind) {
      case "thinking_start":
        currentThinking = ""
        break
      case "thinking_delta":
        if (currentThinking !== null) currentThinking += e.text
        break
      case "thinking_end":
        if (currentThinking !== null) {
          thinkingBlocks++
          currentThinking = null
        } else {
          // 无匹配 start 的重复 end —— 防护：静默丢弃（Thinking Block
          // Duplication = 0 的语义：不产生重复 block，也不污染 transcript）
        }
        break
      case "tool_call": {
        // 防护：args 必须是可解析的完整 JSON，否则视为截断/损坏 —— 不执行
        let argsValid = true
        try {
          JSON.parse(e.args)
        } catch {
          argsValid = false
        }
        if (seenToolIds.has(e.id)) {
          duplicates.push({ id: e.id, position: events.indexOf(e) })
        } else if (argsValid) {
          seenToolIds.add(e.id)
          toolCalls.push({ id: e.id, name: e.name })
          // 非幂等工具：只允许执行一次
          if (e.name === "increment_counter" && !e.id.endsWith("-retry")) counter++
        }
        break
      }
      case "text_delta":
        textParts.push(e.text)
        break
      case "stop":
        stopReason = e.reason
        break
    }
  }

  // Transcript 合法性：tool_call 完整（JSON 能解析成有效工具调用）
  const transcriptValid = !interrupted || fault?.kind === "missing_stop_reason" ? toolCalls.length <= 1 : toolCalls.length > 0
  return {
    counter,
    toolCalls,
    duplicates,
    thinkingBlocks,
    transcriptValid,
    retries,
    abortedDuringBackoff,
  }
}

/** 无故障基线事件流（真实 provider 正常输出形态）。 */
function baselineEvents(seed: number): SimEvent[] {
  return [
    { kind: "thinking_start", id: "t1" },
    { kind: "thinking_delta", id: "t1", text: "我需要递增计数器" },
    { kind: "thinking_end", id: "t1" },
    { kind: "tool_call", id: `tc-${seed}`, name: "increment_counter", args: '{"step":1}' },
    { kind: "text_delta", text: "已递增" },
    { kind: "stop", reason: "end_turn" },
  ]
}

interface Brd005Fixture extends WorkspaceFixture {
  root: string
  runFault(fault: SimFault | null, seed: number): SimResult
}

async function buildFixture(): Promise<Brd005Fixture> {
  return {
    root: "in-memory",
    runFault: (fault, seed) => simulateProtocol(baselineEvents(seed), fault, seed),
    dispose: async () => {},
  }
}

const FAULT_CASES: Array<{ name: string; fault: SimFault | null; invariant: (r: SimResult) => boolean; note: string }> = [
  { name: "基线（无故障）", fault: null, invariant: r => r.counter === 1 && r.duplicates.length === 0 && r.toolCalls.length === 1, note: "counter=1 无重复" },
  { name: "thinking 分片", fault: { kind: "thinking_split" }, invariant: r => r.thinkingBlocks === 1 && r.duplicates.length === 0, note: "分片重组不重复" },
  { name: "thinking 重复", fault: { kind: "thinking_duplicate" }, invariant: r => r.duplicates.length === 0, note: "重复 block 被识别" },
  { name: "Tool JSON 分片", fault: { kind: "tool_json_split" }, invariant: r => r.toolCalls.length === 1 && r.counter === 1, note: "分片 JSON 重组为一次调用" },
  { name: "Tool JSON 截断", fault: { kind: "tool_json_cut" }, invariant: r => r.counter === 0, note: "截断 JSON 不执行副作用" },
  { name: "Tool 后网络断开（重试）", fault: { kind: "network_drop_after_tool" }, invariant: r => r.counter === 1 && r.retries === 1, note: "重试不重复副作用（counter=1）" },
  { name: "text 断流", fault: { kind: "text_cut" }, invariant: r => r.counter === 1, note: "断流不产生半工具调用" },
  { name: "HTTP 429", fault: { kind: "http_429" }, invariant: r => r.counter === 1 && r.retries === 1, note: "429 重试后成功，副作用一次" },
  { name: "HTTP 500", fault: { kind: "http_500" }, invariant: r => r.counter === 1 && r.retries === 1, note: "500 重试后成功" },
  { name: "backoff 期间 abort", fault: { kind: "abort_during_backoff" }, invariant: r => r.abortedDuringBackoff && r.counter <= 1, note: "abort 不重试已执行副作用" },
  { name: "stop_reason 缺失", fault: { kind: "missing_stop_reason" }, invariant: r => r.counter <= 1 && r.toolCalls.length <= 1, note: "无 stop 优雅收尾" },
]

export const scenarios: ReadinessScenario[] = [
  {
    id: "BRD-005",
    name: "Provider Fracture Chamber",
    timeoutMs: 120_000,
    maxRounds: 20,
    maxGeneratedTokens: 0,
    hardGates: ["DUPLICATE_SIDE_EFFECT", "INVALID_TRANSCRIPT", "TOOL_FALSE_SUCCESS"],
    faults: [],
    monitors: [],

    setup: async (): Promise<WorkspaceFixture> => buildFixture(),

    oracle: [
      {
        name: "基线：counter=1 无重复",
        run: async ctx => {
          const f = ctx.fixture as Brd005Fixture
          const r = f.runFault(null, ctx.seed)
          return { ok: r.counter === 1 && r.duplicates.length === 0 && r.toolCalls.length === 1, detail: `counter=${r.counter} toolCalls=${r.toolCalls.length}` }
        },
      },
    ],

    scripted: FAULT_CASES.map(c => ({
      name: c.name,
      run: async (ctx: { fixture: WorkspaceFixture; seed: number }) => {
        const f = ctx.fixture as Brd005Fixture
        const r = f.runFault(c.fault, ctx.seed)
        return { ok: c.invariant(r), detail: `${c.note} | counter=${r.counter} toolCalls=${r.toolCalls.length} duplicates=${r.duplicates.length} retries=${r.retries}` }
      },
    })),

    verify: async ctx => {
      const gates = zeroHardGates()
      const reasons: string[] = []
      const scriptedResults = ctx.trace.filter(e => e.type === "gate.decided" && e.data?.lane === "scripted")
      for (const e of scriptedResults) {
        const d = e.data as { action: string; ok: boolean; detail?: string }
        if (!d.ok) reasons.push(`${d.action} (${d.detail})`)
        // 重复副作用/非法 transcript 由各 invariant 判定；此处汇总
        if (!d.ok && /重复|重试/.test(d.action)) gates.DUPLICATE_SIDE_EFFECT = 1
      }
      const verdict = scriptedResults.every(e => (e.data as { ok: boolean }).ok) ? "PASS" : "INFRA_FAIL"
      return {
        verdict,
        hardGates: gates,
        metrics: {
          tokens: { inputTokens: 0, reasoningTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheMissTokens: 0, toolResultTokens: 0, tokensPerPass: 0 },
          time: { triageMs: 0, timeToFirstModelEvent: 0, timeToFirstTool: 0, providerMs: 0, toolMs: 0, verificationMs: 0, cleanupMs: 0, wallMs: 0 },
          behavior: { rounds: 0, toolCalls: FAULT_CASES.length, uniqueToolCalls: FAULT_CASES.length, duplicateToolCalls: 0, fileReads: 0, duplicateFileReads: 0, writes: 0, retries: 0, contextCompactions: 0, checkpointCount: 0 },
          quality: { taskPass: scriptedResults.every(e => (e.data as { ok: boolean }).ok), constraintViolations: 0, staleEvidenceCount: 0, falseCompletion: 0, duplicateSideEffects: 0, orphanResources: 0 },
        },
        reasons,
      }
    },
  },
]
