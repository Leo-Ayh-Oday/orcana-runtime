/** derive-blocks — TuiState → TranscriptBlock[]（Depthline P4）。
 *
 *  结构化输入（评审修正 #3）：只依赖消息角色/kind 与 state 结构，
 *  禁止解析 message.text 自然语言。
 *
 *  归组规则：
 *    - 相邻 tool 事件 → ToolGroupBlock（同一 turn，中间无 user/assistant 边界）
 *    - 相邻 gate/evidence/patch 事件 → ExecutionSummaryBlock
 *    - 相邻 task 进度事件 → TaskBlock
 *    - plan 事件 → PlanBlock
 *    - 其余 event → SystemBlock
 *
 *  生命周期：
 *    - assistant pending → running；error → error
 *    - 最后一个工具组且 state 有 running 工具 → running
 *    - task 事件且 state.task 未完成 → running
 *
 *  默认显示模式：running → truncated；completed → collapsed；error → expanded
 */

import type { TuiState, TuiMessage } from "../state/types"
import type { TranscriptBlock, BlockLifecycle, BlockDisplayMode } from "./block-model"

// ── 稳定 ID ──

let idCounter = 0

function nextId(prefix: string): string {
  // 以消息 id 为基础的稳定 id；组块用首条消息 id 派生。
  // 计数器仅在消息 id 不可用时兜底（测试构造场景）。
  return `${prefix}-${++idCounter}`
}

/** 消息 → 稳定 block id。消息 id 已稳定（msg-N 单调），直接复用。 */
function blockIdForMessage(msg: TuiMessage): string {
  return `b-${msg.id}`
}

/** 组块 id：首条消息 id + 组类型。 */
function groupIdFor(msg: TuiMessage, kind: string): string {
  return `g-${msg.id}-${kind}`
}

// ── turn 派生 ──

/** 统计到当前消息为止的 user 消息数 → turnId。 */
function turnIdFor(messages: readonly TuiMessage[], index: number): string {
  let turn = 0
  for (let i = 0; i <= index; i++) {
    if (messages[i]!.role === "user") turn++
  }
  return `turn-${turn}`
}

// ── 生命周期 ──

function assistantLifecycle(msg: TuiMessage): BlockLifecycle {
  if (msg.error) return "error"
  if (msg.pending) return "running"
  return "done"
}

function defaultModeFor(lifecycle: BlockLifecycle): BlockDisplayMode {
  switch (lifecycle) {
    case "running": return "truncated"
    case "error": return "expanded"
    default: return "collapsed"
  }
}

// ── 消息文本 → 行 ──

function messageLines(msg: TuiMessage): string[] {
  const text = msg.text.trim()
  if (!text) return []
  return text.split(/\r?\n/)
}

// ── 派生主函数 ──

export interface DeriveResult {
  blocks: TranscriptBlock[]
  /** 文本摘要（跨消息拼接，供缓存键使用）。 */
  textSignature: string
}

function signatureOf(lines: string[]): string {
  return lines.join("\n")
}

function hashText(text: string): string {
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/** 从 TuiState 派生转录块。只读、无副作用、无文本解析。 */
export function deriveTranscriptBlocks(state: TuiState): TranscriptBlock[] {
  const messages = state.messages
  const blocks: TranscriptBlock[] = []
  const hasRunningTools = state.tools.some(t => t.status === "running")
  const taskActive = (state.task as { phase?: string } | undefined)?.phase === "planning"
    || (state.task as { phase?: string } | undefined)?.phase === "building"

  // 最后一个 tool 组的下标（用于 running 判定）
  let lastToolGroupIndex = -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]!.kind === "tool-group") {
      lastToolGroupIndex = i
      break
    }
  }

  let i = 0
  while (i < messages.length) {
    const msg = messages[i]!
    const turnId = turnIdFor(messages, i)

    if (msg.role === "user") {
      blocks.push({
        id: blockIdForMessage(msg),
        kind: "user",
        lifecycle: "done",
        turnId,
        selectable: false,
        defaultMode: "expanded",
        summary: messageLines(msg),
        details: [],
      })
      i++
      continue
    }

    if (msg.role === "assistant") {
      const lifecycle = assistantLifecycle(msg)
      blocks.push({
        id: blockIdForMessage(msg),
        kind: "assistant",
        lifecycle,
        turnId,
        selectable: false,
        defaultMode: lifecycle === "done" ? "expanded" : "truncated",
        summary: messageLines(msg),
        details: [],
      })
      i++
      continue
    }

    // ── event 消息：按 kind 归组 ──
    const kind = msg.kind

    if (kind === "tool") {
      // 收集相邻 tool 事件
      const group: TuiMessage[] = []
      while (i < messages.length && messages[i]!.role === "event" && messages[i]!.kind === "tool") {
        group.push(messages[i]!)
        i++
      }
      const isLast = i >= messages.length
      const lifecycle: BlockLifecycle = isLast && hasRunningTools ? "running" : "done"
      const summary = [`${group.length} tool call${group.length > 1 ? "s" : ""}`]
      const details: string[] = []
      for (const m of group) {
        details.push(...messageLines(m))
      }
      blocks.push({
        id: groupIdFor(group[0]!, "tools"),
        kind: "tool-group",
        lifecycle,
        turnId,
        selectable: true,
        defaultMode: defaultModeFor(lifecycle),
        summary,
        details,
      })
      continue
    }

    if (kind === "plan") {
      const lifecycle: BlockLifecycle = taskActive ? "running" : "done"
      const lines = messageLines(msg)
      blocks.push({
        id: blockIdForMessage(msg),
        kind: "plan",
        lifecycle,
        turnId,
        selectable: true,
        defaultMode: defaultModeFor(lifecycle),
        summary: lines.slice(0, 1),
        details: lines.slice(1),
      })
      i++
      continue
    }

    if (kind === "task") {
      const group: TuiMessage[] = []
      while (i < messages.length && messages[i]!.role === "event" && messages[i]!.kind === "task") {
        group.push(messages[i]!)
        i++
      }
      const lifecycle: BlockLifecycle = taskActive ? "running" : "done"
      const details: string[] = []
      for (const m of group) {
        details.push(...messageLines(m))
      }
      blocks.push({
        id: groupIdFor(group[0]!, "task"),
        kind: "task",
        lifecycle,
        turnId,
        selectable: false,
        defaultMode: defaultModeFor(lifecycle),
        summary: details.slice(-1),
        details,
      })
      continue
    }

    // activity / error / 其他
    const lifecycle: BlockLifecycle = kind === "error" || msg.error ? "error" : "done"
    blocks.push({
      id: blockIdForMessage(msg),
      kind: "system",
      lifecycle,
      turnId,
      selectable: false,
      defaultMode: lifecycle === "error" ? "expanded" : "collapsed",
      summary: messageLines(msg),
      details: [],
    })
    i++
  }

  // ── 尾部 ExecutionSummaryBlock：来自 state.gates / state.evidence / state.patches（结构化数组） ──
  if (state.gates.length > 0 || state.evidence.length > 0 || state.patches.length > 0) {
    const parts: string[] = []
    if (state.gates.length > 0) parts.push(`${state.gates.length} gate${state.gates.length > 1 ? "s" : ""}`)
    if (state.evidence.length > 0) parts.push(`${state.evidence.length} evidence`)
    if (state.patches.length > 0) parts.push(`${state.patches.length} patch${state.patches.length > 1 ? "es" : ""}`)
    const details: string[] = []
    for (const g of state.gates) {
      details.push(`gate ${g.gate}: ${g.status}${g.reason ? ` - ${g.reason}` : ""}`)
    }
    for (const e of state.evidence) {
      details.push(`evidence ${e.kind}: ${e.status} - ${e.summary}`)
    }
    for (const p of state.patches) {
      details.push(`patch ${p.txId}: ${p.status} - ${p.files.join(", ")}`)
    }
    blocks.push({
      id: `g-session-summary-${state.round}`,
      kind: "execution-summary",
      lifecycle: "done",
      turnId: undefined,
      selectable: true,
      defaultMode: "collapsed",
      summary: [parts.join(" · ")],
      details,
    })
  }

  // 修正 lastToolGroupIndex（重建扫描）
  for (let idx = blocks.length - 1; idx >= 0; idx--) {
    if (blocks[idx]!.kind === "tool-group") {
      lastToolGroupIndex = idx
      break
    }
  }

  // running 工具组只允许最后一个；其余强制 done
  if (lastToolGroupIndex >= 0) {
    for (let idx = 0; idx < blocks.length; idx++) {
      const b = blocks[idx]!
      if (b.kind === "tool-group" && idx !== lastToolGroupIndex && b.lifecycle === "running") {
        blocks[idx] = { ...b, lifecycle: "done", defaultMode: defaultModeFor("done") }
      }
    }
  }

  return blocks
}

/** 文本签名（缓存键用）：全部 summary+details 拼接。 */
export function transcriptTextSignature(blocks: readonly TranscriptBlock[]): string {
  let acc = ""
  for (const b of blocks) {
    acc += b.id + signatureOf(b.summary) + signatureOf(b.details)
  }
  return hashText(acc)
}

// 兼容导出：nextId 兜底
export { nextId }
