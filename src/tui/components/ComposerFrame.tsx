/** ComposerFrame — 固定底部输入框的 frame 包装（PR-2）。
 *
 *  职责：
 *    - 上下轻分隔线（──────────────────）
 *    - 包装 OrcanaComposer，使输入框视觉上成为固定 frame
 *    - 不包含命令面板逻辑（CommandShelf 由 OrcanaComposer 内部渲染）
 *
 *  设计原则：
 *    - 分隔线使用 theme.border 色，轻量不抢眼
 *    - 分隔线宽度跟随终端宽度，窄屏保护下限 20 字符
 *    - 纯展示组件，不持有状态
 *
 *  验收（PR-2 plan）：
 *    - 输入框始终固定在底部
 *    - running 输出不会把输入框顶走
 *    - Footer 不再重复 ctx/cache/model（由 StatusBar 承担）
 */

import React from "react"
import { Box, Text } from "ink"
import { theme } from "../theme/theme"

export interface ComposerFrameProps {
  /** 子内容（通常是 OrcanaComposer） */
  children: React.ReactNode
  /** 可用宽度（用于生成分隔线字符数，通常 = cols - 2 padding） */
  width: number
}

/** 生成分隔线字符串，保护下限。
 *  - 宽度 < 20 时用 20（极窄屏保护）
 *  - 使用全角横线 ─ 保持视觉一致性 */
export function makeDivider(width: number): string {
  const w = Math.max(20, width)
  return "─".repeat(w)
}

export const ComposerFrame = React.memo(function ComposerFrame({ children, width }: ComposerFrameProps) {
  const divider = makeDivider(width)
  return (
    <Box flexDirection="column">
      {/* 顶部分隔线 */}
      <Text color={theme.border}>{divider}</Text>
      {/* 输入区（OrcanaComposer 或其子内容） */}
      {children}
      {/* 底部分隔线 */}
      <Text color={theme.border}>{divider}</Text>
    </Box>
  )
})
