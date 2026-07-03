/** Scrollback — 消息视口渲染（Phase 6 性能升级）。
 *
 *  Phase 6 变更:
 *    - FormattedLineCache: 按 msgId+textLen+width 缓存渲染行，流式输出时只重算最后一条消息
 *    - Viewport row cap: 5000 行硬上限，超出行从顶部裁剪
 *    - Resize cache invalidation: width 变化时清空缓存
 *
 *  Phase 5 变更:
 *    - tick 从 ClockContext 消费（useClock），不再 prop drill
 *    - reduced-motion 时 tail dots 始终为空
 *    - stalled detection：3s 无 token/工具 → activity 变为 "stalled"
 *    - 每类 activity 使用独立 glyph 序列 */

import React, { useEffect, useMemo, useRef } from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import type { TuiMessage } from "../state/types"
import { renderMessageLines, type RenderedLine } from "./MessageItem"
import { classifyPendingActivity, defaultActivity, formatPendingLine, isStalled } from "../pending-activity"
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
  round: number
  scrollOffset: number
  onScrollState?: (state: ScrollbackScrollState) => void
  /** Phase 5: 是否有活跃工具。防止 stalled 在长 shell 命令执行时误报。 */
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

    const lines = [
      ...renderMessageLines(msg, width, status),
      { marker: " " as const, text: "", color: C.dim },
    ]
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

// ── 动画 (Phase 5: per-activity glyphs, reduced-motion, stalled detection) ──

/** Phase 5: 叠加 pending 动画到静态行。O(N) 但 N = 视口高度。
 *  使用 per-activity glyph 序列，reducedMotion 时静态。
 *  hasActiveTools: 防止 stalled 检测在长工具执行期间误报。 */
export function applyPendingAnimation(
  lines: RenderedLine[],
  tick: number,
  status: string,
  round: number,
  reducedMotion: boolean,
  hasActiveTools: boolean,
): RenderedLine[] {
  let hasPending = false
  for (const line of lines) {
    if (line.pendingAnim) { hasPending = true; break }
  }
  if (!hasPending) return lines

  let activity = status ? classifyPendingActivity(status) : defaultActivity()
  // Phase 5: stalled detection — only when no token AND no active tool
  // (active tool check prevents false stall during long-running shell commands)
  if (isStalled() && !hasActiveTools) {
    activity = "stalled"
  }
  // reducedMotion: freeze tick to 0 → all glyphs return first (static) character
  const effectiveTick = reducedMotion ? 0 : tick
  const pendingText = formatPendingLine(activity, effectiveTick, round)

  return lines.map(line => {
    if (!line.pendingAnim) return line
    if (line.pendingAnim === "spinner") {
      return { ...line, text: pendingText }
    }
    // tail animation: append "...", "..", ".", "" to last streaming line
    // reducedMotion: always empty
    if (reducedMotion) return { ...line, text: line.text }
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
  round,
  scrollOffset,
  onScrollState,
  hasActiveTools = false,
}: ScrollbackProps) {
  const { tick, reducedMotion } = useClock()
  const hasPending = messages.some(m => m.pending)
  const cacheRef = useRef<FormattedLineCache>(new FormattedLineCache())

  // ── Layer 1（重 → 轻）: 增量格式化行计算（Phase 6 cache）──
  const { allLines, capped } = useMemo(() => {
    return cacheRef.current.buildAllLines(messages, width, status)
  }, [messages, width, status])

  // ── 视口裁剪 ──
  const maxOffset = Math.max(0, allLines.length - height)
  const normalizedOffset = Math.min(scrollOffset, maxOffset)
  const start = Math.max(0, allLines.length - height - normalizedOffset)
  const visibleStatic = allLines.slice(start, start + height)
  const hiddenAbove = capped || start > 0
  const hiddenBelow = start + height < allLines.length

  // ── Layer 2（轻）: pending 动画叠加 ──
  const animatedTick = hasPending ? tick : 0
  const visibleLines = useMemo(
    () => applyPendingAnimation(visibleStatic, animatedTick, status, round, reducedMotion, hasActiveTools),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleStatic, animatedTick, status, round, reducedMotion, hasActiveTools],
  )

  useEffect(() => {
    onScrollState?.({ maxOffset, normalizedOffset, hiddenAbove, hiddenBelow })
  }, [hiddenAbove, hiddenBelow, maxOffset, normalizedOffset, onScrollState])

  if (messages.length === 0) return null

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
      {hiddenBelow && <Text color={C.dim}>  ↓ newer</Text>}
    </Box>
  )
})
