/** Scrollback — 消息视口渲染（Phase 4 性能优化）。
 *
 *  设计要点：
 *    - 拆分两层 useMemo：
 *      1. allLines（重）：messages/width/status 变化时全量重算，不含 tick
 *      2. animatedLines（轻）：仅处理视口内 pending 行，O(height) 代价
 *    - tick 不再触发 O(messages) flatMap 重算
 *    - pending 消息通过 RenderedLine.pendingAnim 标记叠加动画
 *    - 保留 hiddenAbove/hiddenBelow 指示器 + row cap
 */

import React, { useEffect, useMemo } from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import type { TuiMessage } from "../state/types"
import { renderMessageLines, type RenderedLine } from "./MessageItem"

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
  tick: number
  status: string
  scrollOffset: number
  onScrollState?: (state: ScrollbackScrollState) => void
}

// ── 动画 ──

const SPINNER_CHARS = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
const SPINNER_VERBS = ["thinking", "routing", "reading", "checking"]

/** Phase 4: 叠加 pending 动画到静态行。O(N) 但 N = 视口高度（通常 < 50）。
 *  导出供测试。 */
export function applyPendingAnimation(lines: RenderedLine[], tick: number): RenderedLine[] {
  let hasPending = false
  for (const line of lines) {
    if (line.pendingAnim) { hasPending = true; break }
  }
  if (!hasPending) return lines

  const spinner = SPINNER_CHARS[tick % 10] ?? "?"
  const verb = SPINNER_VERBS[tick % 4] ?? "working"
  const tail = ["", ".", "..", "..."][tick % 4] ?? ""

  return lines.map(line => {
    if (!line.pendingAnim) return line
    if (line.pendingAnim === "spinner") {
      return {
        ...line,
        text: `${spinner} ${verb}${line.pendingStatus ? ` · ${line.pendingStatus}` : ""}`,
      }
    }
    // tail animation: append "...", "..", ".", "" to last line of streaming text
    return { ...line, text: line.text + tail }
  })
}

export const Scrollback = React.memo(function Scrollback({
  messages,
  width,
  height,
  tick,
  status,
  scrollOffset,
  onScrollState,
}: ScrollbackProps) {
  // Phase 4: 是否真的有 pending 消息需要动画（避免无效 tick 重算）
  const hasPending = messages.some(m => m.pending)

  // ── Layer 1（重）: 全量行计算，不含 tick ──
  const allLines = useMemo(() => {
    const next = messages.flatMap(message => [
      ...renderMessageLines(message, width, status),
      { marker: " " as const, text: "", color: C.dim },
    ])
    if (next.length > 0 && next[next.length - 1]?.text === "") next.pop()
    return next
  }, [messages, width, status])

  // ── 视口裁剪 ──
  const maxOffset = Math.max(0, allLines.length - height)
  const normalizedOffset = Math.min(scrollOffset, maxOffset)
  const start = Math.max(0, allLines.length - height - normalizedOffset)
  const visibleStatic = allLines.slice(start, start + height)
  const hiddenAbove = start > 0
  const hiddenBelow = start + height < allLines.length

  // ── Layer 2（轻）: pending 动画叠加，仅处理视口内行 ──
  const animatedTick = hasPending ? tick : 0
  const visibleLines = useMemo(
    () => applyPendingAnimation(visibleStatic, animatedTick),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleStatic, animatedTick],
  )

  useEffect(() => {
    onScrollState?.({ maxOffset, normalizedOffset, hiddenAbove, hiddenBelow })
  }, [hiddenAbove, hiddenBelow, maxOffset, normalizedOffset, onScrollState])

  if (messages.length === 0) return null

  return (
    <Box flexDirection="column">
      {hiddenAbove && <Text color={C.dim}>  ↑ earlier messages (scroll wheel / Up / PageUp)</Text>}
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
      {hiddenBelow && <Text color={C.dim}>  ↓ newer messages (scroll wheel / Down / PageDown)</Text>}
    </Box>
  )
})
