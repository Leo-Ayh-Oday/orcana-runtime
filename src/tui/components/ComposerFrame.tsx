/** ComposerFrame — 固定底部输入框的 frame 包装（PR-2 + Depthline P2）。
 *
 *  职责：
 *    - 输入框上方单条细线分隔（Depthline P2：删底部第二根分隔线）
 *    - 包装 OrcanaComposer，使输入框视觉上成为固定 frame
 *    - 不包含命令面板逻辑（CommandShelf 由 OrcanaComposer 内部渲染）
 *
 *  设计原则：
 *    - 分隔线使用 theme.border 色，轻量不抢眼
 *    - 分隔线宽度跟随终端宽度，窄屏保护下限 20 字符
 *    - 纯展示组件，不持有状态
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

/** 生成分隔线字符串，保护下限。 */
export function makeDivider(width: number): string {
  const w = Math.max(20, width)
  return "─".repeat(w)
}

export const ComposerFrame = React.memo(function ComposerFrame({ children, width }: ComposerFrameProps) {
  const divider = makeDivider(width)
  return (
    <Box flexDirection="column">
      {/* 单条顶部分隔线 */}
      <Text color={theme.border}>{divider}</Text>
      {children}
    </Box>
  )
})
