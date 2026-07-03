/** SonarPulse — Orcana 专属声呐脉冲动效（PR-1）。
 *
 *  设计原则：
 *    - 内部 tick 由 useLocalTick(140ms) 驱动，与全局 ClockContext 完全解耦
 *    - 帧序列来自 GlyphTheme.sonarFrames（Unicode: ◌◍◎◉◎◍ / ASCII: .oO0Oo）
 *    - active=false 时显示静态首帧
 *    - 不接收外部 tick prop
 *
 *  使用方式：
 *    <SonarPulse active={phase !== "idle"} phase="composing" />
 */

import React from "react"
import { Text } from "ink"
import { useLocalTick } from "./useLocalTick"
import { getGlyphTheme } from "../tokens"
import type { ThinkingPhase } from "./selectThinkingDock"

// ── 每 phase 的颜色 ──

function phaseColor(phase: ThinkingPhase): string {
  switch (phase) {
    case "routing":    return "#38BDF8"  // cyan
    case "thinking":   return "#A78BFA"  // purple
    case "reading":    return "#60A5FA"  // blue
    case "tooling":    return "#34D399"  // green
    case "reviewing":  return "#FBBF24"  // amber
    case "composing":  return "#F472B6"  // pink
    case "error":      return "#EF4444"  // red
    case "idle":
    default:           return "#64748B"  // dim
  }
}

export interface SonarPulseProps {
  active: boolean
  phase: ThinkingPhase
}

export function SonarPulse({ active, phase }: SonarPulseProps) {
  const tick = useLocalTick(active ? 140 : null)
  const g = getGlyphTheme()
  const frame = active
    ? g.sonarFrames[tick % g.sonarFramesLen] ?? "."
    : g.sonarFrames[0] ?? "."

  return (
    <Text color={phaseColor(phase)}>
      {frame}
    </Text>
  )
}
