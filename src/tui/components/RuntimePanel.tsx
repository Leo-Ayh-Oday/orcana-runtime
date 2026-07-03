/** RuntimePanel — Orcana 运行态面板（PR-5）。
 *
 *  显示四个运行态区块：
 *    1. Ripple Wave — 涟漪阶段动画（scan → propagate → verify → settled/blocked）
 *    2. Gate Layers — 门禁层级状态汇总
 *    3. Evidence — 证据链状态汇总
 *    4. Patches — 补丁生命周期汇总
 *
 *  设计原则：
 *    - 低帧动效：tick 驱动的简单字符动画，不使用 setTimeout/setInterval
 *    - 数据驱动：所有数据来自 selectRuntimePanel，无内部状态
 *    - 可关闭：env DEEPSEEK_TUI_RUNTIME_PANEL=off 时 AppShell 不渲染此组件
 *    - 纯展示：不 dispatch 事件，不修改 state
 */

import React from "react"
import { Box, Text } from "ink"
import { C, theme } from "../theme/theme"
import type { TuiRipplePhase } from "../state/types"
import type { RuntimePanelData } from "../state/selectors"
import { useClock } from "../clock"
import { getGlyphTheme } from "../tokens"

// ── 纯函数（导出供测试） ──

/** 涟漪阶段对应的标签文本。 */
export function ripplePhaseLabel(phase: TuiRipplePhase): string {
  switch (phase) {
    case "idle": return "idle"
    case "scan": return "scanning"
    case "propagate": return "propagating"
    case "verify": return "verifying"
    case "blocked": return "blocked"
    case "settled": return "settled"
  }
}

/** 涟漪阶段对应的颜色（PR-4: 升级用 theme.* 语义色）。 */
export function ripplePhaseColor(phase: TuiRipplePhase): string {
  switch (phase) {
    case "idle": return theme.textFaint
    case "scan": return theme.info
    case "propagate": return theme.brand
    case "verify": return theme.warning
    case "blocked": return theme.error
    case "settled": return theme.success
  }
}

/** PR-4: 涟漪阶段对应的 shimmer 扫光色（glimmer 高亮）。
 *  propagate 正向扫光用 brandShimmer，verify 反向扫光用 warningShimmer，
 *  settled 用 successShimmer，blocked 用 errorShimmer。 */
export function ripplePhaseShimmerColor(phase: TuiRipplePhase): string {
  switch (phase) {
    case "idle": return theme.textFaint
    case "scan": return theme.brandShimmer
    case "propagate": return theme.brandShimmer
    case "verify": return theme.warningShimmer
    case "blocked": return theme.errorShimmer
    case "settled": return theme.successShimmer
  }
}

/** 低帧动画帧字符（tick 驱动，~4fps @ 250ms tick）。
 *  PR-4: 走 glyph 主题双轨制（ASCII fallback / Unicode 增强）。
 *  glimmer 方向语义：
 *    propagate: ○○○→●○○→●●○→●●● 正向左→右扩散
 *    verify: ▁▃▅▇▅▃ 反向脉冲（右→左收敛） */
export function rippleWaveChar(phase: TuiRipplePhase, tick: number): string {
  const g = getGlyphTheme()
  const frame = Math.floor(tick / 2) // 降帧：每 2 tick 一帧
  switch (phase) {
    case "idle": {
      const frames = g.rippleIdleFrames
      return frames[frame % frames.length] ?? frames[0]!
    }
    case "scan": {
      const frames = g.rippleScanFrames
      return frames[frame % frames.length] ?? frames[0]!
    }
    case "propagate": {
      const frames = g.ripplePropagateFrames
      return frames[frame % frames.length] ?? frames[0]!
    }
    case "verify": {
      const frames = g.rippleVerifyFrames
      return frames[frame % frames.length] ?? frames[0]!
    }
    case "blocked": {
      const frames = g.rippleBlockedFrames
      return frames[frame % frames.length] ?? frames[0]!
    }
    case "settled": {
      const frames = g.rippleSettledFrames
      return frames[frame % frames.length] ?? frames[0]!
    }
  }
}

/** 检查运行态面板是否启用（env 开关）。 */
export function isRuntimePanelEnabled(): boolean {
  const flag = process.env.DEEPSEEK_TUI_RUNTIME_PANEL
  return flag !== "off" && flag !== "0" && flag !== "false"
}

/** 格式化门禁汇总为一行文本。 */
export function formatGateSummary(summary: RuntimePanelData["gateSummary"]): string {
  if (summary.total === 0) return "no gates"
  const parts: string[] = []
  if (summary.pass > 0) parts.push(`${summary.pass} pass`)
  if (summary.block > 0) parts.push(`${summary.block} block`)
  if (summary.warn > 0) parts.push(`${summary.warn} warn`)
  if (summary.skip > 0) parts.push(`${summary.skip} skip`)
  return parts.length > 0 ? parts.join(" · ") : "no gates"
}

/** 格式化证据汇总为一行文本。 */
export function formatEvidenceSummary(summary: RuntimePanelData["evidenceSummary"]): string {
  if (summary.total === 0) return "no evidence"
  const parts: string[] = []
  if (summary.passed > 0) parts.push(`${summary.passed} passed`)
  if (summary.failed > 0) parts.push(`${summary.failed} failed`)
  if (summary.running > 0) parts.push(`${summary.running} running`)
  if (summary.blocked > 0) parts.push(`${summary.blocked} blocked`)
  if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`)
  return parts.length > 0 ? parts.join(" · ") : "no evidence"
}

/** 格式化补丁汇总为一行文本。 */
export function formatPatchSummary(summary: RuntimePanelData["patchSummary"]): string {
  if (summary.total === 0) return "no patches"
  const parts: string[] = []
  if (summary.proposed > 0) parts.push(`${summary.proposed} proposed`)
  if (summary.committed > 0) parts.push(`${summary.committed} committed`)
  if (summary.rolledBack > 0) parts.push(`${summary.rolledBack} rolled back`)
  return parts.length > 0 ? parts.join(" · ") : "no patches"
}

// ── RuntimePanel 组件 ──

export interface RuntimePanelProps extends RuntimePanelData {
  width?: number
}

export const RuntimePanel = React.memo(function RuntimePanel(props: RuntimePanelProps) {
  const { ripplePhase, rippleFindings, gateSummary, evidenceSummary, patchSummary, activeTools } = props
  const { tick } = useClock()
  const width = props.width ?? 38

  // idle 时折叠为单行，节省空间
  if (ripplePhase === "idle" && rippleFindings.length === 0 && gateSummary.total === 0 && patchSummary.total === 0) {
    return (
      <Box flexDirection="column">
        <Text color={C.dim}>Runtime: idle</Text>
      </Box>
    )
  }

  const phaseColor = ripplePhaseColor(ripplePhase)
  const shimmerColor = ripplePhaseShimmerColor(ripplePhase)
  const waveChar = rippleWaveChar(ripplePhase, tick)
  const phaseLabel = ripplePhaseLabel(ripplePhase)

  return (
    <Box flexDirection="column" width={width}>
      {/* Ripple Wave — PR-4: waveChar 用 shimmer 扫光色，label 用 base 色 */}
      <Box flexDirection="row">
        <Text color={shimmerColor}>{waveChar}</Text>
        <Text> </Text>
        <Text color={phaseColor} bold>ripple</Text>
        <Text color={C.dim}> {phaseLabel}</Text>
      </Box>

      {/* Ripple Findings（最多 2 条） */}
      {rippleFindings.length > 0 && (
        <Box flexDirection="column">
          {rippleFindings.slice(0, 2).map((finding, index) => (
            <Text key={index} color={finding.severity === "block" ? C.red : C.yellow}>
              {"  "}{finding.severity === "block" ? "✗" : "!"} {finding.file.slice(-24)}: {finding.reason.slice(0, 28)}
            </Text>
          ))}
          {rippleFindings.length > 2 && (
            <Text color={C.dim}>  +{rippleFindings.length - 2} more</Text>
          )}
        </Box>
      )}

      {/* Gate Layers */}
      <Box flexDirection="row">
        <Text color={C.blue}>gates</Text>
        <Text> </Text>
        <Text color={gateSummary.block > 0 ? C.red : C.dim}>
          {formatGateSummary(gateSummary)}
        </Text>
      </Box>

      {/* Evidence Status */}
      <Box flexDirection="row">
        <Text color={C.blue}>evidence</Text>
        <Text> </Text>
        <Text color={evidenceSummary.failed > 0 ? C.red : C.dim}>
          {formatEvidenceSummary(evidenceSummary)}
        </Text>
      </Box>

      {/* Patch Lifecycle */}
      <Box flexDirection="row">
        <Text color={C.blue}>patches</Text>
        <Text> </Text>
        <Text color={patchSummary.rolledBack > 0 ? C.yellow : C.dim}>
          {formatPatchSummary(patchSummary)}
        </Text>
      </Box>

      {/* Active Tools（仅在有运行中工具时显示） */}
      {activeTools > 0 && (
        <Box flexDirection="row">
          <Text color={C.cyan}>tools</Text>
          <Text> </Text>
          <Text color={C.cyan}>{activeTools} running</Text>
        </Box>
      )}
    </Box>
  )
})
