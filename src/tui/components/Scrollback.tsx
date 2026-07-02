/** Scrollback — 消息视口渲染（Visual Step 1 更新）。
 *
 *  Visual Step 1 变更：
 *    - pending 动画使用 classifyPendingActivity 替代随机动词
 *    - hiddenAbove/hiddenBelow 改为短文案
 *    - 所有动态字符来自 tuiTokens.motion */

import React, { useEffect, useMemo } from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import type { TuiMessage } from "../state/types"
import { renderMessageLines, type RenderedLine } from "./MessageItem"
import { classifyPendingActivity, defaultActivity, formatPendingLine } from "../pending-activity"
import { tuiTokens } from "../tokens"

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
  round: number
  scrollOffset: number
  onScrollState?: (state: ScrollbackScrollState) => void
}

// ── 动画 (Visual Step 1: classified pending activity) ──

/** Visual Step 1: 叠加 pending 动画到静态行。O(N) 但 N = 视口高度。
 *  使用 classifyPendingActivity 替代随机动词。 */
export function applyPendingAnimation(
  lines: RenderedLine[],
  tick: number,
  status: string,
  round: number,
): RenderedLine[] {
  let hasPending = false
  for (const line of lines) {
    if (line.pendingAnim) { hasPending = true; break }
  }
  if (!hasPending) return lines

  const activity = status ? classifyPendingActivity(status) : defaultActivity()
  const pendingText = formatPendingLine(activity, tick, round)

  return lines.map(line => {
    if (!line.pendingAnim) return line
    if (line.pendingAnim === "spinner") {
      return { ...line, text: pendingText }
    }
    // tail animation: append "...", "..", ".", "" to last streaming line
    const tail = ["", ".", "..", "..."][tick % 4] ?? ""
    return { ...line, text: line.text + tail }
  })
}

export const Scrollback = React.memo(function Scrollback({
  messages,
  width,
  height,
  tick,
  status,
  round,
  scrollOffset,
  onScrollState,
}: ScrollbackProps) {
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

  // ── Layer 2（轻）: pending 动画叠加（Visual Step 1: classified activity） ──
  const animatedTick = hasPending ? tick : 0
  const visibleLines = useMemo(
    () => applyPendingAnimation(visibleStatic, animatedTick, status, round),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleStatic, animatedTick, status, round],
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
