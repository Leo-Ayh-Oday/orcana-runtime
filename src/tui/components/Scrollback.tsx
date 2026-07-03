/** Scrollback — 消息视口渲染（Phase 6 性能升级 + PR-1.5 拆双轨）。
 *
 *  Phase 6 变更:
 *    - FormattedLineCache: 按 msgId+textLen+width 缓存渲染行，流式输出时只重算最后一条消息
 *    - Viewport row cap: 5000 行硬上限，超出行从顶部裁剪
 *    - Resize cache invalidation: width 变化时清空缓存
 *
 *  PR-1.5 变更:
 *    - 废除 pending spinner 分支：空 pending message 不再渲染占位行
 *    - 运行态信号（Composing/Reading/Running）由 ThinkingDock 单一职责接管
 *    - 保留 tail 光标动画（流式输出的"正在打字"内容信号）
 *    - stalled 检测从 Scrollback 移除，isStalled() 保留供 ThinkingDock 未来使用 */

import React, { useEffect, useMemo, useRef } from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import type { TuiMessage } from "../state/types"
import { renderMessageLines, type RenderedLine } from "./MessageItem"
import { StreamingBlock } from "./StreamingBlock"
import { useClock } from "../clock"

export interface ScrollbackScrollState {
  maxOffset: number
  normalizedOffset: number
  hiddenAbove: boolean
  hiddenBelow: boolean
}

export interface ScrollbackProps {
  messages: TuiMessage[]
  width: number
  height: number
  status: string
  /** PR-1.5: round 保留为向后兼容字段，Scrollback 内部不再使用。
   *  运行态信号由 ThinkingDock 单一职责接管。 */
  round?: number
  scrollOffset: number
  onScrollState?: (state: ScrollbackScrollState) => void
  /** PR-1.5: hasActiveTools 保留为向后兼容字段，Scrollback 内部不再使用。
   *  stalled 检测已移至 ThinkingDock 域。 */
  hasActiveTools?: boolean
}

// ── Phase 6: 格式化行缓存 ──

/** 视口行硬上限。超过此值的消息行从顶部裁剪，防止超长会话 OOM。 */
const MAX_VIEWPORT_LINES = 5_000

function hashText(text: string): string {
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/** 缓存键: message render inputs + width。text 同长度替换、pending 翻转、resize 都会失效。 */
export function formatLineCacheKey(msg: TuiMessage, width: number): string {
  const kind = msg.role === "event" ? msg.kind ?? "" : ""
  const error = msg.role === "assistant" && msg.error ? "error" : "ok"
  const pending = msg.pending ? "pending" : "final"
  return `${msg.id}:${msg.role}:${kind}:${error}:${pending}:${msg.text.length}:${hashText(msg.text)}:${width}`
}

/** 缓存条目。 */
export interface CachedLinesEntry {
  lines: RenderedLine[]
}

/**
 * Phase 6: 增量格式化行缓存。
 *
 * 只在消息 text 长度变化或 width 变化时重新调用 renderMessageLines。
 * 流式输出场景（最后一条消息持续增长）：O(1) 重算 → 显著降低 CPU。
 */
export class FormattedLineCache {
  private cache = new Map<string, CachedLinesEntry>()
  private prevWidth = 0

  /** 获取或计算一条消息的渲染行。cache hit → 零开销。 */
  getOrCompute(msg: TuiMessage, width: number, status: string): RenderedLine[] {
    // Phase 6: resize → 清空缓存（行宽依赖 width，旧缓存无效）
    if (this.prevWidth !== 0 && this.prevWidth !== width) {
      this.cache.clear()
    }
    this.prevWidth = width

    const key = formatLineCacheKey(msg, width)
    const hit = this.cache.get(key)
    if (hit) return hit.lines

    const rendered = renderMessageLines(msg, width, status)
    // PR-1.5: 空 pending message 返回 [] — 不追加 spacer，避免渲染空占位行
    const lines = rendered.length > 0
      ? [...rendered, { marker: " " as const, text: "", color: C.dim }]
      : rendered
    this.cache.set(key, { lines })
    return lines
  }

  /** 构建全量行数组，仅在消息变更时重算变更部分。
   *  返回 { allLines, capped }: allLines 可能超过 MAX_VIEWPORT_LINES，此时 capped=true。 */
  buildAllLines(messages: TuiMessage[], width: number, status: string): { allLines: RenderedLine[]; capped: boolean } {
    const result: RenderedLine[] = []
    for (const msg of messages) {
      result.push(...this.getOrCompute(msg, width, status))
    }

    // Trim trailing empty spacer line
    if (result.length > 0 && result[result.length - 1]?.text === "") {
      result.pop()
    }

    // Phase 6: viewport row cap — 超过上限从顶部裁剪
    const capped = result.length > MAX_VIEWPORT_LINES
    if (capped) {
      const trimmed = result.length - MAX_VIEWPORT_LINES
      result.splice(0, trimmed)
    }

    // Evict stale cache entries (messages removed from the list)
    this.evictStale(messages)

    return { allLines: result, capped }
  }

  /** 清理缓存中已不存在于消息列表的条目。 */
  private evictStale(messages: TuiMessage[]): void {
    const liveIds = new Set(messages.map(m => m.id))
    for (const key of this.cache.keys()) {
      const msgId = key.split(":")[0]!
      if (!liveIds.has(msgId)) this.cache.delete(key)
    }
  }

  /** 清空缓存（/clear 命令等）。 */
  clear(): void {
    this.cache.clear()
  }

  /** 调试：缓存统计 */
  stats(): { size: number; width: number } {
    return { size: this.cache.size, width: this.prevWidth }
  }
}

// ── 动画 (PR-1.5: 仅保留 tail 光标动画) ──

/** PR-1.5: 叠加 pending 动画到静态行。O(N) 但 N = 视口高度。
 *
 *  原 Phase 5 的 spinner 分支已废除：空 pending message 不再渲染占位行，
 *  运行态信号（Composing/Reading/Running 等）由 ThinkingDock 单一职责接管。
 *  保留 tail 分支：流式输出尾行 "..." 光标动画，是"正在打字"的内容信号，
 *  与 ThinkingDock 的状态标签不同维度。
 *
 *  stalled 检测逻辑移除：applyPendingAnimation 不再需要判断 stalled，
 *  isStalled() 函数保留在 pending-activity.ts 供 ThinkingDock 未来使用。 */
export function applyPendingAnimation(
  lines: RenderedLine[],
  tick: number,
  reducedMotion: boolean,
): RenderedLine[] {
  let hasPending = false
  for (const line of lines) {
    if (line.pendingAnim) { hasPending = true; break }
  }
  if (!hasPending) return lines

  // reducedMotion: 不追加 tail dots，保持文本静态
  if (reducedMotion) return lines

  return lines.map(line => {
    if (line.pendingAnim !== "tail") return line
    const tail = ["", ".", "..", "..."][tick % 4] ?? ""
    return { ...line, text: line.text + tail }
  })
}

// ── 主组件 ──

export const Scrollback = React.memo(function Scrollback({
  messages,
  width,
  height,
  status,
  scrollOffset,
  onScrollState,
}: ScrollbackProps) {
  const { tick, reducedMotion } = useClock()
  const cacheRef = useRef<FormattedLineCache>(new FormattedLineCache())

  // PR-6: 拆分 committed 与 pending — pending 走 StreamingBlock 兄弟节点，
  // delta 仅触发 StreamingBlock 重渲染，不触碰历史列表 reconciliation
  const { committedMessages, pendingMessage } = useMemo(() => {
    // 找到最后一个 pending message（流式输出中），其余为 committed
    let pending: TuiMessage | null = null
    const committed: TuiMessage[] = []
    for (const m of messages) {
      if (m.pending && pending === null) {
        pending = m
      } else {
        committed.push(m)
      }
    }
    return { committedMessages: committed, pendingMessage: pending }
  }, [messages])

  // ── Layer 1（重 → 轻）: 增量格式化行计算（Phase 6 cache，仅 committed）──
  const { allLines, capped } = useMemo(() => {
    return cacheRef.current.buildAllLines(committedMessages, width, status)
  }, [committedMessages, width, status])

  // PR-6: pending message 通过 StreamingBlock 渲染（stable-prefix 锁定）
  // StreamingBlock 内部管理 stable/unstable 分割 + tail 动画
  const streamingText = pendingMessage?.text ?? ""
  const streamingLines = useMemo(() => {
    if (!pendingMessage || streamingText.length === 0) return null
    // 返回 StreamingBlock 的"虚拟行"用于视口裁剪计算
    // 实际渲染由 StreamingBlock 组件完成
    return streamingText
  }, [pendingMessage, streamingText])

  // ── 视口裁剪 ──
  // 视口行数估算：streamingLines 按 \n 数 + 1 估算（粗略，实际渲染由 StreamingBlock 控制）
  const streamingLineEstimate = streamingLines
    ? Math.max(1, streamingLines.split("\n").length)
    : 0
  const totalLines = allLines.length + streamingLineEstimate
  const maxOffset = Math.max(0, totalLines - height)
  const normalizedOffset = Math.min(scrollOffset, maxOffset)
  const start = Math.max(0, totalLines - height - normalizedOffset)
  const visibleStatic = allLines.slice(start, start + height)
  const hiddenAbove = capped || start > 0
  const hiddenBelow = start + height < totalLines

  // ── Layer 2（轻）: pending 动画叠加 ──
  // PR-6: committed 行不再有 pendingAnim（pending 已移出数组），applyPendingAnimation 退化为 no-op
  const visibleLines = useMemo(
    () => applyPendingAnimation(visibleStatic, tick, reducedMotion),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleStatic, tick, reducedMotion],
  )

  useEffect(() => {
    onScrollState?.({ maxOffset, normalizedOffset, hiddenAbove, hiddenBelow })
  }, [hiddenAbove, hiddenBelow, maxOffset, normalizedOffset, onScrollState])

  if (messages.length === 0) return null

  // PR-6: pending 行渲染由 StreamingBlock 负责（在视口可见时）
  // 简化策略：如果 streaming 存在，总在底部为它预留空间
  const showStreaming = streamingLines !== null

  return (
    <Box flexDirection="column">
      {hiddenAbove && <Text color={C.dim}>  ↑ earlier</Text>}
      {visibleLines.slice(
        hiddenAbove ? 1 : 0,
        hiddenBelow ? Math.max(0, visibleLines.length - 1) : visibleLines.length,
      ).map((line, index) => (
        <Box key={`${start}-${index}`} flexDirection="row">
          <Box width={3}>
            <Text color={line.color}>{line.marker}</Text>
          </Box>
          <Text color={line.color === C.red ? C.red : C.white}>{line.text}</Text>
        </Box>
      ))}
      {showStreaming && (
        <StreamingBlock
          text={streamingText}
          width={Math.max(12, width - 4)}
          pending={true}
        />
      )}
      {hiddenBelow && <Text color={C.dim}>  ↓ newer</Text>}
    </Box>
  )
})
