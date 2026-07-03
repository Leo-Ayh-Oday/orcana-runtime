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
import { theme } from "../theme/theme"
import type { RightRailData } from "../state/selectors"
import { RuntimePanel } from "./RuntimePanel"
import { getGlyphTheme } from "../tokens"
import { useClock } from "../clock"

function ProgressBar({ value, max, width = 20, color = theme.info }: { value: number; max: number; width?: number; color?: string }) {
  const g = getGlyphTheme()
  const pct = Math.min(1, Math.max(0, max > 0 ? value / max : 0))
  const filled = Math.round(pct * width)
  return (
    <Box flexDirection="row">
      <Text color={color}>{g.progressFill.repeat(filled)}{g.progressEmpty.repeat(width - filled)}</Text>
      <Text color={theme.textFaint}> {Math.round(pct * 100)}%</Text>
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
  if (status === "running") return theme.info
  if (status === "done") return theme.success
  if (status === "blocked") return theme.warning
  if (status === "error") return theme.error
  return theme.textFaint
}

export interface RightRailProps extends RightRailData {
  width?: number
}

export const RightRail = React.memo(function RightRail(props: RightRailProps) {
  const { round, contextTokens, contextMax, cacheHitRate, toolHistory, taskProgress, runtime, rippleFindings } = props
  const { tick } = useClock()
  const width = props.width ?? 38
  const ctxPct = Math.round(contextMax > 0 ? (contextTokens / contextMax) * 100 : 0)
  const ctxColor = ctxPct > 50 ? theme.error : ctxPct > 30 ? theme.warning : theme.success

  return (
    <Box flexDirection="column" paddingLeft={1} width={width}>
      {/* 1. Runtime identity */}
      <Box flexDirection="row">
        <Text color={theme.brand} bold>runtime</Text>
        {round > 0 && <Text color={theme.textDim}>  r{round}</Text>}
        {round === 0 && runtime.ripplePhase === "idle" && runtime.gateSummary.total === 0 && <Text color={theme.textDim}>  idle</Text>}
      </Box>

      {/* 2. Ripple phase (if active or has findings) */}
      {(runtime.ripplePhase !== "idle" || rippleFindings.length > 0) && (
        <Box flexDirection="column" marginTop={1}>
          <RuntimePanel {...runtime} width={width - 2} />
        </Box>
      )}

      {/* 3. Gates */}
      {runtime.gateSummary.total > 0 && (
        <Box flexDirection="row" marginTop={1}>
          <Text color={theme.gate}>gates</Text>
          <Text color={theme.textFaint}> </Text>
          <Text color={runtime.gateSummary.block > 0 ? theme.gateBlock : theme.gatePass}>
            {runtime.gateSummary.pass}p/{runtime.gateSummary.block}b/{runtime.gateSummary.warn}w/{runtime.gateSummary.skip}s
          </Text>
        </Box>
      )}

      {/* 4. Evidence */}
      {runtime.evidenceSummary.total > 0 && (
        <Box flexDirection="row">
          <Text color={theme.evidence}>evidence</Text>
          <Text color={theme.textFaint}> </Text>
          <Text color={runtime.evidenceSummary.failed > 0 ? theme.error : theme.success}>
            {runtime.evidenceSummary.passed}p/{runtime.evidenceSummary.failed}f
          </Text>
        </Box>
      )}

      {/* 5. Patches */}
      {runtime.patchSummary.total > 0 && (
        <Box flexDirection="row">
          <Text color={theme.patch}>patches</Text>
          <Text color={theme.textFaint}> </Text>
          <Text color={runtime.patchSummary.rolledBack > 0 ? theme.warning : theme.textFaint}>
            {runtime.patchSummary.committed > 0 ? `${runtime.patchSummary.committed} committed` : ""}
            {runtime.patchSummary.proposed > 0 ? ` · ${runtime.patchSummary.proposed} proposed` : ""}
            {runtime.patchSummary.rolledBack > 0 ? ` · ${runtime.patchSummary.rolledBack} rolled back` : ""}
          </Text>
        </Box>
      )}

      {/* 6. Active tools */}
      {runtime.activeTools > 0 && (
        <Box flexDirection="row">
          <Text color={theme.info}>tools</Text>
          <Text color={theme.textDim}> {runtime.activeTools} running</Text>
        </Box>
      )}

      {/* 7. Recent tool history */}
      {toolHistory.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.info}>Recent</Text>
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
          <Text color={theme.textFaint}>ctx </Text>
          <Text color={ctxColor}>{ctxPct}%</Text>
          <Text color={theme.textFaint}>  cache </Text>
          <Text color={cacheHitRate > 80 ? theme.success : theme.warning}>{cacheHitRate}%</Text>
        </Box>
        <ProgressBar value={contextTokens} max={contextMax} width={24} color={ctxColor} />
      </Box>

      {/* Ripple findings (if any, above context but after runtime panel) */}
      {rippleFindings.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {rippleFindings.slice(0, 2).map((f, idx) => (
            <Text key={idx} color={f.severity === "block" ? theme.error : theme.warning}>
              {"  "}{f.severity === "block" ? "✗" : "!"} {f.file.slice(-20)}: {f.reason.slice(0, 24)}
            </Text>
          ))}
          {rippleFindings.length > 2 && <Text color={theme.textFaint}>  +{rippleFindings.length - 2} more</Text>}
        </Box>
      )}

      {/* Idle state still shows rail but compact */}
      {runtime.ripplePhase === "idle" && runtime.gateSummary.total === 0 && runtime.patchSummary.total === 0 && runtime.activeTools === 0 && (
        <Box marginTop={1}>
          <Text color={theme.textFaint}>idle · waiting for task</Text>
        </Box>
      )}
    </Box>
  )
})
