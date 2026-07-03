/** selectThinkingDock — 从 TuiState 派生 ThinkingDock 视图模型（PR-1）。
 *
 *  纯函数 selector：输入 TuiState，输出 ThinkingDockModel。
 *  不修改 state，不产生副作用。
 *
 *  分类规则：
 *    state.errorLine 存在      → error
 *    active running tools      → tooling
 *    state.status 含 planning  → thinking
 *    state.status 含 evidence  → reviewing
 *    agent running 无工具      → composing
 *    idle (done=true)          → hidden
 */

import type { TuiState } from "../state/types"
import { classifyPendingActivity } from "../pending-activity"
import type { PendingActivity } from "../pending-activity"

// ── ThinkingPhase ──

export type ThinkingPhase =
  | "idle"
  | "routing"
  | "thinking"
  | "reading"
  | "tooling"
  | "reviewing"
  | "composing"
  | "error"

export interface ThinkingDockModel {
  visible: boolean
  phase: ThinkingPhase
  label: string
  branch?: string
  contextPct?: number
  cachePct?: number
  activeTools?: Array<{ name: string; count: number }>
}

// ── 标签映射 ──

const PHASE_LABELS: Record<ThinkingPhase, string> = {
  idle: "",
  routing: "Routing...",
  thinking: "Thinking...",
  reading: "Reading context...",
  tooling: "Running tools...",
  reviewing: "Reviewing evidence...",
  composing: "Composing...",
  error: "Error",
}

// ── PendingActivity → ThinkingPhase ──

const ACTIVITY_TO_PHASE: Record<PendingActivity, ThinkingPhase> = {
  routing: "routing",
  reading: "reading",
  editing: "composing",
  verifying: "reviewing",
  blocked: "thinking",
  streaming: "composing",
  stalled: "thinking",
  working: "composing",
}

// ── Selector ──

/** 聚合工具计数。同名工具合并计数。 */
function aggregateTools(tools: Array<{ tool: string; status: string }>): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const t of tools) {
    if (t.status === "running") {
      counts.set(t.tool, (counts.get(t.tool) ?? 0) + 1)
    }
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
}

/** 从 TuiState 派生 ThinkingDock 视图模型。 */
export function selectThinkingDock(state: TuiState): ThinkingDockModel {
  // ── Error 优先 ──
  if (state.errorLine) {
    return { visible: true, phase: "error", label: state.errorLine }
  }

  // ── Idle ──
  if (state.done) {
    return { visible: false, phase: "idle", label: "" }
  }

  // ── 活跃工具 → tooling ──
  const runningTools = state.tools.filter(t => t.status === "running")
  if (runningTools.length > 0) {
    const activeTools = aggregateTools(runningTools)
    const label = activeTools.length === 1
      ? `Running ${activeTools[0]!.name}`
      : `Running ${runningTools.length} tools`
    return {
      visible: true,
      phase: "tooling",
      label,
      activeTools: activeTools.slice(0, 3),
    }
  }

  // ── 状态文本 → phase ──
  const activity = classifyPendingActivity(state.status || "thinking")
  const phase = ACTIVITY_TO_PHASE[activity] ?? "composing"

  // ── 上下文/缓存百分比 ──
  const ctxMax = state.tokens.contextMax || 200000
  const ctxPct = ctxMax > 0 ? Math.round((state.tokens.inputTokens / ctxMax) * 100) : 0
  const cachePct = state.tokens.cacheHitRate !== undefined
    ? Math.round(state.tokens.cacheHitRate * 100)
    : undefined

  return {
    visible: phase !== "idle",
    phase,
    label: PHASE_LABELS[phase] ?? "Working...",
    contextPct: ctxPct,
    cachePct,
  }
}
