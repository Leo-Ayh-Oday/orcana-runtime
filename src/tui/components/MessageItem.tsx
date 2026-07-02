/** MessageItem — 渲染单条 TuiMessage 为行数组。
 *  Phase 4: renderMessageLines 是纯函数（无 tick），pending 动画由 Scrollback 在
 *  视口裁剪后以 O(height) 代价叠加，不再触发 O(messages) 全量重算。 */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import { cleanDisplayText, formatDisplayText, trimForViewport } from "../format"
import { fitTerminalText } from "../format"
import type { TuiMessage } from "../state/types"

export type ChatEventKind = "tool" | "task" | "plan" | "activity" | "error"

export function eventMarker(kind?: ChatEventKind): string {
  if (kind === "tool") return "$"
  if (kind === "task") return "#"
  if (kind === "plan") return "+"
  if (kind === "activity") return "~"
  if (kind === "error") return "!"
  return "-"
}

export function eventColor(kind?: ChatEventKind): string {
  if (kind === "tool") return C.green
  if (kind === "task") return C.blue
  if (kind === "plan") return C.cyan
  if (kind === "activity") return C.yellow
  if (kind === "error") return C.red
  return C.dim
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
  /** Phase 4: pending 动画类型。undefined = 静态行。
   *  "tail" — 流式输出尾行动画（附加 "...", "..", ".", "" 到行末）
   *  "spinner" — Braille spinner（⠋⠙⠹...）+ 动词 */
  pendingAnim?: "tail" | "spinner"
  /** pendingAnim="spinner" 时使用的状态文本。 */
  pendingStatus?: string
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
  const marker = message.role === "user" ? ">" : message.role === "event" ? eventMarker(message.kind) : "|"
  const color = message.role === "user"
    ? C.cyan
    : message.role === "event"
      ? eventColor(message.kind)
      : message.error
        ? C.red
        : C.blue

  if (message.role === "user") {
    const userText = cleanDisplayText(trimForViewport(message.text, Math.max(240, width * 5)))
    return formatDisplayText(userText, contentWidth).map((line, index) => ({
      marker: index === 0 ? marker : " ",
      text: line,
      color,
    }))
  }

  if (message.role === "event") {
    const eventText = cleanDisplayText(trimForViewport(message.text, Math.max(360, Math.min(1800, width * 18))))
    return formatDisplayText(eventText, contentWidth).map((line, index) => ({
      marker: index === 0 ? marker : " ",
      text: line,
      color,
    }))
  }

  if (message.text) {
    const assistantContent = stripCompletionReportForTranscript(message.text)
    const truncated = trimForViewport(assistantContent, Math.max(2000, Math.min(12000, width * 80)))
    const assistantText = cleanDisplayText(truncated)
    const formatted: RenderedLine[] = formatDisplayText(assistantText, contentWidth).map((line, index) => ({
      marker: index === 0 ? marker : " ",
      text: line,
      color,
    }))

    // Phase 4: 标记最后一行需要尾行动画（仅 pending 时）
    if (message.pending && formatted.length > 0) {
      const last = formatted[formatted.length - 1]!
      last.pendingAnim = "tail"
    }
    return formatted
  }

  if (message.pending) {
    // Phase 4: 返回静态占位行，pendingAnim="spinner" 标记由 Scrollback 叠加动画
    return [
      { marker, text: "", color, pendingAnim: "spinner", pendingStatus: status },
    ]
  }

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
          <Text color={line.color === C.red ? C.red : C.white}>{line.text}</Text>
        </Box>
      ))}
    </>
  )
})

/** 辅助：fitTerminalText 的薄包装，供其他组件复用。 */
export function fitText(text: string, width: number): string {
  return fitTerminalText(text, width)
}
