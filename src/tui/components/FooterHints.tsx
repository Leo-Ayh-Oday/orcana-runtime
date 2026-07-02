/** FooterHints — 底部键位提示行。
 *  从 active InputContext 派生可用快捷键，帮助用户发现操作方式。
 *  Phase 2: 用 InputContext 替代 clarifying boolean，使提示与键位上下文一致。 */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import type { InputContext } from "../input/types"

export interface FooterHintsProps {
  /** 是否处于 agent 运行中（busy 时提示排队功能） */
  busy: boolean
  /** 当前激活的键盘上下文（决定显示哪些键位提示） */
  activeContext: InputContext
  /** 终端宽度 */
  width: number
}

export const FooterHints = React.memo(function FooterHints({ busy, activeContext, width }: FooterHintsProps) {
  // Phase 5: modal contexts have their own hints
  if (activeContext === "Confirm") {
    return (
      <Box>
        <Text color={C.green}>y</Text><Text color={C.dim}> approve  </Text>
        <Text color={C.red}>n</Text><Text color={C.dim}> deny  </Text>
        <Text color={C.yellow}>a</Text><Text color={C.dim}> deny all  </Text>
        <Text color={C.dim}>Esc dismiss</Text>
      </Box>
    )
  }

  if (activeContext === "RewindList") {
    return (
      <Box>
        <Text color={C.dim}>↑↓ select  </Text>
        <Text color={C.green}>Enter</Text>
        <Text color={C.dim}> confirm  </Text>
        <Text color={C.dim}>Esc close</Text>
      </Box>
    )
  }

  if (activeContext === "RewindConfirm") {
    return (
      <Box>
        <Text color={C.green}>y</Text>
        <Text color={C.dim}> confirm rewind  </Text>
        <Text color={C.red}>n</Text>
        <Text color={C.dim}> / Esc cancel</Text>
      </Box>
    )
  }

  // Phase 2: Clarification context
  if (activeContext === "Clarification") {
    return (
      <Box>
        <Text color={C.dim}>↑/↓ or j/k select  Enter confirm  Esc cancel</Text>
      </Box>
    )
  }

  const hints: Array<{ key: string; desc: string }> = [
    { key: "Enter", desc: "send" },
    { key: "Shift+Enter", desc: "newline" },
    { key: "wheel", desc: "scroll" },
    { key: "/", desc: "commands" },
    { key: "Ctrl+C", desc: "exit" },
  ]

  if (busy) {
    hints.splice(1, 0, { key: "Enter", desc: "queue msg" })
  }

  // 窄屏时减少提示数量
  const maxHints = width < 60 ? 2 : width < 80 ? 4 : hints.length
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
