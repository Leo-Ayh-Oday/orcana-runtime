/** RightRail — Orcana runtime rail（Visual Step 3）。
 *
 *  固定顺序：
 *    1. ModeContract (outside, in AppShell)
 *    2. Runtime: round, active phase, queue
 *    3. Ripple: phase + blocking obligations
 *    4. Gates: pass/warn/block/skip
 *    5. Evidence: passed/failed/running
 *    6. Patch: proposed/committed/rolled back
 *    7. Tools: last 3-5
 *    8. Context: ctx/cache compact meter
 *
 *  idle 也显示 rail，但内容紧凑。
 *  blocked 优先展示原因。
 */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import type { RightRailData } from "../state/selectors"
import { RuntimePanel } from "./RuntimePanel"
import { getGlyphTheme } from "../tokens"

function ProgressBar({ value, max, width = 20, color = C.cyan }: { value: number; max: number; width?: number; color?: string }) {
  const g = getGlyphTheme()
  const pct = Math.min(1, Math.max(0, max > 0 ? value / max : 0))
  const filled = Math.round(pct * width)
  return (
    <Box flexDirection="row">
      <Text color={color}>{g.progressFill.repeat(filled)}{g.progressEmpty.repeat(width - filled)}</Text>
      <Text color={C.dim}> {Math.round(pct * 100)}%</Text>
    </Box>
  )
}

function toolStatusIcon(status: string): string {
  const g = getGlyphTheme()
  if (status === "running") return ">"
  if (status === "done") return g.checkMark
  if (status === "blocked") return g.warningIcon
  if (status === "error") return g.crossMark
  return g.dot
}

function toolStatusColor(status: string): string {
  if (status === "running") return C.cyan
  if (status === "done") return C.green
  if (status === "blocked") return C.yellow
  if (status === "error") return C.red
  return C.dim
}

export interface RightRailProps extends RightRailData {
  width?: number
  tick?: number
}

export const RightRail = React.memo(function RightRail(props: RightRailProps) {
  const { round, contextTokens, contextMax, cacheHitRate, toolHistory, taskProgress, runtime, rippleFindings } = props
  const tick = props.tick ?? 0
  const width = props.width ?? 38
  const ctxPct = Math.round(contextMax > 0 ? (contextTokens / contextMax) * 100 : 0)
  const ctxColor = ctxPct > 50 ? C.red : ctxPct > 30 ? C.yellow : C.green

  return (
    <Box flexDirection="column" paddingLeft={1} width={width}>
      {/* 1. Runtime identity */}
      <Box flexDirection="row">
        <Text color={C.cyan} bold>runtime</Text>
        {round > 0 && <Text color={C.dim}>  r{round}</Text>}
        {round === 0 && runtime.ripplePhase === "idle" && runtime.gateSummary.total === 0 && <Text color={C.dim}>  idle</Text>}
      </Box>

      {/* 2. Ripple phase (if active or has findings) */}
      {(runtime.ripplePhase !== "idle" || rippleFindings.length > 0) && (
        <Box flexDirection="column" marginTop={1}>
          <RuntimePanel {...runtime} tick={tick} width={width - 2} />
        </Box>
      )}

      {/* 3. Gates */}
      {runtime.gateSummary.total > 0 && (
        <Box flexDirection="row" marginTop={1}>
          <Text color={C.blue}>gates</Text>
          <Text color={C.dim}> </Text>
          <Text color={runtime.gateSummary.block > 0 ? C.red : C.green}>
            {runtime.gateSummary.pass}p/{runtime.gateSummary.block}b/{runtime.gateSummary.warn}w/{runtime.gateSummary.skip}s
          </Text>
        </Box>
      )}

      {/* 4. Evidence */}
      {runtime.evidenceSummary.total > 0 && (
        <Box flexDirection="row">
          <Text color={C.blue}>evidence</Text>
          <Text color={C.dim}> </Text>
          <Text color={runtime.evidenceSummary.failed > 0 ? C.red : C.green}>
            {runtime.evidenceSummary.passed}p/{runtime.evidenceSummary.failed}f
          </Text>
        </Box>
      )}

      {/* 5. Patches */}
      {runtime.patchSummary.total > 0 && (
        <Box flexDirection="row">
          <Text color={C.blue}>patches</Text>
          <Text color={C.dim}> </Text>
          <Text color={runtime.patchSummary.rolledBack > 0 ? C.yellow : C.dim}>
            {runtime.patchSummary.committed > 0 ? `${runtime.patchSummary.committed} committed` : ""}
            {runtime.patchSummary.proposed > 0 ? ` · ${runtime.patchSummary.proposed} proposed` : ""}
            {runtime.patchSummary.rolledBack > 0 ? ` · ${runtime.patchSummary.rolledBack} rolled back` : ""}
          </Text>
        </Box>
      )}

      {/* 6. Active tools */}
      {runtime.activeTools > 0 && (
        <Box flexDirection="row">
          <Text color={C.cyan}>tools</Text>
          <Text color={C.dim}> {runtime.activeTools} running</Text>
        </Box>
      )}

      {/* 7. Recent tool history */}
      {toolHistory.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={C.blue}>Recent</Text>
          {toolHistory.slice(-4).map((tool, idx) => (
            <Text key={idx} color={toolStatusColor(tool.status)}>
              {"  "}[{toolStatusIcon(tool.status)}] {tool.name}
            </Text>
          ))}
        </Box>
      )}

      {/* 8. Context compact meter */}
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text color={C.dim}>ctx </Text>
          <Text color={ctxColor}>{ctxPct}%</Text>
          <Text color={C.dim}>  cache </Text>
          <Text color={cacheHitRate > 80 ? C.green : C.yellow}>{cacheHitRate}%</Text>
        </Box>
        <ProgressBar value={contextTokens} max={contextMax} width={24} color={ctxColor} />
      </Box>

      {/* Ripple findings (if any, above context but after runtime panel) */}
      {rippleFindings.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {rippleFindings.slice(0, 2).map((f, idx) => (
            <Text key={idx} color={f.severity === "block" ? C.red : C.yellow}>
              {"  "}{f.severity === "block" ? "✗" : "!"} {f.file.slice(-20)}: {f.reason.slice(0, 24)}
            </Text>
          ))}
          {rippleFindings.length > 2 && <Text color={C.dim}>  +{rippleFindings.length - 2} more</Text>}
        </Box>
      )}

      {/* Idle state still shows rail but compact */}
      {runtime.ripplePhase === "idle" && runtime.gateSummary.total === 0 && runtime.patchSummary.total === 0 && runtime.activeTools === 0 && (
        <Box marginTop={1}>
          <Text color={C.dim}>idle · waiting for task</Text>
        </Box>
      )}
    </Box>
  )
})
