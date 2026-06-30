/** event-reducer — 纯 reducer，处理所有 TuiEvent 类型。
 *
 *  设计不变量（来自 Orcana TUI Workbench PR-1 计划）：
 *    - 纯函数：永远不修改输入 state，返回新对象
 *    - 所有列表 ring-buffered（见 LIMITS）
 *    - `streamingText` 累积 assistant.delta；assistant.final 清空它
 *    - TuiStore 是唯一的 mutation 边界；UI 通过 selector 读取
 *
 *  `now` 参数：
 *    - 可选，默认 Date.now()
 *    - 用于 message/event 的 createdAt 时间戳
 *    - 用于 ui.event_message 去重（_lastEventKey / _lastEventAt）
 *    - 测试时可传入固定值以确保确定性
 *
 *  `_nextId` 是内部单调 ID 计数器，用于生成 message/evidence/gate/error 的 ID。
 *  reducer 通过局部变量递增，绝不修改输入 state 的 _nextId。
 */

import type { ClarificationReady } from "../../agent/clarification"
import type {
  TuiEvent,
  TuiClarificationState,
  TuiClarificationQuestion,
  TuiClarificationOption,
} from "../events"
import type {
  TuiState,
  TuiMessage,
  TuiToolEvent,
  TuiPatchEvent,
  TuiEvidenceEvent,
  TuiGateEvent,
  TuiErrorEvent,
} from "./types"
import {
  appendAssistantText,
  formatClarificationTranscript,
  summarizeUserPromptForTranscript,
} from "./adapter-helpers"

// ── Ring buffer 上限 ──

export const LIMITS = {
  messages: 500,
  tools: 200,
  patches: 100,
  evidence: 200,
  gates: 200,
  errors: 100,
  /** main.tsx dash.toolHistory 用 slice(-15) + push，上限 16。 */
  dashToolHistory: 16,
  /** main.tsx dash.cacheHits 用 slice(-20) + push，上限 21。 */
  cacheHitHistory: 21,
} as const

// ── 初始 state ──

export function createInitialTuiState(): TuiState {
  return {
    session: {},
    mode: "discussion",
    messages: [],
    streamingText: "",
    tools: [],
    patches: [],
    evidence: [],
    gates: [],
    errors: [],
    tokens: { inputTokens: 0, outputTokens: 0, contextMax: 0 },
    cost: {},
    // UI extensions
    status: "ready",
    telemetry: "",
    modelName: process.env.DEEPSEEK_MODEL_OVERRIDE ?? "deepseek-v4-pro",
    done: true,
    queueCount: 0,
    errorLine: "",
    // Dashboard denormalization
    round: 0,
    cacheHitHistory: [],
    rippleFindings: [],
    dashToolHistory: [],
    // Internal
    _nextId: 0,
    _lastEventKey: null,
    _lastEventAt: 0,
  }
}

// ── Reducer ──

export function reduceTuiEvent(
  state: TuiState,
  event: TuiEvent,
  now?: number,
): TuiState {
  const ts = now ?? Date.now()

  switch (event.type) {
    // ── 会话与模式 ──

    case "session.started": {
      return {
        ...state,
        session: {
          sessionId: event.sessionId,
          repoRoot: event.repoRoot,
          branch: event.branch,
          provider: event.provider,
          model: event.model,
        },
        modelName: event.model ?? state.modelName,
      }
    }

    case "mode.changed": {
      return { ...state, mode: event.mode }
    }

    // ── 对话 ──

    case "user.message": {
      // 复刻 main.tsx runAgent 启动逻辑：
      //   1. 创建 user message（带 transcript 摘要）
      //   2. 创建空 pending assistant message
      //   3. 重置 run 级状态（streamingText / task / dash / done / error / clarification）
      let nextId = state._nextId
      const userMsg: TuiMessage = {
        id: `msg-${++nextId}`,
        role: "user",
        text: summarizeUserPromptForTranscript(event.text),
        createdAt: ts,
      }
      const assistantMsg: TuiMessage = {
        id: `msg-${++nextId}`,
        role: "assistant",
        text: "",
        pending: true,
        createdAt: ts,
      }
      return {
        ...state,
        _nextId: nextId,
        // Run 级重置（镜像 main.tsx setState: text/status/done/error/dash/task）
        streamingText: "",
        status: "starting...",
        done: false,
        errorLine: "",
        task: undefined,
        clarification: undefined,
        round: 0,
        cacheHitHistory: [],
        rippleFindings: [],
        dashToolHistory: [],
        // 新消息
        messages: pushManyBounded(state.messages, [userMsg, assistantMsg], LIMITS.messages),
      }
    }

    case "assistant.delta": {
      if (!event.text) return state
      const nextStreaming = state.streamingText + event.text
      const idx = findPendingAssistantIndex(state.messages)
      if (idx < 0) {
        // 无 pending assistant message —— 创建一个（适配器未先发 user.message 的边界情况）
        let nextId = state._nextId
        const msg: TuiMessage = {
          id: `msg-${++nextId}`,
          role: "assistant",
          text: appendAssistantText("", event.text),
          pending: true,
          createdAt: ts,
        }
        return {
          ...state,
          _nextId: nextId,
          streamingText: nextStreaming,
          messages: pushBounded(state.messages, msg, LIMITS.messages),
        }
      }
      const messages = state.messages.slice()
      const existing = messages[idx]!
      messages[idx] = {
        ...existing,
        text: appendAssistantText(existing.text, event.text),
      }
      return {
        ...state,
        streamingText: nextStreaming,
        messages,
      }
    }

    case "assistant.final": {
      const idx = findPendingAssistantIndex(state.messages)
      if (idx < 0) {
        // 无 pending message —— 仅当 text 非空时创建一条 finalized 消息
        if (!event.text) return { ...state, streamingText: "" }
        let nextId = state._nextId
        const msg: TuiMessage = {
          id: `msg-${++nextId}`,
          role: "assistant",
          text: event.text,
          createdAt: ts,
        }
        return {
          ...state,
          _nextId: nextId,
          streamingText: "",
          messages: pushBounded(state.messages, msg, LIMITS.messages),
        }
      }
      const messages = state.messages.slice()
      const existing = messages[idx]!
      messages[idx] = {
        ...existing,
        // 若 final text 非空则替换累积 delta；否则保留累积文本
        text: event.text || existing.text,
        pending: false,
      }
      return {
        ...state,
        streamingText: "",
        messages,
      }
    }

    // ── Task / Plan ──

    case "task.assigned": {
      return { ...state, task: event.task }
    }

    case "plan.updated": {
      return { ...state, plan: event.plan }
    }

    // ── 工具 ──

    case "tool.started": {
      const toolEvent: TuiToolEvent = {
        id: event.id,
        tool: event.tool,
        status: "running",
        summary: event.summary,
        risk: event.risk,
        startedAt: ts,
      }
      const dashEntry = { name: event.tool, status: "running" as const }
      return {
        ...state,
        tools: pushBounded(state.tools, toolEvent, LIMITS.tools),
        dashToolHistory: pushBounded(state.dashToolHistory, dashEntry, LIMITS.dashToolHistory),
      }
    }

    case "tool.finished": {
      const idx = state.tools.findIndex(t => t.id === event.id)
      let tools: TuiToolEvent[]
      let dashName: string | undefined

      if (idx >= 0) {
        const existing = state.tools[idx]!
        tools = state.tools.slice()
        tools[idx] = {
          ...existing,
          status: event.ok ? "passed" : "failed",
          outputSummary: event.outputSummary,
          finishedAt: ts,
          durationMs: event.durationMs ?? (existing.startedAt !== undefined ? ts - existing.startedAt : undefined),
        }
        dashName = existing.tool
      } else {
        // Orphan: tool.finished 无匹配的 tool.started
        const orphan: TuiToolEvent = {
          id: event.id,
          tool: "unknown",
          status: "orphan",
          summary: "orphan tool result",
          outputSummary: event.outputSummary,
          finishedAt: ts,
        }
        tools = pushBounded(state.tools, orphan, LIMITS.tools)
        // orphan 无工具名，跳过 dashToolHistory push（与 main.tsx 在 d.name 缺失时跳过的行为一致）
        dashName = undefined
      }

      const dashToolHistory = dashName
        ? pushBounded(
            state.dashToolHistory,
            { name: dashName, status: "done" as const },
            LIMITS.dashToolHistory,
          )
        : state.dashToolHistory

      return {
        ...state,
        tools,
        dashToolHistory,
      }
    }

    // ── 补丁 ──

    case "patch.proposed": {
      const patch: TuiPatchEvent = {
        txId: event.txId,
        status: "proposed",
        files: event.files,
        summary: event.summary,
        createdAt: ts,
      }
      return {
        ...state,
        patches: pushBounded(state.patches, patch, LIMITS.patches),
      }
    }

    case "patch.committed": {
      return updatePatchStatus(state, event.txId, "committed", event.files, undefined, ts)
    }

    case "patch.rolled_back": {
      return updatePatchStatus(state, event.txId, "rolled_back", event.files, event.reason, ts)
    }

    // ── 证据 / 门禁 ──

    case "evidence.added": {
      let nextId = state._nextId
      const evidence: TuiEvidenceEvent = {
        id: `evidence-${++nextId}`,
        kind: event.kind,
        status: event.status,
        summary: event.summary,
        command: event.command,
        txId: event.txId,
        createdAt: ts,
      }
      return {
        ...state,
        _nextId: nextId,
        evidence: pushBounded(state.evidence, evidence, LIMITS.evidence),
      }
    }

    case "gate.result": {
      let nextId = state._nextId
      const gate: TuiGateEvent = {
        id: `gate-${++nextId}`,
        gate: event.gate,
        status: event.status,
        reason: event.reason,
        profile: event.profile,
        createdAt: ts,
      }
      return {
        ...state,
        _nextId: nextId,
        gates: pushBounded(state.gates, gate, LIMITS.gates),
      }
    }

    // ── Token / Cost ──

    case "token.updated": {
      const prevTokens = state.tokens
      const nextTokens = {
        inputTokens: event.inputTokens ?? prevTokens.inputTokens,
        outputTokens: event.outputTokens ?? prevTokens.outputTokens,
        contextMax: event.contextMax ?? prevTokens.contextMax,
        cacheHitRate: event.cacheHitRate ?? prevTokens.cacheHitRate,
      }
      const result: TuiState = {
        ...state,
        tokens: nextTokens,
      }
      // round 更新（UI 扩展字段，Dashboard 需要）
      if (event.round !== undefined) {
        result.round = event.round
      }
      // cacheHitHistory push（镜像 main.tsx dash.cacheHits slice(-20) + push）
      if (event.cacheHitRate !== undefined) {
        result.cacheHitHistory = pushBounded(
          state.cacheHitHistory,
          event.cacheHitRate,
          LIMITS.cacheHitHistory,
        )
      }
      return result
    }

    case "cost.updated": {
      return {
        ...state,
        cost: { ...state.cost, estimatedUsd: event.estimatedUsd },
      }
    }

    case "error": {
      let nextId = state._nextId
      const errorEvent: TuiErrorEvent = {
        id: `error-${++nextId}`,
        message: event.message,
        recoverable: event.recoverable,
        createdAt: ts,
      }
      return {
        ...state,
        _nextId: nextId,
        errors: pushBounded(state.errors, errorEvent, LIMITS.errors),
      }
    }

    // ── UI 扩展事件 ──

    case "ui.status": {
      return { ...state, status: event.text }
    }

    case "ui.telemetry": {
      return { ...state, telemetry: event.text }
    }

    case "ui.model_name": {
      return { ...state, modelName: event.name }
    }

    case "ui.done": {
      return { ...state, done: event.done }
    }

    case "ui.queue_count": {
      return { ...state, queueCount: event.count }
    }

    case "ui.error_line": {
      return { ...state, errorLine: event.text }
    }

    case "ui.event_message": {
      const trimmed = event.text.trim()
      if (!trimmed) return state

      const key = event.dedupeKey ?? `${event.kind}:${trimmed}`
      const minInterval = event.minIntervalMs ?? 1000

      // 去重：同 key 且间隔不足 minInterval 则跳过（镜像 main.tsx lastEventRef）
      if (state._lastEventKey === key && ts - state._lastEventAt < minInterval) {
        return state
      }

      let nextId = state._nextId
      const msg: TuiMessage = {
        id: `msg-${++nextId}`,
        role: "event",
        kind: event.kind,
        text: trimmed,
        createdAt: ts,
      }
      return {
        ...state,
        _nextId: nextId,
        _lastEventKey: key,
        _lastEventAt: ts,
        messages: pushBounded(state.messages, msg, LIMITS.messages),
      }
    }

    case "clarification.ready": {
      const data: ClarificationReady = event.data
      // 从 ClarificationReady 构造 TuiClarificationState
      const questions: TuiClarificationQuestion[] = data.questions.map(q => ({
        id: q.id,
        title: q.title,
        options: q.options.map<TuiClarificationOption>(o => ({
          key: o.key,
          label: o.label,
          recommended: o.recommended,
        })),
      }))
      const firstQuestion = questions[0]
      const clarification: TuiClarificationState = {
        originalPrompt: data.originalPrompt,
        questions,
        index: 0,
        selected: recommendedOptionIndex(firstQuestion),
        answers: [],
        extraPrompt: data.extraPrompt,
        rawText: data.rawText,
      }

      // 更新 pending assistant message 为 clarification 可见文本
      // （镜像 main.tsx: messages.map(m => m.id === assistantId ? {...m, content: visibleText, pending: false} : m)）
      const visibleText = formatClarificationTranscript(data)
      const idx = findPendingAssistantIndex(state.messages)
      const messages = idx >= 0 ? state.messages.slice() : state.messages
      if (idx >= 0) {
        const existing = messages[idx]!
        messages[idx] = {
          ...existing,
          text: visibleText,
          pending: false,
        }
      }

      return {
        ...state,
        clarification,
        status: "clarification needed",
        done: true,
        messages,
      }
    }

    default: {
      // 穷尽性检查：若 TuiEvent 新增类型，此处编译失败
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

// ── 内部 helper ──

/** 不可变地 push 一个元素到 ring buffer，超过 limit 时丢弃最旧的。 */
function pushBounded<T>(arr: readonly T[], item: T, limit: number): T[] {
  const next = [...arr, item]
  if (next.length > limit) return next.slice(next.length - limit)
  return next
}

/** 不可变地 push 多个元素到 ring buffer。 */
function pushManyBounded<T>(arr: readonly T[], items: readonly T[], limit: number): T[] {
  const next = [...arr, ...items]
  if (next.length > limit) return next.slice(next.length - limit)
  return next
}

/** 找到最后一条 pending assistant message 的索引，找不到返回 -1。 */
function findPendingAssistantIndex(messages: readonly TuiMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === "assistant" && m.pending) return i
  }
  return -1
}

/** 返回 question 中第一个 recommended 选项的索引，无则 0。
 *  镜像 main.tsx recommendedOptionIndex。 */
function recommendedOptionIndex(question: TuiClarificationQuestion | undefined): number {
  if (!question?.options.length) return 0
  const recommended = question.options.findIndex(o => o.recommended)
  return recommended >= 0 ? recommended : 0
}

/** 更新补丁状态（用于 patch.committed / patch.rolled_back）。
 *  若 txId 存在则更新；否则创建新条目。 */
function updatePatchStatus(
  state: TuiState,
  txId: string,
  status: "committed" | "rolled_back",
  files: string[],
  reason: string | undefined,
  ts: number,
): TuiState {
  const idx = state.patches.findIndex(p => p.txId === txId)
  if (idx >= 0) {
    const patches = state.patches.slice()
    const existing = patches[idx]!
    patches[idx] = {
      ...existing,
      status,
      files: files.length > 0 ? files : existing.files,
      reason,
      createdAt: ts,
    }
    return { ...state, patches }
  }
  // txId 未找到 —— 创建新条目
  const patch: TuiPatchEvent = {
    txId,
    status,
    files,
    reason,
    createdAt: ts,
  }
  return {
    ...state,
    patches: pushBounded(state.patches, patch, LIMITS.patches),
  }
}
