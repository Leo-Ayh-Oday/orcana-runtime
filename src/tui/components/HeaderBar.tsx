/** HeaderBar — 顶部状态栏（Phase 3 增强）。
 *
 *  显示：Orcana | mode | model/provider | StatusMark | status | ctx/cache/rN | queue
 *  外加 SonarLine 动画指示 agent 是否在运行。 */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import type { TuiMode } from "../state/types"
import { ModeBadge } from "./ModeContract"

export interface HeaderBarProps {
  modelName: string
  /** Provider ID (deepseek/anthropic/openai) */
  provider?: string
  /** Active mode (discussion/readonly/narrow_edit/long_task/planner/executor) */
  mode: TuiMode
  status: string
  done: boolean
  errorLine: string
  queueCount: number
  tick: number
  cols: number
  isWorking: boolean
  /** Compact runtime summary: ctx% / cache% / round */
  runtimeSummary: string
}

function StatusMark({ done, error, tick }: { done: boolean; error: string; tick: number }) {
  if (error) return <Text color={C.red}>error</Text>
  if (done) return <Text color={C.green}>done</Text>
  return <Text color={C.cyan}>{[".", "o", "O", "o"][tick % 4]} working</Text>
}

function SonarLine({ tick, width, active }: { tick: number; width: number; active: boolean }) {
  const usable = Math.max(24, Math.min(width, 120))
  const line = Array.from({ length: usable }, (_, index) => {
    if (!active) return index % 2 === 0 ? "-" : "."
    const phase = (index + tick) % 16
    if (phase === 0) return "="
    if (phase <= 2 || phase >= 14) return "~"
    if (phase <= 5 || phase >= 11) return "-"
    return "."
  }).join("")
  return <Text color={active ? C.cyan : C.border}>{line}</Text>
}

export const HeaderBar = React.memo(function HeaderBar({
  modelName,
  provider,
  mode,
  status,
  done,
  errorLine,
  queueCount,
  tick,
  cols,
  isWorking,
  runtimeSummary,
}: HeaderBarProps) {
  return (
    <Box height={2} flexDirection="column">
      <Box flexDirection="row">
        <Text color={C.cyan} bold>Orcana</Text>
        {/* Phase 3: active mode badge */}
        <Text color={C.dim}> / </Text>
        <ModeBadge mode={mode} />
        {/* Phase 3: provider + model */}
        <Text color={C.dim}>
          {provider ? ` / ${provider}` : ""} / model {modelName}
        </Text>
        <Text color={C.dim}> / </Text>
        <StatusMark done={done} error={errorLine} tick={tick} />
        <Text color={C.dim}>{status ? ` / ${status}` : ""}</Text>
        {/* Phase 3: compact runtime summary */}
        <Text color={C.dim}> / {runtimeSummary}</Text>
        {queueCount > 0 && <Text color={C.cyan}> / queued {queueCount}</Text>}
      </Box>
      <SonarLine tick={tick} width={cols} active={isWorking} />
    </Box>
  )
})
