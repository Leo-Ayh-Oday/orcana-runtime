/** FooterHints — 底部键位提示（Visual Step 5）。
 *
 *  Visual Step 5: 从 active context 派生，简化文案。
 *    - Composer: Enter send · Shift+Enter newline · / commands · Ctrl+C exit
 *    - Busy:     Enter queue · wheel scroll
 *    - Confirm:  y approve · n deny · a deny all · Esc dismiss
 *    - Rewind:   ↑↓ select · Enter confirm · Esc close
 *    - Clarification: ↑↓ or j/k select · Enter confirm · Esc cancel
 */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import type { InputContext } from "../input/types"

export interface FooterHintsProps {
  busy: boolean
  activeContext: InputContext
  width: number
}

export const FooterHints = React.memo(function FooterHints({ busy, activeContext, width }: FooterHintsProps) {
  // Modal contexts
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
  if (activeContext === "RewindList" || activeContext === "RewindConfirm") {
    return (
      <Box>
        <Text color={C.dim}>↑↓ select  </Text>
        <Text color={C.green}>Enter</Text><Text color={C.dim}> confirm  </Text>
        <Text color={C.dim}>Esc close</Text>
      </Box>
    )
  }
  if (activeContext === "Clarification") {
    return (
      <Box>
        <Text color={C.dim}>↑↓ or j/k select  </Text>
        <Text color={C.green}>Enter</Text><Text color={C.dim}> confirm  </Text>
        <Text color={C.dim}>Esc cancel</Text>
      </Box>
    )
  }

  // Composer hints — adaptive to busy/idle
  if (busy) {
    const hints = width < 60
      ? <><Text color={C.cyan}>Enter</Text><Text color={C.dim}> queue</Text></>
      : <><Text color={C.cyan}>Enter</Text><Text color={C.dim}> queue  </Text><Text color={C.dim}>wheel scroll  </Text><Text color={C.cyan}>Ctrl+C</Text><Text color={C.dim}> exit</Text></>
    return <Box>{hints}</Box>
  }

  return (
    <Box>
      <Text color={C.cyan}>Enter</Text><Text color={C.dim}> send  </Text>
      <Text color={C.cyan}>Shift+Enter</Text><Text color={C.dim}> newline  </Text>
      <Text color={C.cyan}>/</Text><Text color={C.dim}> commands  </Text>
      <Text color={C.cyan}>Ctrl+C</Text><Text color={C.dim}> exit</Text>
    </Box>
  )
})
