/** event-adapter — 将 provider/agent 的 StreamEvent 翻译为 TuiEvent[]。
 *
 *  设计原则（来自 Orcana TUI Workbench PR-1 计划）：
 *    - 纯翻译：一个 StreamEvent → 0..N 个 TuiEvent
 *    - 有状态：跟踪 tool ID 映射（tool_call → tool_result 配对）
 *    - 不修改 TuiState —— 由 TuiStore.dispatchMany 负责
 *
 *  有状态原因：
 *    StreamEvent 的 tool_call/tool_result 没有稳定 ID，只有 tool name。
 *    适配器为每个 tool_call 生成递增 ID，存入 pendingTools 队列；
 *    tool_result 时从队列头部取出 ID，保证 FIFO 配对。
 *
 *  使用方式：
 *    const adapter = new StreamEventAdapter()
 *    for await (const ev of agentLoop(...)) {
 *      const tuiEvents = adapter.adapt(ev)
 *      if (tuiEvents.length) store.dispatchMany(tuiEvents)
 *    }
 *
 *  注意：
 *    - text 事件：适配器返回 [{ type: "assistant.delta", text }]。
 *      调用方（main.tsx）可自行做 120ms 缓冲，用累积 chunk 调用 adapt。
 *    - thinking_blocks / confirm：TUI 不消费，返回 []。
 *    - done：agent loop 结束后由调用方处理（dispatch assistant.final + ui.done）。
 */

import type { StreamEvent } from "../../provider/types"
import type { TuiEvent } from "../events"
import type { ClarificationReady } from "../../agent/clarification"
import {
  compactAssistantText,
  compactStatusText,
  cleanAgentError,
  formatStatusLineFromUsage,
  formatTelemetryLine,
  modelNameFromUsage,
  summarizeToolOutput,
  takeVisibleLines,
} from "./adapter-helpers"

// ── StreamEvent data shapes（main.tsx 中的内联类型） ──

interface ToolCallData {
  name?: string
}

interface ToolResultData {
  name?: string
  content?: string
}

interface TaskProgressData {
  goal: string
  phase: "planning" | "building" | "complete"
  done: number
  total: number
  current: string
}

interface PlanReadyData {
  score?: number
  goal?: string
  planText?: string
}

// ── Adapter ──

export class StreamEventAdapter {
  /** tool name → 待配对的 tool ID 队列（FIFO）。 */
  private pendingTools: Map<string, string[]> = new Map()
  /** 递增 tool 计数器，用于生成唯一 ID。 */
  private toolCounter = 0
  /** 本轮已启动的工具计数（toolName → count），token_usage 时聚合并清空。 */
  private roundToolCalls: Map<string, number> = new Map()
  /** 本轮工具汇总是否已发射（避免 token_usage 多次发射重复摘要）。 */
  private roundSummaryEmitted = false

  /** 将一个 StreamEvent 翻译为 0..N 个 TuiEvent。
   *  纯翻译 + 内部状态更新（pendingTools），不触碰 TuiState。 */
  adapt(ev: StreamEvent): TuiEvent[] {
    switch (ev.type) {
      case "text":
        return this.adaptText(ev)
      case "status":
        return this.adaptStatus(ev)
      case "task_progress":
        return this.adaptTaskProgress(ev)
      case "tool_call":
        return this.adaptToolCall(ev)
      case "tool_result":
        return this.adaptToolResult(ev)
      case "token_usage":
        return this.adaptTokenUsage(ev)
      case "plan_ready":
        return this.adaptPlanReady(ev)
      case "clarification_ready":
        return this.adaptClarificationReady(ev)
      case "error":
        return this.adaptError(ev)
      // thinking_blocks / confirm / done —— TUI 不消费
      case "thinking_blocks":
      case "confirm":
      case "done":
        return []
      default:
        return []
    }
  }

  // ── 各事件类型的翻译 ──

  private adaptText(ev: StreamEvent): TuiEvent[] {
    if (typeof ev.data !== "string" || !ev.data) return []
    return [{ type: "assistant.delta", text: ev.data }]
  }

  private adaptStatus(ev: StreamEvent): TuiEvent[] {
    if (typeof ev.data !== "string") return []
    return [{ type: "ui.status", text: compactStatusText(ev.data) }]
  }

  private adaptTaskProgress(ev: StreamEvent): TuiEvent[] {
    const task = ev.data as TaskProgressData | null
    if (!task) return []

    const events: TuiEvent[] = [
      { type: "task.assigned", task },
    ]

    const taskLine = task.phase === "planning"
      ? `planning gate: waiting for accepted model plan / ${task.goal}`
      : `task progress: ${task.done}/${task.total} ${task.current} / ${task.phase}`

    events.push({
      type: "ui.event_message",
      kind: "task",
      text: taskLine,
      dedupeKey: `task:${task.phase}:${task.done}:${task.current}`,
      minIntervalMs: 1000,
    })

    return events
  }

  private adaptToolCall(ev: StreamEvent): TuiEvent[] {
    const d = ev.data as ToolCallData
    if (!d?.name) return []

    const id = `tool-${++this.toolCounter}`
    const name = d.name

    // 存入 pendingTools 队列，等待 tool_result 配对
    const queue = this.pendingTools.get(name) ?? []
    queue.push(id)
    this.pendingTools.set(name, queue)

    // 记录每轮工具计数（用于 token_usage 时发聚合摘要）。
    // 若这是本轮第一个工具调用 → 重置 summary 标志位。
    if (this.roundToolCalls.size === 0) {
      this.roundSummaryEmitted = false
    }
    this.roundToolCalls.set(name, (this.roundToolCalls.get(name) ?? 0) + 1)

    return [{ type: "tool.started", id, tool: name }]
  }

  private adaptToolResult(ev: StreamEvent): TuiEvent[] {
    const d = ev.data as ToolResultData
    if (!d?.name) return []

    const name = d.name
    const queue = this.pendingTools.get(name) ?? []
    const id = queue.shift() ?? `orphan-${++this.toolCounter}`
    if (queue.length === 0) {
      this.pendingTools.delete(name)
    } else {
      this.pendingTools.set(name, queue)
    }

    const summary = summarizeToolOutput(d.content)

    return [{
      type: "tool.finished",
      id,
      ok: true,
      outputSummary: summary || undefined,
    }]
  }

  private adaptTokenUsage(ev: StreamEvent): TuiEvent[] {
    const d = ev.data as Record<string, unknown>
    if (!d || typeof d !== "object") return []

    const events: TuiEvent[] = []

    // ── 本轮工具活动聚合摘要（仅 provider 侧真实数据时发射一次） ──
    const isProviderUsage = d.cacheSource === "provider" || typeof d.actualModel === "string"
    if (isProviderUsage && !this.roundSummaryEmitted && this.roundToolCalls.size > 0) {
      const round = typeof d.round === "number" ? d.round : "?"
      events.push({
        type: "ui.event_message",
        kind: "activity",
        text: `round ${round}`,
        dedupeKey: `round-activity:${round}`,
        replaceKey: "round-progress",
        minIntervalMs: 0,
      })
      this.roundSummaryEmitted = true
      this.roundToolCalls.clear()
    }

    // 模型名更新
    const nextModel = typeof d.actualModel === "string"
      ? d.actualModel
      : typeof d.requestedModel === "string"
        ? d.requestedModel
        : undefined
    if (nextModel) {
      events.push({ type: "ui.model_name", name: nextModel })
    }

    // 状态行：ctx X% / cache Y% / rZ
    events.push({ type: "ui.status", text: formatStatusLineFromUsage(d) })

    // 遥测行
    events.push({ type: "ui.telemetry", text: formatTelemetryLine(d, nextModel) })

    // token 更新（所有字段可选，reducer 用 ?? 保留旧值）
    events.push({
      type: "token.updated",
      inputTokens: typeof d.inputTokens === "number" ? d.inputTokens : undefined,
      outputTokens: typeof d.outputTokens === "number" ? d.outputTokens : undefined,
      contextMax: typeof d.contextMax === "number" ? d.contextMax : undefined,
      activeContextPercent: typeof d.contextUsagePercent === "number" ? d.contextUsagePercent : undefined,
      // Pre-request estimates always report 0 on a changing conversation hash.
      // They are not provider cache telemetry and must not erase the last real rate.
      ...(d.cacheSource !== "estimate" && typeof d.cacheHitRate === "number"
        ? { cacheHitRate: d.cacheHitRate }
        : {}),
      round: typeof d.round === "number" ? d.round : undefined,
    })

    return events
  }

  private adaptPlanReady(ev: StreamEvent): TuiEvent[] {
    const d = ev.data as PlanReadyData
    if (!d) return []

    const score = typeof d.score === "number" ? ` score ${Math.round(d.score * 100)}%` : ""
    const goal = d.goal ? ` / ${d.goal}` : ""
    const planText = d.planText ? `\n${takeVisibleLines(compactAssistantText(d.planText), 8)}` : ""

    return [{
      type: "ui.event_message",
      kind: "plan",
      text: `plan ready${score}${goal}${planText}`,
      dedupeKey: `plan:${d.goal ?? ""}:${d.score ?? ""}`,
      minIntervalMs: 0,
    }]
  }

  private adaptClarificationReady(ev: StreamEvent): TuiEvent[] {
    const d = ev.data as ClarificationReady
    if (!d) return []
    return [{ type: "clarification.ready", data: d }]
  }

  private adaptError(ev: StreamEvent): TuiEvent[] {
    if (typeof ev.data !== "string") return []
    const errorText = cleanAgentError(ev.data)
    return [
      { type: "error", message: errorText },
      { type: "ui.error_line", text: errorText },
      {
        type: "ui.event_message",
        kind: "error",
        text: errorText,
        dedupeKey: `error:${errorText}`,
        minIntervalMs: 10_000,
      },
    ]
  }

  /** 重置适配器内部状态（用于 /clear 或会话重置）。 */
  reset(): void {
    this.pendingTools.clear()
    this.toolCounter = 0
    this.roundToolCalls.clear()
    this.roundSummaryEmitted = false
  }
}
