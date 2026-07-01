/** Scrollback — 消息视口渲染，从 main.tsx 的 ChatTranscript 提取。
 *
 *  设计要点（PR-2 性能要求）：
 *    - React.memo 化，只在 messages/width/height/tick/status/scrollOffset 变化时重渲染
 *    - 行级精确滚动（非消息级估算），保持与原有一致体验
 *    - 大消息通过 trimForViewport 截断，不进入 React tree 过多行
 *    - useMemo 缓存行数组，避免每次渲染都重新格式化
 */

import React, { useEffect, useMemo } from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import type { TuiMessage } from "../state/types"
import { renderMessageLines } from "./MessageItem"

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

export const Scrollback = React.memo(function Scrollback({
  messages,
  width,
  height,
  tick,
  status,
  scrollOffset,
  onScrollState,
}: ScrollbackProps) {
  const animatedTick = messages.some(message => message.pending) ? tick : 0

  const lines = useMemo(() => {
    const next = messages.flatMap(message => [
      ...renderMessageLines(message, width, animatedTick, status),
      { marker: " ", text: "", color: C.dim },
    ])
    if (next.length > 0 && next[next.length - 1]?.text === "") next.pop()
    return next
  }, [animatedTick, messages, status, width])

  const maxOffset = Math.max(0, lines.length - height)
  const normalizedOffset = Math.min(scrollOffset, maxOffset)
  const start = Math.max(0, lines.length - height - normalizedOffset)
  const visibleLines = lines.slice(start, start + height)
  const hiddenAbove = start > 0
  const hiddenBelow = start + height < lines.length

  useEffect(() => {
    onScrollState?.({ maxOffset, normalizedOffset, hiddenAbove, hiddenBelow })
  }, [hiddenAbove, hiddenBelow, maxOffset, normalizedOffset, onScrollState])

  if (messages.length === 0) return null

  return (
    <Box flexDirection="column">
      {hiddenAbove && <Text color={C.dim}>  ... earlier messages (Up/PageUp)</Text>}
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
      {hiddenBelow && <Text color={C.dim}>  ... newer messages (Down/PageDown)</Text>}
    </Box>
  )
})
