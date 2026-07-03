/** StreamingBlock — PR-6: 流式消息作为列表外兄弟节点。
 *
 *  职责：
 *    - 接收当前 streaming text，使用 useStablePrefix 锁定 stable 前缀
 *    - stable 部分 useMemo 缓存 format 结果（永不重 format）
 *    - unstable 部分每次 delta 重新 format
 *    - 拼接 stable + unstable 行，渲染为带 marker 的行数组
 *    - 末行带 tail 光标动画（"..." / ".." / "." / ""）
 *
 *  关键差异 vs MessageItem：
 *    - MessageItem 每次 delta 重 format 全文（O(N) on each token）
 *    - StreamingBlock 仅重 format unstable suffix（O(suffix) on each token）
 *
 *  使用方式：
 *    <StreamingBlock text={streamingText} width={width} tick={tick} />
 */

import React, { useMemo } from "react"
import { Box, Text } from "ink"
import { theme } from "../theme/theme"
import { formatDisplayText } from "../format"
import { useStablePrefix } from "../hooks/use-stable-prefix"
import { useClock } from "../clock"
import { getGlyphTheme } from "../tokens"

export interface StreamingBlockProps {
  /** 当前 streaming 文本（持续增长）。 */
  text: string
  /** 内容区宽度（不含 marker）。 */
  width: number
  /** pending 状态标记。false 时不再追加 tail 动画。 */
  pending: boolean
}

export const StreamingBlock = React.memo(function StreamingBlock({
  text,
  width,
  pending,
}: StreamingBlockProps) {
  const { tick, reducedMotion } = useClock()
  const { stable, unstable } = useStablePrefix(text)

  // stable 部分仅当 stable 字符串或 width 变化时重算
  const stableLines = useMemo(
    () => (stable.length > 0 ? formatDisplayText(stable, width) : []),
    [stable, width],
  )

  // unstable 部分每次渲染重算（O(suffix)，通常仅当前段落）
  const unstableLines = useMemo(
    () => (unstable.length > 0 ? formatDisplayText(unstable, width) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unstable, width],
  )

  const g = getGlyphTheme()
  const marker = g.markerAssistant
  const color = theme.assistantMessage

  // 拼接：stable 行全部使用 " " continuation marker；unstable 首行用 marker
  // tail 光标动画仅在 pending 且 unstable 非空时附加到最后一行
  const tailDots = pending && !reducedMotion
    ? ["", ".", "..", "..."][tick % 4] ?? ""
    : ""

  // 拼接所有行
  const allLines: Array<{ marker: string; text: string }> = []
  for (const line of stableLines) {
    allLines.push({ marker: " ", text: line })
  }
  for (let i = 0; i < unstableLines.length; i++) {
    const line = unstableLines[i]!
    const isFirstUnstable = i === 0
    // stableLines 为空时，第一行 unstable 用 assistant marker；否则 continuation
    const isFirstOverall = stableLines.length === 0 && isFirstUnstable
    const lineMarker = isFirstOverall ? marker : " "
    // 末行附加 tail 光标
    const isLastLine = i === unstableLines.length - 1
    const suffix = isLastLine ? tailDots : ""
    allLines.push({ marker: lineMarker, text: line + suffix })
  }

  if (allLines.length === 0) return null

  return (
    <>
      {allLines.map((line, index) => (
        <Box key={index} flexDirection="row">
          <Box width={3}>
            <Text color={color}>{line.marker}</Text>
          </Box>
          <Text color={theme.text}>{line.text}</Text>
        </Box>
      ))}
    </>
  )
})
