/** HeaderBar — 顶部单行状态条（Visual Step 2 → Phase 4a 重设计）。
 *
 *  Phase 4a: 单行紧凑状态条，替代旧的两行 Header + Sonar 布局。
 *  格式: Orcana  <mode>  <model>  <state>  ctx <pct>%  cache <pct>%  r<n>
 *
 *  状态行为:
 *    - idle/done: 静态 "done" / "idle"
 *    - running: 轻量 pulse 动画 "thinking [..  ]" (4-frame)
 *    - error/blocked: "!" 标记
 *    - queue > 0: 追加 "q:n"
 */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import type { TuiMode } from "../state/types"
import { getGlyphTheme } from "../tokens"

export interface HeaderBarProps {
  modelName: string
  provider?: string
  mode: TuiMode
  done: boolean
  errorLine: string
  queueCount: number
  tick: number
  cols: number
  isWorking: boolean
  /** Phase 4a: 新增 — round number, context %, cache % */
  round: number
  ctxPct: number
  cachePct: number
}

/** 模式名简化：lowercase, 不加 icon */
function modeLabel(mode: TuiMode): string {
  switch (mode) {
    case "discussion": return "discussion"
    case "readonly": return "readonly"
    case "narrow_edit": return "narrow-edit"
    case "long_task": return "long-task"
    case "planner": return "planner"
    case "executor": return "executor"
  }
}

function modeColor(mode: TuiMode): string {
  switch (mode) {
    case "discussion": return C.green
    case "readonly": return C.green
    case "narrow_edit": return C.yellow
    case "long_task": return C.blue
    case "planner": return C.cyan
    case "executor": return C.blue
  }
}

/**
 * Lightweight pulse animation — 4-frame thinking indicator.
 *   thinking [..  ] → thinking [... ] → thinking [ ...] → thinking [  ..]
 */
function ThinkingPulse({ tick, label }: { tick: number; label: string }) {
  const frames = [
    "[..  ]",
    "[... ]",
    "[ ...]",
    "[  ..]",
  ]
  const frame = frames[tick % 4] ?? "[....]"
  return (
    <Text color={C.cyan}>
      {label} {frame}
    </Text>
  )
}

/** 根据 running 状态和 status 文本决定短动态标签。 */
function activityPulse(isWorking: boolean, tick: number, status: string): React.ReactNode {
  if (!isWorking) return null
  const s = status.toLowerCase()

  let label = "working"
  if (s.includes("read") || s.includes("scan") || s.includes("search") || s.includes("grep")) label = "reading"
  else if (s.includes("think") || s.includes("context") || s.includes("rout") || s.includes("prepare")) label = "thinking"
  else if (s.includes("verif") || s.includes("check") || s.includes("typecheck") || s.includes("test")) label = "verifying"
  else if (s.includes("edit") || s.includes("write") || s.includes("patch")) label = "editing"
  else if (s.includes("block") || s.includes("denied")) label = "blocked"

  return <ThinkingPulse tick={tick} label={label} />
}

export const HeaderBar = React.memo(function HeaderBar({
  modelName,
  provider,
  mode,
  done,
  errorLine,
  queueCount,
  tick,
  cols,
  isWorking,
  round,
  ctxPct,
  cachePct,
}: HeaderBarProps) {
  const g = getGlyphTheme()
  const blocked = errorLine.length > 0
  const modelDisplay = provider ? `${provider}/${modelName}` : modelName

  // Narrow: drop cache% and round when cols < 80
  const narrow = cols < 80

  return (
    <Box flexDirection="row" height={1}>
      {/* Brand */}
      <Text bold color={C.cyan}>Orcana</Text>

      {/* Mode */}
      <Text color={C.dim}>  </Text>
      <Text color={modeColor(mode)}>{modeLabel(mode)}</Text>

      {/* Model */}
      <Text color={C.dim}>  {modelDisplay}</Text>

      {/* State */}
      <Text color={C.dim}>  </Text>
      {blocked ? (
        <Text color={C.red}>{g.warningIcon} {errorLine.slice(0, 30)}</Text>
      ) : done ? (
        <Text color={C.green}>done</Text>
      ) : isWorking ? (
        activityPulse(isWorking, tick, "")
      ) : (
        <Text color={C.dim}>idle</Text>
      )}

      {/* Context % */}
      {!narrow && (
        <>
          <Text color={C.dim}>  ctx </Text>
          <Text color={ctxPct > 50 ? C.red : ctxPct > 30 ? C.yellow : C.green}>{ctxPct}%</Text>
        </>
      )}

      {/* Cache % */}
      {!narrow && (
        <>
          <Text color={C.dim}>  cache </Text>
          <Text color={cachePct > 80 ? C.green : C.yellow}>{cachePct}%</Text>
        </>
      )}

      {/* Round */}
      {round > 0 && (
        <>
          <Text color={C.dim}>  r</Text>
          <Text color={C.cyan}>{round}</Text>
        </>
      )}

      {/* Queue */}
      {queueCount > 0 && (
        <>
          <Text color={C.dim}>  q:</Text>
          <Text color={C.cyan}>{queueCount}</Text>
        </>
      )}
    </Box>
  )
})
