/** ShortcutsPanel — 快捷键总览 overlay（Depthline P3）。
 *
 *  打开：Ctrl+?（Scrollback context）。内容全部派生自 ActionRegistry，
 *  与 HintBar / keymap 同一数据源。Esc 关闭。
 */

import React from "react"
import { Box, Text } from "ink"
import { theme } from "../../theme/theme"
import { ACTIONS, type ActionDefinition } from "../../presentation/actions"
import { shortcutLabel } from "../../presentation/hints"

export interface ShortcutsPanelProps {
  width: number
}

/** 纯函数：面板行（无 ANSI，供测试）。按 context 分组，每组输出一次标题。 */
export function formatShortcutLines(width: number): string[] {
  const descBudget = Math.max(8, width - 34)
  const byContext = new Map<string, string[]>()
  for (const action of ACTIONS) {
    if (action.enabled === false) continue
    const binding = action.shortcuts[0]
    if (!binding) continue
    const key = shortcutLabel(binding.key, binding.ctrl, binding.shift)
    const desc = action.description.length > descBudget
      ? action.description.slice(0, descBudget - 1) + "..."
      : action.description
    const line = `  ${key.padEnd(12)} ${action.label.padEnd(12)} ${desc}`
    for (const context of action.contexts) {
      if (!byContext.has(context)) byContext.set(context, [])
      byContext.get(context)!.push(line)
    }
  }
  const lines: string[] = []
  for (const [context, entries] of byContext) {
    lines.push(context)
    lines.push(...entries)
  }
  return lines
}

export const ShortcutsPanel = React.memo(function ShortcutsPanel({ width }: ShortcutsPanelProps) {
  const boxWidth = Math.max(42, Math.min(width - 4, 92))
  const lines = formatShortcutLines(boxWidth - 4)
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.borderActive} paddingX={1} width={boxWidth}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={theme.brand}>shortcuts</Text>
        <Text color={theme.textFaint}>Esc close</Text>
      </Box>
      {lines.map((line, index) => (
        <Text key={index} color={theme.textDim}>{line}</Text>
      ))}
    </Box>
  )
})

// 供测试使用
export type { ActionDefinition }
