/** FooterHints — 底部键位提示（Phase 4）。
 *
 *  从 active context 派生，不硬编码。
 *  Phase 4: C.* → theme.* 迁移；窄屏砍非关键 hint。
 *
 *  早退优先级链: Confirm > Rewind* > Clarification > busy > idle
 */

import React from "react"
import { Box, Text } from "ink"
import { theme } from "../theme/theme"
import type { InputContext } from "../input/types"

export interface FooterHintsProps {
  busy: boolean
  activeContext: InputContext
  width: number
}

function KeyHint({ shortcut, label, color = theme.brand }: { shortcut: string; label: string; color?: string }) {
  return (
    <>
      <Text color={color}>{shortcut}</Text>
      <Text color={theme.textFaint}>{label}</Text>
    </>
  )
}

export const FooterHints = React.memo(function FooterHints({ busy, activeContext, width }: FooterHintsProps) {
  // ── Modal contexts: 早退，优先显示 modal 专属操作 ──

  if (activeContext === "Confirm") {
    return (
      <Box>
        <KeyHint shortcut="y" label=" approve  " color={theme.success} />
        <KeyHint shortcut="n" label=" deny  " color={theme.error} />
        <KeyHint shortcut="a" label=" deny all  " color={theme.warning} />
        <Text color={theme.textFaint}>Esc dismiss</Text>
      </Box>
    )
  }

  if (activeContext === "RewindList" || activeContext === "RewindConfirm") {
    return (
      <Box>
        <Text color={theme.textFaint}>↑↓ select  </Text>
        <KeyHint shortcut="Enter" label=" confirm  " color={theme.success} />
        <Text color={theme.textFaint}>Esc close</Text>
      </Box>
    )
  }

  if (activeContext === "Clarification") {
    return (
      <Box>
        <Text color={theme.textFaint}>↑↓ or j/k select  </Text>
        <KeyHint shortcut="Enter" label=" confirm  " color={theme.success} />
        <Text color={theme.textFaint}>Esc cancel</Text>
      </Box>
    )
  }

  // ── Composer contexts: adaptive to busy/idle/width ──

  if (busy) {
    // 极窄屏：只显示 Enter queue
    if (width < 60) {
      return (
        <Box>
          <KeyHint shortcut="Enter" label=" queue" color={theme.brand} />
        </Box>
      )
    }
    return (
      <Box>
        <KeyHint shortcut="Enter" label=" queue  " color={theme.brand} />
        <Text color={theme.textFaint}>wheel scroll  </Text>
        <KeyHint shortcut="Ctrl+C" label=" exit" color={theme.error} />
      </Box>
    )
  }

  // 闲置状态
  if (width < 60) {
    return (
      <Box>
        <KeyHint shortcut="/" label=" commands  " color={theme.brand} />
        <KeyHint shortcut="Ctrl+C" label=" exit" color={theme.error} />
      </Box>
    )
  }

  return (
    <Box>
      <KeyHint shortcut="Enter" label=" send  " color={theme.brand} />
      <KeyHint shortcut="Shift+Enter" label=" newline  " color={theme.brand} />
      <KeyHint shortcut="/" label=" commands  " color={theme.brand} />
      <KeyHint shortcut="Ctrl+R" label=" rewind  " color={theme.brand} />
      <KeyHint shortcut="Ctrl+C" label=" exit" color={theme.error} />
    </Box>
  )
})
