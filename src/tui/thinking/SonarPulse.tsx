/** SonarPulse — Orcana 专属声呐脉冲动效（PR-1）。
 *
 *  设计原则：
 *    - 内部 tick 由 useLocalTick(140ms) 驱动，与全局 ClockContext 完全解耦
 *    - 帧序列来自 GlyphTheme.sonarFrames（Unicode: ◌◍◎◉◎◍ / ASCII: .oO0Oo）
 *    - active=false 时显示静态首帧
 *    - 不接收外部 tick prop
 *
 *  PR-10: 集成 useStalledAnimation 渐变红。
 *    - 当 lastTokenAt + hasActiveTools 提供时，启用 stalled 检测
 *    - stalled 期间 phaseColor 线性渐变到 error 色（2s 全程）
 *    - 通过 useClock 触发重算 intensity（96ms tick）
 *
 *  使用方式：
 *    <SonarPulse active={phase !== "idle"} phase="composing" />
 *    <SonarPulse active lastTokenAt={ts} hasActiveTools={false} phase="thinking" />
 */

import React from "react"
import { Text } from "ink"
import { useLocalTick } from "./useLocalTick"
import { getGlyphTheme } from "../tokens"
import type { ThinkingPhase } from "./selectThinkingDock"
import { useStalledAnimation, interpolateColor } from "../hooks/use-stalled-animation"
import { theme } from "../theme/theme"

// ── 每 phase 的颜色 ──

function phaseColor(phase: ThinkingPhase): string {
  switch (phase) {
    case "routing":    return "#38BDF8"  // cyan
    case "thinking":   return "#A78BFA"  // purple
    case "planning":   return "#C4B5FD"  // 浅紫 — planning 是 thinking 的子状态，用更浅的紫区分
    case "reading":    return "#60A5FA"  // blue
    case "tooling":    return "#34D399"  // green
    case "reviewing":  return "#FBBF24"  // amber
    case "composing":  return "#F472B6"  // pink
    case "waiting_permission": return "#FB923C"  // 橙色 — 等待用户操作，阻塞态
    case "error":      return "#EF4444"  // red
    case "idle":
    default:           return "#64748B"  // dim
  }
}

export interface SonarPulseProps {
  active: boolean
  phase: ThinkingPhase
  /** PR-10: 最近一次 token 时间戳。提供时启用 stalled 渐变。 */
  lastTokenAt?: number
  /** PR-10: 是否有活跃 tool。true 时不判定 stalled。 */
  hasActiveTools?: boolean
}

export function SonarPulse({ active, phase, lastTokenAt, hasActiveTools }: SonarPulseProps) {
  const tick = useLocalTick(active ? 140 : null)
  const g = getGlyphTheme()
  const frame = active
    ? g.sonarFrames[tick % g.sonarFramesLen] ?? "."
    : g.sonarFrames[0] ?? "."

  // PR-10: stalled 渐变红
  // 仅当 lastTokenAt 显式提供（>= 0）且非 error/waiting_permission phase 时启用
  const enableStalled = lastTokenAt !== undefined && lastTokenAt > 0
    && phase !== "error" && phase !== "waiting_permission" && phase !== "idle"
  const { intensity } = useStalledAnimation(
    enableStalled ? lastTokenAt! : 0,
    hasActiveTools ?? false,
  )

  const baseColor = phaseColor(phase)
  const color = intensity > 0
    ? interpolateColor(baseColor, theme.error, intensity)
    : baseColor

  return (
    <Text color={color}>
      {frame}
    </Text>
  )
}
