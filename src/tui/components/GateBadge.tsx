/** GateBadge — 渲染门禁状态徽章。
 *  显示：PlanningGate pass / PatchTransaction block / EvidenceGate pending */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import type { TuiGateEvent } from "../state/types"
import type { GateSummary } from "../state/selectors"

export interface GateBadgeProps {
  /** 单条门禁事件 */
  gate?: TuiGateEvent
  /** 门禁汇总统计 */
  summary?: GateSummary
}

export function gateStatusColor(status: TuiGateEvent["status"]): string {
  switch (status) {
    case "pass": return C.green
    case "block": return C.red
    case "warn": return C.yellow
    case "skip": return C.dim
  }
}

export function gateStatusLabel(status: TuiGateEvent["status"]): string {
  switch (status) {
    case "pass": return "pass"
    case "block": return "block"
    case "warn": return "warn"
    case "skip": return "skip"
  }
}

/** 渲染单条门禁状态。 */
export function GateEntry({ gate }: { gate: TuiGateEvent }) {
  const color = gateStatusColor(gate.status)
  return (
    <Box flexDirection="row">
      <Text color={color}>{gate.gate}</Text>
      <Text color={color}> {gateStatusLabel(gate.status)}</Text>
      {gate.reason && <Text color={C.dim}>  {gate.reason}</Text>}
    </Box>
  )
}

/** 渲染门禁汇总。 */
export function GateSummaryBadge({ summary }: { summary: GateSummary }) {
  if (summary.total === 0) return null
  const color = summary.block > 0 ? C.red : summary.pass > 0 ? C.green : C.yellow
  const label = summary.block > 0
    ? `${summary.block} block`
    : summary.pass > 0
      ? "pass"
      : "pending"
  return (
    <Box flexDirection="row">
      <Text color={C.dim}>Gate: </Text>
      <Text color={color}>{label}</Text>
      {summary.pass > 0 && summary.block === 0 && (
        <Text color={C.dim}> ({summary.pass}/${summary.total})</Text>
      )}
    </Box>
  )
}

export const GateBadge = React.memo(function GateBadge({ gate, summary }: GateBadgeProps) {
  if (summary) return <GateSummaryBadge summary={summary} />
  if (gate) return <GateEntry gate={gate} />
  return null
})
