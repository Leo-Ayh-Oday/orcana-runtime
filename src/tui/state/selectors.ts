/** selectors — 从 TuiState 派生 UI 所需的视图数据。
 *
 *  设计原则（来自 Orcana TUI Workbench PR-1 计划）：
 *    - selector 是纯函数：(state, ...opts) => viewData
 *    - 不修改 state，不产生副作用
 *    - UI 组件通过 selector 读取数据，不直接访问 state 内部结构
 *
 *  Selector 列表：
 *    selectVisibleMessages(state, {height, scrollOffset})
 *        → 转录区可见消息 + scroll 元数据
 *    selectRecentTools(state, limit)
 *        → 最近 N 个工具事件
 *    selectEvidenceSummary(state)
 *        → 证据统计 { total, passed, failed, skipped }
 *    selectGateSummary(state)
 *        → 门禁统计 { total, pass, block, skip }
 *    selectHeaderStatus(state)
 *        → 头部状态行数据
 *    selectRightRail(state)
 *        → Dashboard（右侧栏）数据
 */

import type {
  TuiDashToolHistoryEntry,
  TuiRippleFinding,
  TuiState,
  TuiMessage,
  TuiToolEvent,
} from "./types"

// ── selectVisibleMessages ──

export interface VisibleMessagesResult {
  /** 全部消息（组件负责行级渲染和 viewport 切片）。
   *  selector 不做消息级切片，因为行数取决于终端宽度（selector 无此参数）。
   *  组件用 maxOffset / normalizedOffset / hiddenAbove / hiddenBelow 渲染滚动指示器。 */
  messages: TuiMessage[]
  /** 最大滚动偏移量（总行数 - viewport 高度，最小 0）。 */
  maxOffset: number
  /** 归一化后的滚动偏移量（clamp 到 [0, maxOffset]）。 */
  normalizedOffset: number
  /** 上方是否有被隐藏的内容。 */
  hiddenAbove: boolean
  /** 下方是否有被隐藏的内容。 */
  hiddenBelow: boolean
}

/** 估算一条消息在转录区占用的行数（不含宽度换行，仅按 \n 分割）。
 *  组件渲染时会用 formatDisplayText 做宽度换行，实际行数可能更多。
 *  此估算用于 scroll 元数据计算，足够精确。 */
function estimateMessageLines(message: TuiMessage): number {
  if (!message.text) return 1
  const lines = message.text.split("\n").length
  return Math.max(1, lines)
}

/** 选择转录区可见消息 + scroll 元数据。
 *
 *  scrollOffset 语义（与 main.tsx 一致）：
 *    0 = 跟随最新内容（auto-follow），显示底部
 *    >0 = 向上滚动 scrollOffset 行
 *
 *  height = viewport 高度（行数） */
export function selectVisibleMessages(
  state: TuiState,
  opts: { height: number; scrollOffset: number },
): VisibleMessagesResult {
  const { height, scrollOffset } = opts
  const messages = state.messages

  // 估算总行数
  let totalLines = 0
  for (const m of messages) {
    totalLines += estimateMessageLines(m)
  }

  const maxOffset = Math.max(0, totalLines - height)
  const normalizedOffset = Math.max(0, Math.min(scrollOffset, maxOffset))

  return {
    messages,
    maxOffset,
    normalizedOffset,
    hiddenAbove: normalizedOffset > 0,
    hiddenBelow: normalizedOffset < maxOffset,
  }
}

// ── selectRecentTools ──

/** 选择最近 N 个工具事件（按时间正序，最新在末尾）。
 *  组件可用 .reverse() 获取最新在前的顺序。 */
export function selectRecentTools(state: TuiState, limit: number): TuiToolEvent[] {
  if (limit <= 0) return []
  return state.tools.slice(-limit)
}

// ── selectEvidenceSummary ──

export interface EvidenceSummary {
  total: number
  passed: number
  failed: number
  skipped: number
}

/** 统计证据结果：按 status 分类计数。 */
export function selectEvidenceSummary(state: TuiState): EvidenceSummary {
  let passed = 0
  let failed = 0
  let skipped = 0
  for (const e of state.evidence) {
    if (e.status === "passed") passed++
    else if (e.status === "failed") failed++
    else skipped++
  }
  return { total: state.evidence.length, passed, failed, skipped }
}

// ── selectGateSummary ──

export interface GateSummary {
  total: number
  pass: number
  block: number
  skip: number
}

/** 统计门禁结果：按 status 分类计数。 */
export function selectGateSummary(state: TuiState): GateSummary {
  let pass = 0
  let block = 0
  let skip = 0
  for (const g of state.gates) {
    if (g.status === "pass") pass++
    else if (g.status === "block") block++
    else skip++
  }
  return { total: state.gates.length, pass, block, skip }
}

// ── selectHeaderStatus ──

export interface HeaderStatus {
  /** 状态行文本（如 "working"、"ctx 50% / cache 80% / r3"、"clarification needed"）。 */
  status: string
  /** 当前模型显示名。 */
  modelName: string
  /** 内联错误字符串（空字符串表示无错误）。 */
  error: string
  /** agent loop 是否空闲。 */
  done: boolean
  /** 排队的用户消息数。 */
  queueCount: number
}

/** 选择头部状态行数据。 */
export function selectHeaderStatus(state: TuiState): HeaderStatus {
  return {
    status: state.status,
    modelName: state.modelName,
    error: state.errorLine,
    done: state.done,
    queueCount: state.queueCount,
  }
}

// ── selectRightRail ──

/** Dashboard（右侧栏）数据。结构与 DashProps 兼容（结构性类型）。
 *  独立定义以避免 selectors.ts 依赖 dashboard.tsx（.tsx 文件）。 */
export interface RightRailData {
  round: number
  contextTokens: number
  contextMax: number
  cacheHitRate: number
  cacheHits: number[]
  rippleFindings: TuiRippleFinding[]
  toolHistory: TuiDashToolHistoryEntry[]
  taskProgress: { done: number; total: number; current: string }
  thinkingChain?: string
}

interface TaskProgressLike {
  phase?: string
  done?: number
  total?: number
  current?: string
}

function asTaskProgressLike(value: unknown): TaskProgressLike | null {
  if (!value || typeof value !== "object") return null
  return value as TaskProgressLike
}

/** 选择 Dashboard（右侧栏）数据。
 *
 *  taskProgress 派生逻辑（镜像 main.tsx task_progress handler）：
 *    - planning 阶段：{ done: 0, total: 0, current: "" }（Dashboard 不显示）
 *    - 其他阶段：{ done, total, current }（从 state.task 读取）
 *    - 无 task：全零空字符串 */
export function selectRightRail(state: TuiState): RightRailData {
  const task = asTaskProgressLike(state.task)
  const taskProgress = task && task.phase !== "planning"
    ? {
        done: task.done ?? 0,
        total: task.total ?? 0,
        current: task.current ?? "",
      }
    : { done: 0, total: 0, current: "" }

  return {
    round: state.round,
    contextTokens: state.tokens.inputTokens,
    contextMax: state.tokens.contextMax,
    cacheHitRate: state.tokens.cacheHitRate ?? 0,
    cacheHits: state.cacheHitHistory,
    rippleFindings: state.rippleFindings,
    toolHistory: state.dashToolHistory,
    taskProgress,
    thinkingChain: undefined,
  }
}
