/** ToolCard — 渲染单个工具执行卡片。
 *  显示：状态图标 + 工具名 + 状态文本 + 耗时 + risk + 输出摘要 */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import type { TuiToolEvent } from "../state/types"

export interface ToolCardProps {
  tool: TuiToolEvent
  width: number
}

export function toolStatusIcon(status: TuiToolEvent["status"]): string {
  switch (status) {
    case "running": return "●"
    case "passed": return "●"
    case "failed": return "✕"
    case "orphan": return "?"
  }
}

export function toolStatusColor(status: TuiToolEvent["status"]): string {
  switch (status) {
    case "running": return C.cyan
    case "passed": return C.green
    case "failed": return C.red
    case "orphan": return C.yellow
  }
}

export function toolStatusLabel(status: TuiToolEvent["status"]): string {
  switch (status) {
    case "running": return "running"
    case "passed": return "passed"
    case "failed": return "failed"
    case "orphan": return "orphan"
  }
}

export function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return ""
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export const ToolCard = React.memo(function ToolCard({ tool, width }: ToolCardProps) {
  const color = toolStatusColor(tool.status)
  const icon = toolStatusIcon(tool.status)
  const label = toolStatusLabel(tool.status)
  const duration = formatDuration(tool.durationMs)
  const risk = tool.risk !== undefined ? `  risk:${tool.risk}` : ""

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={color}>{icon} </Text>
        <Text color={C.white}>{tool.tool}</Text>
        <Text color={color}> {label}</Text>
        {duration && <Text color={C.dim}>  {duration}</Text>}
        <Text color={C.dim}>{risk}</Text>
      </Box>
      {tool.summary && (
        <Text color={C.dim}>  {tool.summary}</Text>
      )}
      {tool.outputSummary && (
        <Text color={C.dim}>  {tool.outputSummary}</Text>
      )}
    </Box>
  )
})
