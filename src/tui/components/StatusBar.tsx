/** StatusBar — 状态摘要行（Phase 3 增强），位于 HeaderBar 和 Scrollback 之间。
 *
 *  显示：round / Task 进度 / Gate 状态 / Evidence 摘要 / Patch 状态 / 活跃工具
 *  窄屏时保留最关键 counters（gate block + evidence fail）。 */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"

export interface StatusBarProps {
  /** 当前 agent round */
  round: number
  /** 消息总数 */
  messagesCount: number
  scrollOffset: number
  scrollMax: number
  taskDone: number
  taskTotal: number
  taskPhase: string
  taskGoal?: string
  gatePass: number
  gateBlock: number
  gateWarn: number
  gateSkip: number
  evidencePassed: number
  evidenceFailed: number
  evidenceRunning: number
  /** 活跃工具数（状态为 "running" 的工具） */
  activeTools: number
  /** Patch 状态汇总 */
  patchProposed: number
  patchCommitted: number
  patchRolledBack: number
}

export const StatusBar = React.memo(function StatusBar(props: StatusBarProps) {
  const parts: Array<{ text: string; color: string }> = []

  // Phase 3: round always shown (when > 0)
  if (props.round > 0) {
    parts.push({ text: `r${props.round}`, color: C.cyan })
  }

  // Task 进度（Phase 3: 前置到 round 之后）
  if (props.taskTotal > 0) {
    parts.push({
      text: `task ${props.taskDone}/${props.taskTotal} ${props.taskPhase}`,
      color: props.taskPhase === "complete" ? C.green : C.blue,
    })
  }

  // Gate 状态（Phase 3: 增加 warn 计数）
  const gateTotal = props.gatePass + props.gateBlock + props.gateWarn + props.gateSkip
  if (gateTotal > 0) {
    const gateParts: string[] = []
    if (props.gatePass > 0) gateParts.push(`${props.gatePass}p`)
    if (props.gateBlock > 0) gateParts.push(`${props.gateBlock}b`)
    if (props.gateWarn > 0) gateParts.push(`${props.gateWarn}w`)
    if (props.gateSkip > 0) gateParts.push(`${props.gateSkip}s`)
    parts.push({
      text: `gates ${gateParts.join("·")}`,
      color: props.gateBlock > 0 ? C.red : props.gateWarn > 0 ? C.yellow : C.green,
    })
  }

  // Evidence 摘要
  const evidenceTotal = props.evidencePassed + props.evidenceFailed + props.evidenceRunning
  if (evidenceTotal > 0) {
    const evParts: string[] = []
    if (props.evidencePassed > 0) evParts.push(`${props.evidencePassed}p`)
    if (props.evidenceFailed > 0) evParts.push(`${props.evidenceFailed}f`)
    if (props.evidenceRunning > 0) evParts.push(`${props.evidenceRunning}r`)
    parts.push({
      text: `evidence ${evParts.join("·")}`,
      color: props.evidenceFailed > 0 ? C.red : C.green,
    })
  }

  // Phase 3: Patch 状态
  const patchTotal = props.patchProposed + props.patchCommitted + props.patchRolledBack
  if (patchTotal > 0) {
    const ptParts: string[] = []
    if (props.patchProposed > 0) ptParts.push(`${props.patchProposed} proposed`)
    if (props.patchCommitted > 0) ptParts.push(`${props.patchCommitted} committed`)
    if (props.patchRolledBack > 0) ptParts.push(`${props.patchRolledBack} rolled back`)
    parts.push({
      text: `patches ${ptParts.join("·")}`,
      color: props.patchRolledBack > 0 ? C.yellow : C.dim,
    })
  }

  // Phase 3: 活跃工具
  if (props.activeTools > 0) {
    parts.push({ text: `tools ${props.activeTools} running`, color: C.cyan })
  }

  // 消息计数 + 滚动（降级到末尾，次要信息）
  if (props.messagesCount > 0) {
    parts.push({ text: `${props.messagesCount} msgs`, color: C.dim })
    if (props.scrollMax > 0) {
      parts.push({ text: `view ${props.scrollOffset}/${props.scrollMax}`, color: C.dim })
    }
  }

  if (parts.length === 0) return null

  return (
    <Box flexDirection="row">
      {parts.map((part, index) => (
        <React.Fragment key={index}>
          {index > 0 && <Text color={C.dim}> · </Text>}
          <Text color={part.color}>{part.text}</Text>
        </React.Fragment>
      ))}
    </Box>
  )
})
