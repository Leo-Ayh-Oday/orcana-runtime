/** CommandShelf — Slash 命令菜单独立组件（PR-3）。
 *
 *  职责：
 *    - 渲染 fuzzy 匹配后的命令列表（最多 5 条）
 *    - 高亮选中项
 *    - 无匹配时显示提示
 *
 *  不职责（留在 OrcanaComposer）：
 *    - 键盘事件处理（Up/Down/Tab/Enter/Esc）
 *    - 命令匹配逻辑（由 score.ts 的 matchCommands 完成）
 *    - 输入框管理
 *
 *  计划第 12 条硬约束："不要把命令菜单逻辑继续堆在 OrcanaComposer 内部"。
 *  本组件只负责渲染，匹配和键位由调用方驱动。
 */

import React from "react"
import { Box, Text } from "ink"
import { theme } from "../theme/theme"
import type { SlashCommandHint } from "../input"
import type { ScoredCommand } from "../commands/score"

export interface CommandShelfProps {
  /** 已匹配+评分的命令列表（最多 5 条）。 */
  matches: ReadonlyArray<ScoredCommand<SlashCommandHint>>
  /** 当前选中索引。 */
  selectedIndex: number
  /** 可用宽度（用于截断长描述）。 */
  width?: number
}

export function CommandShelf({ matches, selectedIndex, width = 80 }: CommandShelfProps) {
  if (matches.length === 0) {
    return (
      <Box flexDirection="column" marginBottom={1} marginLeft={2}>
        <Text color={theme.textFaint}>无匹配命令</Text>
      </Box>
    )
  }

  const maxDescWidth = Math.max(20, width - 30)

  return (
    <Box flexDirection="column" marginBottom={1} marginLeft={2}>
      {matches.map((m, index) => {
        const selected = index === selectedIndex
        const name = m.command.name
        const desc = m.command.description.length > maxDescWidth
          ? m.command.description.slice(0, maxDescWidth - 1) + "…"
          : m.command.description
        return (
          <Text key={name} color={selected ? theme.brand : theme.textDim}>
            {selected ? ">" : " "} /{name} <Text color={theme.textFaint}>{desc}</Text>
          </Text>
        )
      })}
    </Box>
  )
}
