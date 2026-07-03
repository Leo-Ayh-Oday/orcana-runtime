/** HeaderBar — 顶部单行状态条（Phase 2 重设计）。
 *
 *  格式: Orcana · <mode> · <state> · <model-short> · ctx <n>% · cache <n>% · r<n> · q:<n>
 *
 *  截断优先级（窄屏时按此顺序裁减）:
 *    1. cache %        (cols<96 裁)
 *    2. round          (round===0 或 cols<80 裁)
 *    3. model-short    (用 fitText 截断，保留前段)
 *    4. ctx %          (cols<60 裁)
 *    5-8. brand/mode/state/blocked/queue 永不裁
 *
 *  state 统一派生:
 *    - blocked → "! <reason>" (error 色，全宽度优先)
 *    - done → "done" (success 色)
 *    - running → activityPulse (brand 色，4-frame)
 *    - idle → "idle" (textFaint 色) */

import React from "react"
import { Box, Text } from "ink"
import { theme } from "../theme/theme"
import type { TuiMode } from "../state/types"
import { fitText } from "./MessageItem"
import { useClock } from "../clock"

export interface HeaderBarProps {
  modelName: string
  provider?: string
  mode: TuiMode
  done: boolean
  errorLine: string
  status: string
  queueCount: number
  cols: number
  isWorking: boolean
  round: number
  ctxPct: number
  cachePct: number
}

// ── 辅助函数 ──

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
    case "discussion": return theme.success
    case "readonly": return theme.success
    case "narrow_edit": return theme.warning
    case "long_task": return theme.info
    case "planner": return theme.brand
    case "executor": return theme.info
  }
}

/** 缩短模型名: "deepseek-v4-pro-experimental" → "deepseek-v4-p..." */
function shortModel(full: string, maxLen = 24): string {
  if (full.length <= maxLen) return full
  return full.slice(0, maxLen - 3) + "..."
}

// ── 状态组件 ──

/** 4-frame 轻量 pulse: "working [..  ]" → "working [... ]" → "working [ ...]" → "working [  ..]" */
function ActivityPulse({ label, color }: { label: string; color: string }) {
  const { tick } = useClock()
  const frames = ["[..  ]", "[... ]", "[ ...]", "[  ..]"]
  const frame = frames[tick % 4] ?? "[....]"
  return <Text color={color}>{label} {frame}</Text>
}

/** 从 status 文本派生短标签。 */
function stateLabel(isWorking: boolean, status: string): React.ReactNode {
  if (!isWorking) return null
  const s = status.toLowerCase()
  let label = "working"
  if (s.includes("read") || s.includes("scan") || s.includes("search") || s.includes("grep")) label = "reading"
  else if (s.includes("think") || s.includes("context") || s.includes("rout") || s.includes("prepare")) label = "thinking"
  else if (s.includes("verif") || s.includes("check") || s.includes("typecheck") || s.includes("test")) label = "verifying"
  else if (s.includes("edit") || s.includes("write") || s.includes("patch")) label = "editing"
  else if (s.includes("block") || s.includes("denied")) label = "blocked"
  return <ActivityPulse label={label} color={theme.brand} />
}

// ── 分隔符 ──

function Sep() {
  return <Text color={theme.textFaint}>  </Text>
}

// ── 主组件 ──

export const HeaderBar = React.memo(function HeaderBar({
  modelName,
  provider,
  mode,
  done,
  errorLine,
  status,
  queueCount,
  cols,
  isWorking,
  round,
  ctxPct,
  cachePct,
}: HeaderBarProps) {
  const blocked = errorLine.length > 0
  const modelDisplay = provider ? `${provider}/${modelName}` : modelName

  // 截断决策
  const showCache = cols >= 96
  const showRound = round > 0 && cols >= 80
  const showCtx = cols >= 60

  // model 可用宽度 = 总宽 - 已占字段。固定字段约 48 字符 (brand 6 + mode 12 + state 12 + sep 8 + ctx 7 + cache 9 + round 4 + queue 5)
  // 简化: 给 model 分配 cols - 60（保证 mode/state/ctx 不被挤出）
  const modelMax = Math.max(8, cols - 60)
  const modelShort = shortModel(modelDisplay, modelMax)

  // ctx 颜色: >50 error, >30 warning, <=30 success
  const ctxColor = ctxPct > 50 ? theme.error : ctxPct > 30 ? theme.warning : theme.success

  return (
    <Box flexDirection="row" height={1} overflow="hidden">
      {/* 1. Brand — 永不截断 */}
      <Text bold color={theme.brand}>Orcana</Text>
      <Sep />

      {/* 2. Mode — 永不截断 */}
      <Text color={modeColor(mode)}>{modeLabel(mode)}</Text>
      <Sep />

      {/* 3. State — 永不截断（blocked 优先、running 次之、done/idle 末之） */}
      {blocked ? (
        <Text color={theme.error}>{errorLine.slice(0, 30)}</Text>
      ) : done ? (
        <Text color={theme.success}>done</Text>
      ) : isWorking ? (
        stateLabel(isWorking, status)
      ) : (
        <Text color={theme.textFaint}>idle</Text>
      )}
      <Sep />

      {/* 4. Model — 可截断 */}
      <Text color={theme.textDim}>{modelShort}</Text>

      {/* 5. ctx % — cols<60 裁 */}
      {showCtx && (
        <>
          <Sep />
          <Text color={theme.textFaint}>ctx </Text>
          <Text color={ctxColor}>{ctxPct}%</Text>
        </>
      )}

      {/* 6. cache % — cols<96 裁 */}
      {showCache && (
        <>
          <Sep />
          <Text color={theme.textFaint}>cache </Text>
          <Text color={cachePct > 80 ? theme.success : theme.warning}>{cachePct}%</Text>
        </>
      )}

      {/* 7. Round — round>0 且 cols≥80 */}
      {showRound && (
        <>
          <Sep />
          <Text color={theme.textFaint}>r</Text>
          <Text color={theme.brand}>{round}</Text>
        </>
      )}

      {/* 8. Queue — 永不截断，仅 queue>0 时显示 */}
      {queueCount > 0 && (
        <>
          <Sep />
          <Text color={theme.textFaint}>q:</Text>
          <Text color={theme.brand}>{queueCount}</Text>
        </>
      )}
    </Box>
  )
})
