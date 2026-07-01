/** MessageItem — 渲染单条 TuiMessage 为行数组。
 *  从 main.tsx 的 renderMessageLines 提取，保持纯函数 + memo 化。 */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import { cleanDisplayText, formatDisplayText, trimForViewport } from "../format"
import { fitTerminalText } from "../format"
import type { TuiMessage } from "../state/types"

export type ChatEventKind = "tool" | "task" | "plan" | "error"

export function eventMarker(kind?: ChatEventKind): string {
  if (kind === "tool") return "$"
  if (kind === "task") return "#"
  if (kind === "plan") return "+"
  if (kind === "error") return "!"
  return "-"
}

export function eventColor(kind?: ChatEventKind): string {
  if (kind === "tool") return C.green
  if (kind === "task") return C.blue
  if (kind === "plan") return C.cyan
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
}

/** 将一条消息渲染为行数组（纯函数，不含 React）。 */
export function renderMessageLines(
  message: TuiMessage,
  width: number,
  tick: number,
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
  const tail = ["", ".", "..", "..."][tick % 4] ?? ""

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
    const assistantText = `${cleanDisplayText(trimForViewport(assistantContent, Math.max(1200, Math.min(5000, width * 42))))}${message.pending ? tail : ""}`
    return formatDisplayText(assistantText, contentWidth).map((line, index) => ({
      marker: index === 0 ? marker : " ",
      text: line,
      color,
    }))
  }

  if (message.pending) {
    const verb = ["thinking", "routing", "reading", "checking"][tick % 4]
    const statusText = `${verb}${status ? ` / ${status}` : ""}`
    const line = Array.from({ length: Math.max(18, Math.min(contentWidth, 72)) }, (_, index) => {
      const phase = (index + tick) % 12
      if (phase === 0) return "="
      if (phase <= 2 || phase >= 10) return "~"
      if (phase <= 4 || phase >= 8) return "-"
      return "."
    }).join("")
    return [
      { marker, text: statusText, color },
      { marker: " ", text: line, color: C.cyan },
    ]
  }

  return []
}

export interface MessageItemProps {
  message: TuiMessage
  width: number
  tick: number
  status: string
}

/** React 组件：渲染单条消息（不含间距行）。 */
export const MessageItem = React.memo(function MessageItem({ message, width, tick, status }: MessageItemProps) {
  const lines = renderMessageLines(message, width, tick, status)
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
