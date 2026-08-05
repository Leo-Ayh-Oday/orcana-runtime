/** SessionLine — 唯一顶部状态行（Depthline P2）。
 *
 *  替代 HeaderBar + StatusBar。字段优先级链（评审修正 #7）：
 *    blocked/error > running/idle > queue > mode > model > ctx > provider > branch/path
 *
 *  降级表：
 *    ≥120: branch · state · mode · provider/model · ctx · queue
 *    80–119: state · mode · model · ctx · queue
 *    60–79: state · mode · short-model · queue
 *    <60: state · mode · queue
 *
 *  buildSessionLineFields 为纯函数，供单元测试断言各档位裁剪。
 */

import React from "react"
import { Box, Text } from "ink"
import { theme } from "../theme/theme"
import type { TuiMode } from "../state/types"
import { fitText } from "./MessageItem"

export interface SessionLineField {
  key: string
  text: string
  color: string
}

export interface SessionLineData {
  mode: TuiMode
  done: boolean
  errorLine: string
  status: string
  isWorking: boolean
  queueCount: number
  provider?: string
  modelName: string
  branch?: string
  repoRoot?: string
  ctxPct: number
  cachePct: number
  cols: number
}

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

/** 从 status 文本派生短标签。 */
export function stateLabel(isWorking: boolean, status: string): string {
  if (!isWorking) return "idle"
  const s = status.toLowerCase()
  if (s.includes("read") || s.includes("scan") || s.includes("search") || s.includes("grep")) return "reading"
  if (s.includes("think") || s.includes("context") || s.includes("rout") || s.includes("prepare")) return "thinking"
  if (s.includes("verif") || s.includes("check") || s.includes("typecheck") || s.includes("test")) return "verifying"
  if (s.includes("edit") || s.includes("write") || s.includes("patch")) return "editing"
  if (s.includes("block") || s.includes("denied")) return "blocked"
  return "working"
}

/** 纯函数：按优先级链构建字段数组（错误/阻断状态永不被裁剪）。 */
export function buildSessionLineFields(data: SessionLineData): SessionLineField[] {
  const { cols, mode, done, errorLine, isWorking, status, queueCount, provider, modelName, branch, repoRoot, ctxPct, cachePct } = data
  const fields: SessionLineField[] = []

  // 1. State — 最高优先级（blocked/error 永不裁剪）
  if (errorLine) {
    fields.push({ key: "state", text: `! ${errorLine.slice(0, 30)}`, color: theme.error })
  } else if (done) {
    fields.push({ key: "state", text: "done", color: theme.success })
  } else if (isWorking) {
    fields.push({ key: "state", text: stateLabel(isWorking, status), color: theme.brand })
  } else {
    fields.push({ key: "state", text: "idle", color: theme.textFaint })
  }

  // 2. Mode
  fields.push({ key: "mode", text: modeLabel(mode), color: modeColor(mode) })

  // 3. Queue
  if (queueCount > 0) {
    fields.push({ key: "queue", text: `q${queueCount}`, color: theme.brand })
  }

  // 4. Model（provider/model 组合；<60 列时裁到 model 名称截断）
  const combined = provider ? `${provider}/${modelName}` : modelName
  if (cols >= 60) {
    const short = shortModel(combined, cols >= 80 ? 40 : 20)
    fields.push({ key: "model", text: short, color: theme.textDim })
  }

  // 5. ctx（≥80 列）
  if (cols >= 80) {
    const ctxColor = ctxPct > 50 ? theme.error : ctxPct > 30 ? theme.warning : theme.success
    fields.push({ key: "ctx", text: `ctx ${ctxPct}%`, color: ctxColor })
  }

  // 6. cache（≥120 列）
  if (cols >= 120) {
    fields.push({ key: "cache", text: `cache ${cachePct}%`, color: cachePct > 80 ? theme.success : theme.warning })
  }

  // 7. branch/repo（≥120 列，最后裁剪）
  if (cols >= 120) {
    const repo = repoRoot?.split(/[/\\]/).pop() ?? ""
    const parts = [repo, branch].filter(Boolean)
    if (parts.length > 0) {
      fields.push({ key: "branch", text: parts.join(" "), color: theme.textFaint })
    }
  }

  return fields
}

function shortModel(full: string, maxLen = 40): string {
  if (full.length <= maxLen) return full
  return full.slice(0, maxLen - 3) + "..."
}

export const SessionLine = React.memo(function SessionLine({ data }: { data: SessionLineData }) {
  const fields = buildSessionLineFields(data)
  return (
    <Box flexDirection="row" height={1} overflow="hidden">
      <Text bold color={theme.brand}>orcana</Text>
      {fields.map(field => (
        <React.Fragment key={field.key}>
          <Text color={theme.textFaint}> · </Text>
          <Text color={field.color}>{field.text}</Text>
        </React.Fragment>
      ))}
    </Box>
  )
})

// re-export fitText 供调用方复用
export { fitText }
