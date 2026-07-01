/** StatusBar — 状态摘要行，位于 HeaderBar 和 Scrollback 之间。
 *  显示：消息计数 / 滚动位置 / Task 进度 / Gate 状态 / Evidence 摘要 */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"

export interface StatusBarProps {
  messagesCount: number
  scrollOffset: number
  scrollMax: number
  taskDone: number
  taskTotal: number
  taskPhase: string
  taskGoal?: string
  gatePass: number
  gateBlock: number
  gateSkip: number
  evidencePassed: number
  evidenceFailed: number
  evidenceRunning: number
}

export const StatusBar = React.memo(function StatusBar(props: StatusBarProps) {
  const parts: Array<{ text: string; color: string }> = []

  // 消息计数 + 滚动
  if (props.messagesCount > 0) {
    parts.push({ text: `history ${props.messagesCount} messages`, color: C.dim })
    if (props.scrollMax > 0) {
      parts.push({ text: `scroll ${props.scrollOffset}/${props.scrollMax}`, color: C.dim })
    }
  }

  // Task 进度
  if (props.taskTotal > 0) {
    parts.push({
      text: `Task: ${props.taskDone}/${props.taskTotal} ${props.taskPhase}`,
      color: props.taskPhase === "complete" ? C.green : C.blue,
    })
  }

  // Gate 状态
  if (props.gatePass + props.gateBlock + props.gateSkip > 0) {
    const gateText = props.gateBlock > 0
      ? `Gate: ${props.gateBlock} block`
      : props.gatePass > 0
        ? `Gate: pass`
        : `Gate: pending`
    parts.push({ text: gateText, color: props.gateBlock > 0 ? C.red : props.gatePass > 0 ? C.green : C.yellow })
  }

  // Evidence 摘要
  if (props.evidencePassed + props.evidenceFailed + props.evidenceRunning > 0) {
    const parts_list: string[] = []
    if (props.evidencePassed > 0) parts_list.push(`${props.evidencePassed} passed`)
    if (props.evidenceFailed > 0) parts_list.push(`${props.evidenceFailed} failed`)
    if (props.evidenceRunning > 0) parts_list.push(`${props.evidenceRunning} running`)
    parts.push({
      text: `Evidence: ${parts_list.join(", ")}`,
      color: props.evidenceFailed > 0 ? C.red : C.green,
    })
  }

  if (parts.length === 0) return null

  return (
    <Box flexDirection="row">
      {parts.map((part, index) => (
        <React.Fragment key={index}>
          {index > 0 && <Text color={C.dim}> / </Text>}
          <Text color={part.color}>{part.text}</Text>
        </React.Fragment>
      ))}
    </Box>
  )
})
