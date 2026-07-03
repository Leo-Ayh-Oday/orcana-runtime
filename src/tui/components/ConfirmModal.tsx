/** ConfirmModal — 高风险工具确认面板（Phase 7 migration）。
 *
 *  Phase 7: C.* → theme.* 全量迁移。
 *  显示当前等待确认的工具请求，列示风险和关键参数。
 *  键盘由 InputContext.Confirm 处理（通过 Phase 2 keymap），组件本身纯渲染。
 */

import React from "react"
import { Box, Text } from "ink"
import { theme } from "../theme/theme"
import type { ConfirmRequest } from "../confirm-stubs"

// ── 风险级别颜色 ──

function riskColor(level: number): string {
  if (level >= 4) return theme.error
  if (level >= 3) return theme.warning
  return theme.info
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
        <Text bold color={rColor}>! Confirm [{rLabel}]</Text>
        <Text color={theme.textFaint}> {position}</Text>
      </Box>

      {/* Tool + Risk */}
      <Box flexDirection="row">
        <Text color={theme.info}>tool </Text>
        <Text color={theme.text}>{request.toolName}</Text>
        <Text color={theme.textFaint}> — </Text>
        <Text color={rColor}>{request.riskDescription}</Text>
      </Box>

      {/* Source gate */}
      <Box flexDirection="row">
        <Text color={theme.textFaint}>source </Text>
        <Text color={theme.textFaint}>{request.source}</Text>
      </Box>

      {/* Params (truncated) */}
      <Box flexDirection="row">
        <Text color={theme.textFaint}>params </Text>
        <Text color={theme.text}>{truncateParams(request.params)}</Text>
      </Box>

      {/* Actions */}
      <Box flexDirection="row" marginTop={1}>
        <Text color={theme.success}>y</Text>
        <Text color={theme.textFaint}> approve  </Text>
        <Text color={theme.error}>n</Text>
        <Text color={theme.textFaint}> deny  </Text>
        <Text color={theme.warning}>a</Text>
        <Text color={theme.textFaint}> deny all  </Text>
        <Text color={theme.textFaint}>Esc dismiss</Text>
      </Box>
    </Box>
  )
})

// ── 格式化确认结果（用于 scrollback 消息） ──

export function formatConfirmDecision(action: "approved" | "denied" | "denied_all" | "dismissed", toolName: string): string {
  switch (action) {
    case "approved": return `v approved ${toolName}`
    case "denied": return `x denied ${toolName}`
    case "denied_all": return `x denied all (${toolName} and subsequent)`
    case "dismissed": return `- dismissed ${toolName} confirmation`
  }
}
