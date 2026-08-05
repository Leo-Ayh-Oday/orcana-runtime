/** SessionLine — 唯一顶部状态区（Depthline P2 + 视觉优化）。
 *
 *  双行布局（≥60 列）：
 *    行1  ◉ orcana ● done            （符号化状态徽标）
 *    行2  mode discussion · deepseek-v4-pro · ctx ▓▓▓░░░░░ 25%
 *  窄屏（<60 列）折叠为单行（字段优先级链）。
 *
 *  buildSessionLineFields 保留为纯函数（字段链测试兼容），
 *  renderSessionLine 为最终双行呈现文本（golden 复用）。
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

/** ctx 块条（静态文本，无动画）：▓ 已用 · ░ 空闲，按百分比着色。 */
export function ctxBar(pct: number, slots = 8): string {
  const clamped = Math.max(0, Math.min(100, pct))
  const filled = Math.round((clamped / 100) * slots)
  return "▓".repeat(filled) + "░".repeat(slots - filled)
}

/** 状态符号 + 标签（静态）。 */
export function stateGlyph(isWorking: boolean, done: boolean, errorLine: string): { glyph: string; label: string; color: string } {
  if (errorLine) return { glyph: "✕", label: errorLine.slice(0, 30), color: theme.error }
  if (done) return { glyph: "●", label: "done", color: theme.success }
  if (isWorking) return { glyph: "◉", label: stateLabel(isWorking, ""), color: theme.brand }
  return { glyph: "○", label: "idle", color: theme.textFaint }
}

/** 双行呈现（纯函数，golden/测试复用）。窄屏折叠为单行。 */
export function renderSessionLine(data: SessionLineData): string[] {
  const { cols, mode, done, errorLine, isWorking, queueCount, provider, modelName, ctxPct, cachePct } = data
  const glyph = stateGlyph(isWorking, done, errorLine)

  // 行1：品牌 + 状态徽标（永不裁剪）
  const line1 = `orcana ${glyph.glyph} ${glyph.label}`

  if (cols < 60) {
    const fields = buildSessionLineFields(data).filter(f => f.key !== "state")
    const extra = fields.map(f => f.text).join(" · ")
    return [extra ? `${line1}  ${extra}` : line1]
  }

  // 行2：mode · model · ctx 块条 · cache
  const parts: string[] = []
  if (cols >= 60) parts.push(modeLabel(mode))
  if (cols >= 80) {
    parts.push(provider ? `${provider}/${shortModel(modelName, 24)}` : shortModel(modelName, 24))
    parts.push(`ctx ${ctxBar(ctxPct)} ${ctxPct}%`)
  }
  if (cols >= 120 && cachePct > 0) parts.push(`cache ${cachePct}%`)
  if (queueCount > 0) parts.push(`q${queueCount}`)
  const line2 = parts.join(" · ")
  return line2 ? [line1, line2] : [line1]
}

export const SessionLine = React.memo(function SessionLine({ data }: { data: SessionLineData }) {
  const glyph = stateGlyph(data.isWorking, data.done, data.errorLine)
  const twoLine = data.cols >= 60

  const line2Parts: string[] = []
  if (twoLine) {
    line2Parts.push(modeLabel(data.mode))
    if (data.cols >= 80) {
      const combined = data.provider ? `${data.provider}/${data.modelName}` : data.modelName
      line2Parts.push(shortModel(combined, 24))
    }
  }
  const ctxPct = data.ctxPct
  const ctxColor = ctxPct > 50 ? theme.error : ctxPct > 30 ? theme.warning : theme.success

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" height={1} overflow="hidden">
        <Text bold color={theme.brand}>orcana</Text>
        <Text color={theme.textFaint}> </Text>
        <Text color={glyph.color}>{glyph.glyph}</Text>
        <Text color={glyph.color}>{glyph.label}</Text>
        {data.queueCount > 0 && (
          <Text color={theme.brand}>  q{data.queueCount}</Text>
        )}
      </Box>
      {twoLine && line2Parts.length > 0 && (
        <Box flexDirection="row" height={1} overflow="hidden">
          <Text color={theme.textFaint}>{line2Parts[0]}</Text>
          {line2Parts.length > 1 && (
            <>
              <Text color={theme.textFaint}>  ·  </Text>
              <Text color={theme.textDim}>{line2Parts[1]}</Text>
            </>
          )}
          {data.cols >= 80 && (
            <>
              <Text color={theme.textFaint}>  ·  </Text>
              <Text color={ctxColor}>ctx </Text>
              <Text color={ctxColor}>{ctxBar(data.ctxPct)}</Text>
              <Text color={ctxColor}> {data.ctxPct}%</Text>
              {data.cols >= 120 && data.cachePct > 0 && (
                <>
                  <Text color={theme.textFaint}>  ·  </Text>
                  <Text color={data.cachePct > 80 ? theme.success : theme.warning}>cache {data.cachePct}%</Text>
                </>
              )}
            </>
          )}
        </Box>
      )}
    </Box>
  )
})

// re-export fitText 供调用方复用
export { fitText }
