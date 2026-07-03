/** PlanPanel — 计划进度面板，从 main.tsx 的 TaskProgressStrip 提取。
 *  显示：planning 阶段的脉冲动画 / building 阶段的步骤清单
 *  外加 FlowLine 装饰组件（ClarificationPanel 也复用）。
 *
 *  Phase 5: tick 从 ClockContext 消费（useClock），不再 prop drill。 */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import { fitText } from "./MessageItem"
import { useClock } from "../clock"

export type TaskStepStatus = "pending" | "running" | "done" | "failed"

export interface TaskStep {
  id: string
  title: string
  status: TaskStepStatus
  evidence?: string
}

export interface TaskProgressState {
  goal: string
  phase: "planning" | "building" | "complete"
  done: number
  total: number
  current: string
  steps: TaskStep[]
}

/** 流线动画装饰，用于 planning 阶段和 clarification 面板。 */
export function FlowLine({ width, active }: { width: number; active: boolean }) {
  const { tick } = useClock()
  const usable = Math.max(18, Math.min(width, 72))
  const line = Array.from({ length: usable }, (_, index) => {
    if (!active) return index % 2 === 0 ? "-" : "."
    const phase = (index + tick) % 12
    if (phase === 0) return "="
    if (phase <= 2 || phase >= 10) return "~"
    if (phase <= 4 || phase >= 8) return "-"
    return "."
  }).join("")
  return <Text color={active ? C.cyan : C.border}>{line}</Text>
}

export interface PlanPanelProps {
  task: TaskProgressState | null | undefined
  width: number
}

export const PlanPanel = React.memo(function PlanPanel({ task, width }: PlanPanelProps) {
  const { tick } = useClock()
  if (!task || task.total === 0) return null

  if (task.phase === "planning") {
    const pulse = ["thinking", "checking scope", "waiting for plan", "planning gate"][tick % 4]
    return (
      <Box flexDirection="column" paddingX={1} marginBottom={1}>
        <Text color={C.cyan}>planning / <Text color={C.dim}>{pulse}</Text></Text>
        <Text color={C.dim}>{fitText(task.goal, Math.max(18, width - 4))}</Text>
        <FlowLine width={Math.max(18, width - 4)} active />
        <Text color={C.dim}>The model has not produced an accepted plan yet. Checklist will appear after planning gate passes.</Text>
      </Box>
    )
  }

  const running = task.steps.filter(step => step.status === "running").length
  const open = task.steps.filter(step => step.status === "pending").length
  const visible = task.steps.slice(0, 4)
  const extra = Math.max(0, task.steps.length - visible.length)

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Text color={C.dim}>
        {task.total} tasks ({task.done} done, {running} in progress, {open} open) <Text color={C.blue}>{task.phase}</Text>
      </Text>
      {visible.map(step => (
        <Text key={step.id} color={step.status === "done" ? C.green : step.status === "running" ? C.cyan : step.status === "failed" ? C.red : C.dim}>
          {step.status === "done" ? "[x]" : step.status === "running" ? "[>]" : step.status === "failed" ? "[!]" : "[ ]"} {fitText(step.title, Math.max(18, width - 8))}
        </Text>
      ))}
      {extra > 0 && <Text color={C.dim}>... +{extra} more</Text>}
    </Box>
  )
})
