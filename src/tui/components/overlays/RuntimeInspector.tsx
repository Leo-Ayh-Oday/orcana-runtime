/** RuntimeInspector — 运行态检查器 overlay（Depthline P2）。
 *
 *  RightRail / RuntimePanel / ModeContract 的能力迁移目标（能力不丢失）：
 *    - state / round / context / cache
 *    - gates / evidence / patches 汇总
 *    - recent tools
 *  打开：Ctrl+T 或 /runtime。覆盖层不压缩 transcript 布局，关闭后归还全部空间。
 *
 *  formatRuntimeInspectorLines 为纯函数（无 ANSI），供 golden 测试。
 */

import React from "react"
import { Box, Text } from "ink"
import { theme } from "../../theme/theme"
import type { RightRailData } from "../../state/selectors"

export interface RuntimeInspectorProps {
  data: RightRailData
  status: string
  done: boolean
  errorLine: string
  width: number
}

export interface InspectorLine {
  text: string
  color: string
  indent?: number
}

/** dashToolHistory status → glyph/color（与 ToolCard 语义对齐）。 */
function dashStatusIcon(status: string): string {
  switch (status) {
    case "done": return "✓"
    case "running": return "◉"
    case "blocked": return "!"
    case "error": return "✗"
    default: return "·"
  }
}

function dashStatusColor(status: string): string {
  switch (status) {
    case "done": return theme.success
    case "running": return theme.brand
    case "blocked": return theme.warning
    case "error": return theme.error
    default: return theme.textFaint
  }
}

/** 纯函数：Inspector 内容行（无 ANSI，供测试）。 */
export function formatRuntimeInspectorLines(data: RightRailData, status: string, done: boolean, errorLine: string): InspectorLine[] {
  const lines: InspectorLine[] = []

  // ── 运行态 ──
  const stateText = errorLine
    ? `error ${errorLine.slice(0, 40)}`
    : done
      ? "idle"
      : status || "working"
  lines.push({ text: `state     ${stateText}`, color: errorLine ? theme.error : done ? theme.textFaint : theme.brand })
  lines.push({ text: `round     ${data.round}`, color: theme.textDim })
  lines.push({ text: `context   ${data.contextTokens.toLocaleString()} / ${data.contextMax.toLocaleString()}`, color: theme.textDim })
  lines.push({ text: `cache     ${data.cacheHitRate}%`, color: data.cacheHitRate > 80 ? theme.success : theme.warning })

  // ── 门禁 / 证据 / 补丁 ──
  const g = data.runtime.gateSummary
  if (g.total > 0) {
    lines.push({ text: `gates     ${g.pass} passed · ${g.block} blocked · ${g.warn} warning`, color: g.block > 0 ? theme.error : g.warn > 0 ? theme.warning : theme.success })
  }
  const e = data.runtime.evidenceSummary
  if (e.total > 0) {
    lines.push({ text: `evidence  ${e.passed} accepted · ${e.failed} failed`, color: e.failed > 0 ? theme.error : theme.success })
  }
  const p = data.runtime.patchSummary
  if (p.total > 0) {
    lines.push({ text: `patches   ${p.committed} committed${p.proposed > 0 ? ` · ${p.proposed} proposed` : ""}${p.rolledBack > 0 ? ` · ${p.rolledBack} rolled back` : ""}`, color: theme.textDim })
  }

  // ── recent tools ──
  if (data.toolHistory.length > 0) {
    lines.push({ text: "recent tools", color: theme.textFaint })
    for (const tool of data.toolHistory.slice(-4)) {
      lines.push({ text: `${dashStatusIcon(tool.status)} ${tool.name}`, color: dashStatusColor(tool.status), indent: 2 })
    }
  }

  return lines
}

export const RuntimeInspector = React.memo(function RuntimeInspector({ data, status, done, errorLine, width }: RuntimeInspectorProps) {
  const lines = formatRuntimeInspectorLines(data, status, done, errorLine)
  const boxWidth = Math.max(42, Math.min(width - 4, 92))
  const innerWidth = boxWidth - 2

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.borderActive} paddingX={1} width={boxWidth}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={theme.brand}>runtime</Text>
        <Text color={theme.textFaint}>Esc close</Text>
      </Box>
      {lines.map((line, index) => (
        <Text key={index} color={line.color}>
          {"  ".repeat(line.indent ?? 0)}
          {line.text.length > innerWidth ? line.text.slice(0, innerWidth - 1) + "…" : line.text}
        </Text>
      ))}
    </Box>
  )
})
