/** ConfirmModal — 高风险工具确认面板（Phase 5）。
 *
 *  显示当前等待确认的工具请求，列示风险和关键参数。
 *  键盘由 InputContext.Confirm 处理（通过 Phase 2 keymap），组件本身纯渲染。
 */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import type { ConfirmRequest } from "../confirm-stubs"

// ── 风险级别颜色 ──

function riskColor(level: number): string {
  if (level >= 4) return C.red
  if (level >= 3) return C.yellow
  return C.cyan
}

function riskLabel(level: number): string {
  if (level >= 5) return "CRITICAL"
  if (level >= 4) return "HIGH"
  if (level >= 3) return "MEDIUM"
  return "LOW"
}

function truncateParams(params: Record<string, unknown>, maxLen = 80): string {
  const s = JSON.stringify(params)
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen - 3) + "..."
}

// ── ConfirmModal ──

export interface ConfirmModalProps {
  request: ConfirmRequest
  /** 确认队列中的位置（如 "1/3"） */
  position: string
  width?: number
}

export const ConfirmModal = React.memo(function ConfirmModal({ request, position, width }: ConfirmModalProps) {
  const w = width ?? 72
  const rColor = riskColor(request.riskLevel)
  const rLabel = riskLabel(request.riskLevel)

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={rColor} paddingX={1}>
      {/* Header */}
      <Box flexDirection="row">
        <Text bold color={rColor}>⚠ Confirm [{rLabel}]</Text>
        <Text color={C.dim}> {position}</Text>
      </Box>

      {/* Tool + Risk */}
      <Box flexDirection="row">
        <Text color={C.cyan}>tool </Text>
        <Text color={C.white}>{request.toolName}</Text>
        <Text color={C.dim}> — </Text>
        <Text color={rColor}>{request.riskDescription}</Text>
      </Box>

      {/* Source gate */}
      <Box flexDirection="row">
        <Text color={C.dim}>source </Text>
        <Text color={C.dim}>{request.source}</Text>
      </Box>

      {/* Params (truncated) */}
      <Box flexDirection="row">
        <Text color={C.dim}>params </Text>
        <Text color={C.white}>{truncateParams(request.params)}</Text>
      </Box>

      {/* Actions */}
      <Box flexDirection="row" marginTop={1}>
        <Text color={C.green}>y</Text>
        <Text color={C.dim}> approve  </Text>
        <Text color={C.red}>n</Text>
        <Text color={C.dim}> deny  </Text>
        <Text color={C.yellow}>a</Text>
        <Text color={C.dim}> deny all  </Text>
        <Text color={C.dim}>Esc dismiss</Text>
      </Box>
    </Box>
  )
})

// ── 格式化确认结果（用于 scrollback 消息） ──

export function formatConfirmDecision(action: "approved" | "denied" | "denied_all" | "dismissed", toolName: string): string {
  switch (action) {
    case "approved": return `✓ approved ${toolName}`
    case "denied": return `✗ denied ${toolName}`
    case "denied_all": return `✗ denied all (${toolName} and subsequent)`
    case "dismissed": return `- dismissed ${toolName} confirmation`
  }
}
