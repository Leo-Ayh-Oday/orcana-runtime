/** FooterHints — 底部键位提示行。
 *  显示当前可用的快捷键，帮助用户发现操作方式。 */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"

export interface FooterHintsProps {
  /** 是否处于 agent 运行中（busy 时提示排队功能） */
  busy: boolean
  /** 是否处于 clarification 模式 */
  clarifying: boolean
  /** 终端宽度 */
  width: number
}

export const FooterHints = React.memo(function FooterHints({ busy, clarifying, width }: FooterHintsProps) {
  if (clarifying) {
    return (
      <Box>
        <Text color={C.dim}>Up/Down or j/k select  Enter confirm  Esc cancel</Text>
      </Box>
    )
  }

  const hints: Array<{ key: string; desc: string }> = [
    { key: "Enter", desc: "send" },
    { key: "Shift+Enter", desc: "newline" },
    { key: "/", desc: "commands" },
    { key: "Esc", desc: "clear" },
  ]

  if (busy) {
    hints.splice(1, 0, { key: "Enter", desc: "queue msg" })
  }

  // 窄屏时减少提示数量
  const maxHints = width < 60 ? 2 : width < 80 ? 3 : hints.length
  const visible = hints.slice(0, maxHints)

  return (
    <Box>
      {visible.map((hint, index) => (
        <React.Fragment key={index}>
          {index > 0 && <Text color={C.dim}> · </Text>}
          <Text color={C.cyan}>{hint.key}</Text>
          <Text color={C.dim}> {hint.desc}</Text>
        </React.Fragment>
      ))}
    </Box>
  )
})
