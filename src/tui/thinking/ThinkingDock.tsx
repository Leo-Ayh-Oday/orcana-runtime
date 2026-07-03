/** ThinkingDock — 固定在 ComposerFrame 上方的运行态显示（PR-1）。
 *
 *  职责：
 *    - 显示当前 agent 正在做什么（routing/thinking/reading/tooling/reviewing/composing/error）
 *    - SonarPulse 动效独立 tick，不触发 Scrollback 重算
 *    - 活跃工具时显示工具名 + 计数
 *    - idle 时隐藏（不占行）
 *
 *  不进入 messages。Transcript 只保留历史记录。
 */

import React from "react"
import { Box, Text } from "ink"
import { theme } from "../theme/theme"
import { SonarPulse } from "./SonarPulse"
import type { ThinkingDockModel } from "./selectThinkingDock"

export interface ThinkingDockProps {
  model: ThinkingDockModel
  width: number
}

export function ThinkingDock({ model, width }: ThinkingDockProps) {
  if (!model.visible) return null

  const activeTools = model.activeTools ?? []
  const maxToolWidth = Math.max(20, Math.min(40, Math.floor(width * 0.35)))
  const toolsText = activeTools.length > 0
    ? activeTools.map(t => t.count > 1 ? `${t.name} ×${t.count}` : t.name).join(" · ")
    : ""

  // 极窄屏：只显示 phase label，省略工具详情
  const compact = width < 60

  return (
    <Box flexDirection="row" paddingX={2} height={1}>
      <Box marginRight={1}>
        <SonarPulse
          active={model.phase !== "idle" && model.phase !== "error" && model.phase !== "waiting_permission"}
          phase={model.phase}
        />
      </Box>
      <Text color={model.phase === "error" ? theme.error : theme.text}>
        {model.label}
      </Text>
      {!compact && toolsText.length > 0 && (
        <Box marginLeft={2}>
          <Text color={theme.textDim}>
            {toolsText.length > maxToolWidth
              ? toolsText.slice(0, maxToolWidth - 1) + "…"
              : toolsText}
          </Text>
        </Box>
      )}
      {model.branch && (
        <Box marginLeft={1}>
          <Text color={theme.textFaint}>{model.branch}</Text>
        </Box>
      )}
    </Box>
  )
}
