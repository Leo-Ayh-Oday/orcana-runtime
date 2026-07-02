/** RightRail — 右侧栏组件，替代 Dashboard。
 *
 *  显示：Active Task / Tools (Touched Files) / Ripple Findings / Cache hits / Context
 *  使用 PR-1 selectRightRail 返回的 RightRailData（与 DashProps 结构兼容）。
 *  窄屏 (< 100 cols) 时由 AppShell 隐藏此组件。 */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import type { RightRailData } from "../state/selectors"
import { RuntimePanel, isRuntimePanelEnabled } from "./RuntimePanel"

// ── 内部工具组件 ──

function ProgressBar({ value, max, width = 20, color = C.cyan }: { value: number; max: number; width?: number; color?: string }) {
  const pct = Math.min(1, Math.max(0, max > 0 ? value / max : 0))
  const filled = Math.round(pct * width)
  const bar = "#".repeat(filled) + "-".repeat(width - filled)
  return (
    <Box flexDirection="row">
      <Text color={color}>{bar}</Text>
      <Text color={C.dim}> {Math.round(pct * 100)}%</Text>
    </Box>
  )
}

function MiniSparkline({ data, width = 20, color = C.cyan }: { data: number[]; width?: number; color?: string }) {
  if (!data.length) return <Text color={C.dim}>no data</Text>
  const chars = ".:-=+*#@"
  const max = Math.max(...data, 1)
  const spark = data
    .map(value => chars[Math.min(chars.length - 1, Math.round((value / max) * (chars.length - 1)))] ?? "_")
    .join("")
  return <Text color={color}>{spark.slice(-width)}</Text>
}

function toolIcon(status: RightRailData["toolHistory"][number]["status"]): string {
  if (status === "running") return ">"
  if (status === "done") return "x"
  if (status === "blocked") return "!"
  return "!"
}

// ── RightRail ──

export interface RightRailProps extends RightRailData {
  width?: number
  tick?: number
}

export const RightRail = React.memo(function RightRail(props: RightRailProps) {
  const { round, contextTokens, contextMax, cacheHitRate, cacheHits, toolHistory, taskProgress, runtime, rippleFindings } = props
  const tick = props.tick ?? 0
  const width = props.width ?? 42
  const ctxPct = Math.round((contextTokens / contextMax) * 100)
  const ctxColor = ctxPct > 50 ? C.red : ctxPct > 30 ? C.yellow : C.green

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={C.border} paddingX={1} width={width}>
      <Text bold color={C.cyan}>Orcana</Text>
      <Text color={C.dim}>
        round {round} / ctx <Text color={ctxColor}>{ctxPct}%</Text> / cache <Text color={cacheHitRate > 80 ? C.green : C.yellow}>{cacheHitRate}%</Text>
      </Text>
      <Box height={1} />

      {taskProgress.total > 0 && (
        <Box flexDirection="column">
          <Text color={C.blue}>Task: {taskProgress.current}</Text>
          <ProgressBar value={taskProgress.done} max={taskProgress.total} width={26} />
          <Box height={1} />
        </Box>
      )}

      {isRuntimePanelEnabled() ? (
        <Box flexDirection="column">
          <RuntimePanel {...runtime} tick={tick} width={width - 2} />
          <Box height={1} />
        </Box>
      ) : (
        rippleFindings.length > 0 && (
          <Box flexDirection="column">
            <Text color={C.yellow}>Ripple</Text>
            {rippleFindings.slice(0, 3).map((finding, index) => (
              <Text key={index} color={finding.severity === "block" ? C.red : C.yellow}>
                ! {finding.file}: {finding.reason.slice(0, 42)}
              </Text>
            ))}
            <Box height={1} />
          </Box>
        )
      )}

      <Text bold color={C.blue}>Tools</Text>
      {toolHistory.length === 0 && <Text color={C.dim}>  idle</Text>}
      {toolHistory.slice(-6).map((tool, index) => {
        const color = tool.status === "done" ? C.green : tool.status === "error" ? C.red : tool.status === "blocked" ? C.yellow : C.cyan
        return <Text key={index} color={color}>  [{toolIcon(tool.status)}] {tool.name}</Text>
      })}

      <Box height={1} />
      <Text color={C.dim}>Cache hits</Text>
      <MiniSparkline data={cacheHits} width={24} />
      <Box height={1} />
      <Text color={C.dim}>Context</Text>
      <ProgressBar value={contextTokens} max={contextMax} color={ctxColor} />
    </Box>
  )
})
