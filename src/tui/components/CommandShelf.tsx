/** CommandShelf — Slash 命令菜单独立组件（PR-3 + PR-4）。
 *
 *  职责：
 *    - 渲染 fuzzy 匹配后的命令列表（最多 5 条）
 *    - 高亮选中项
 *    - 无匹配时显示提示
 *    - PR-4: 按 CommandKind 语义着色（system/runtime/model/skill/debug/danger）
 *    - PR-4: 禁用命令显示为 dim + disabledReason
 *
 *  不职责（留在 OrcanaComposer）：
 *    - 键盘事件处理（Up/Down/Tab/Enter/Esc）
 *    - 命令匹配逻辑（由 score.ts 的 matchSlashCommands 完成）
 *    - 输入框管理
 *
 *  计划第 12 条硬约束："不要把命令菜单逻辑继续堆在 OrcanaComposer 内部"。
 *  本组件只负责渲染，匹配和键位由调用方驱动。
 */

import React from "react"
import { Box, Text } from "ink"
import { theme } from "../theme/theme"
import { palette } from "../theme/palette"
import type { SlashCommandHint, CommandKind } from "../input"
import type { ScoredCommand } from "../commands/score"

// ── PR-4: CommandKind → 颜色映射 ──

/** 6 种语义色 + disabled dim gray。
 *  system=cyan, runtime=green(低亮度), model=blue, skill=lavender, debug=amber, danger=rose */
export function commandKindColor(kind: CommandKind | undefined, enabled: boolean = true): string {
  if (enabled === false) return palette.fog  // disabled → dim gray
  switch (kind) {
    case "system":  return palette.cyan      // #38BDF8
    case "runtime": return palette.jade      // #34D399 (翡翠绿，比 green 低亮度)
    case "model":   return palette.blue      // #60A5FA
    case "skill":   return palette.evidence  // #A78BFA (紫罗兰，接近 lavender)
    case "debug":   return palette.amber     // #FBBF24
    case "danger":  return palette.coral     // #FB7185 (珊瑚红/rose)
    default:        return theme.text
  }
}

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
        const cmd = m.command
        const isEnabled = cmd.enabled !== false
        // PR-4: displayName 优先于 name（用于 "skill Development" 这类带子命令的）
        const displayCmd = cmd.displayName ?? cmd.name
        const nameColor = commandKindColor(cmd.kind, isEnabled)
        // 选中且启用 → brand 色；选中但禁用 → 仍 dim；未选中 → 按kind色（禁用则 dim）
        const renderedNameColor = selected && isEnabled
          ? theme.brand
          : nameColor
        const desc = cmd.description.length > maxDescWidth
          ? cmd.description.slice(0, maxDescWidth - 1) + "…"
          : cmd.description
        return (
          <Box key={cmd.name} flexDirection="row">
            <Text color={selected ? theme.brand : theme.textFaint}>
              {selected ? ">" : " "}{" "}
            </Text>
            <Text color={renderedNameColor}>
              /{displayCmd}
            </Text>
            <Text color={theme.textFaint}> {desc}</Text>
            {isEnabled === false && cmd.disabledReason && (
              <Text color={theme.textFaint}> ({cmd.disabledReason})</Text>
            )}
          </Box>
        )
      })}
    </Box>
  )
}
