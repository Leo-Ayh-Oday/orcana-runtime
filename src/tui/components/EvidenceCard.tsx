/** EvidenceCard — 渲染证据摘要卡片。
 *  显示：✓ typecheck passed / ✕ test failed / - build skipped */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import type { TuiEvidenceEvent } from "../state/types"
import type { EvidenceSummary } from "../state/selectors"

export interface EvidenceCardProps {
  /** 单条证据事件（渲染详情） */
  evidence?: TuiEvidenceEvent
  /** 证据摘要统计（渲染汇总） */
  summary?: EvidenceSummary
  width: number
}

function statusIcon(status: TuiEvidenceEvent["status"]): string {
  switch (status) {
    case "passed": return "✓"
    case "failed": return "✕"
    case "blocked": return "⚠"
    case "running": return "●"
    case "skipped": return "-"
  }
}

function statusColor(status: TuiEvidenceEvent["status"]): string {
  switch (status) {
    case "passed": return C.green
    case "failed": return C.red
    case "blocked": return C.yellow
    case "running": return C.cyan
    case "skipped": return C.dim
  }
}

/** 渲染单条证据事件。 */
export function EvidenceEntry({ evidence }: { evidence: TuiEvidenceEvent }) {
  const color = statusColor(evidence.status)
  const icon = statusIcon(evidence.status)
  return (
    <Box flexDirection="row">
      <Text color={color}>{icon} </Text>
      <Text color={C.white}>{evidence.kind}</Text>
      <Text color={color}> {evidence.status}</Text>
      {evidence.summary && <Text color={C.dim}>  {evidence.summary}</Text>}
    </Box>
  )
}

/** 渲染证据汇总统计。 */
export function EvidenceSummaryCard({ summary }: { summary: EvidenceSummary }) {
  const parts: Array<{ text: string; color: string }> = []
  if (summary.passed > 0) parts.push({ text: `${summary.passed} passed`, color: C.green })
  if (summary.failed > 0) parts.push({ text: `${summary.failed} failed`, color: C.red })
  if (summary.skipped > 0) parts.push({ text: `${summary.skipped} skipped`, color: C.dim })
  const total = summary.total

  return (
    <Box flexDirection="row">
      <Text color={C.dim}>Evidence: </Text>
      {parts.map((part, index) => (
        <React.Fragment key={index}>
          {index > 0 && <Text color={C.dim}> · </Text>}
          <Text color={part.color}>{part.text}</Text>
        </React.Fragment>
      ))}
      <Text color={C.dim}> ({total})</Text>
    </Box>
  )
}

export const EvidenceCard = React.memo(function EvidenceCard({ evidence, summary }: EvidenceCardProps) {
  if (summary) return <EvidenceSummaryCard summary={summary} />
  if (evidence) return <EvidenceEntry evidence={evidence} />
  return null
})
