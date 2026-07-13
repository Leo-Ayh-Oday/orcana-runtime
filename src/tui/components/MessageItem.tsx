/** MessageItem — 渲染单条 TuiMessage 为行数组。
 *  Phase 4: renderMessageLines 是纯函数（无 tick），pending 动画由 Scrollback 在
 *  视口裁剪后以 O(height) 代价叠加，不再触发 O(messages) 全量重算。 */

import React from "react"
import { Box, Text } from "ink"
import { theme } from "../theme/theme"
import { cleanDisplayText, formatDisplayText, trimForViewport } from "../format"
import { fitTerminalText } from "../format"
import { getGlyphTheme } from "../tokens"
import type { TuiMessage } from "../state/types"

export type ChatEventKind = "tool" | "task" | "plan" | "activity" | "error" | "gate" | "evidence" | "patch"

/** PR-5: marker 走 glyph 主题双轨制（ASCII fallback / Unicode 增强）。
 *  ASCII 模式保持 $/#/+/~/!/g/e/p，Unicode 模式用 ⏺⎿◈◆▸✎。 */
export function eventMarker(kind?: ChatEventKind): string {
  const g = getGlyphTheme()
  if (kind === "tool") return g.markerTool
  if (kind === "task") return g.markerTask
  if (kind === "plan") return g.markerPlan
  if (kind === "activity") return g.markerActivity
  if (kind === "error") return g.markerError
  if (kind === "gate") return g.markerGate
  if (kind === "evidence") return g.markerEvidence
  if (kind === "patch") return g.markerPatch
  return g.markerDefault
}

export function eventColor(kind?: ChatEventKind): string {
  if (kind === "tool") return theme.eventTool
  if (kind === "task") return theme.eventTask
  if (kind === "plan") return theme.eventPlan
  if (kind === "activity") return theme.eventActivity
  if (kind === "error") return theme.eventError
  if (kind === "gate") return theme.eventGate
  if (kind === "evidence") return theme.eventEvidence
  if (kind === "patch") return theme.eventPatch
  return theme.textFaint
}

/** 去掉 Delivery Report 标题头，只保留正文。 */
function stripCompletionReportForTranscript(text: string): string {
  const trimmed = text.trim()
  if (!/^##\s+(Delivery Report|交付报告)\s*$/im.test(trimmed)) return text

  const lines = trimmed.split(/\r?\n/)
  const firstHeading = lines.findIndex(line => /^##\s+(Delivery Report|交付报告)\s*$/i.test(line.trim()))
  if (firstHeading < 0) return text

  const stop = lines.findIndex((line, index) =>
    index > firstHeading && /^##\s+(Evidence|证据|Changed Files|已变更文件|Risk|风险)\s*$/i.test(line.trim()),
  )
  const body = lines.slice(firstHeading + 1, stop >= 0 ? stop : undefined).join("\n").trim()
  return body || text
}

export interface RenderedLine {
  marker: string
  text: string
  color: string
  /** PR-1.5: pending 动画类型。undefined = 静态行。
   *  "tail" — 流式输出尾行动画（附加 "...", "..", ".", "" 到行末）
   *
   *  原 "spinner" 分支已废除：空 pending message 不再渲染占位行，
   *  运行态信号由 ThinkingDock 单一职责接管。 */
  pendingAnim?: "tail"
  /** Phase 3: 截断类型。由 render 层设置，不影响真实 message.text。
   *  "above" — 头部被截（保留尾部）  "below" — 尾部被截（保留头部）
   *  "middle" — 中间被截（双端保留） "viewport" — 视口裁剪（earlier/newer） */
  trimKind?: "above" | "below" | "middle" | "viewport" | "none"
}

/** Phase 4: 纯函数 — 不含 tick。
 *  pending 消息返回带 pendingAnim 标记的静态行，
 *  动画由调用方（Scrollback）在视口裁剪后以 O(height) 代价叠加。 */
export function renderMessageLines(
  message: TuiMessage,
  width: number,
  status: string,
): RenderedLine[] {
  const contentWidth = Math.max(12, width - 4)
  const g = getGlyphTheme()
  const marker = message.role === "user" ? g.markerUser : message.role === "event" ? eventMarker(message.kind) : g.markerAssistant
  const color = message.role === "user"
    ? theme.userMessage
    : message.role === "event"
      ? eventColor(message.kind)
      : message.error
        ? theme.eventError
        : theme.assistantMessage

  if (message.role === "user") {
    // Phase 3: 保留头部 — 用户更关心问题开头
    const userText = cleanDisplayText(trimForViewport(message.text, Math.max(240, width * 5)))
    return formatDisplayText(userText, contentWidth).map((line, index) => ({
      marker: index === 0 ? marker : " ",
      text: line,
      color,
      trimKind: userText.includes("hidden below") ? ("below" as const) : ("none" as const),
    }))
  }

  if (message.role === "event") {
    // Phase 3: 保留头部 — 防止日志刷屏
    const eventText = cleanDisplayText(trimForViewport(message.text, Math.max(360, Math.min(1800, width * 18))))
    return formatDisplayText(eventText, contentWidth).map((line, index) => ({
      marker: index === 0 ? marker : " ",
      text: line,
      color,
      trimKind: eventText.includes("hidden below") ? ("below" as const) : ("none" as const),
    }))
  }

  if (message.text) {
    const assistantContent = stripCompletionReportForTranscript(message.text)
    // Assistant content stays complete. Scrollback owns bounded row-level
    // clipping, so text hidden outside the viewport remains reachable.
    const assistantText = cleanDisplayText(assistantContent)
    const trimKind = "none" as const
    const formatted: RenderedLine[] = formatDisplayText(assistantText, contentWidth).map((line, index) => ({
      marker: index === 0 ? marker : " ",
      text: line,
      color,
      trimKind,
    }))

    // Phase 4: 标记最后一行需要尾行动画（仅 pending 时）
    if (message.pending && formatted.length > 0) {
      const last = formatted[formatted.length - 1]!
      last.pendingAnim = "tail"
    }
    return formatted
  }

  // PR-1.5: 空 pending message 不再渲染占位行。
  // 运行态信号（Composing/Reading/Running）由 ThinkingDock 单一职责接管，
  // 不再写入 messages 也不在 Scrollback 渲染 spinner。
  return []
}

export interface MessageItemProps {
  message: TuiMessage
  width: number
  status: string
}

/** React 组件：渲染单条消息（不含间距行）。
 *  Phase 4: 不再接收 tick。pending 动画由 Scrollback 统一在视口层叠加。 */
export const MessageItem = React.memo(function MessageItem({ message, width, status }: MessageItemProps) {
  const lines = renderMessageLines(message, width, status)
  return (
    <>
      {lines.map((line, index) => (
        <Box key={index} flexDirection="row">
          <Box width={3}>
            <Text color={line.color}>{line.marker}</Text>
          </Box>
          <Text color={line.color === theme.eventError ? theme.eventError : theme.text}>{line.text}</Text>
        </Box>
      ))}
    </>
  )
})

/** 辅助：fitTerminalText 的薄包装，供其他组件复用。 */
export function fitText(text: string, width: number): string {
  return fitTerminalText(text, width)
}
