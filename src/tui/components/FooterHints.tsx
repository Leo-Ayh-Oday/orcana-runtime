/** FooterHints — 底部键位提示（Phase 4 + PR-2 + PR-5 升级）。
 *
 *  PR-2: 根据 context 切换三组 hint：
 *    - normal:  Enter send · Shift+Enter newline · / commands · Ctrl+C exit
 *    - command: ↑/↓ select · Enter run · Tab insert · Esc close
 *    - running: Enter queue · Ctrl+C exit
 *
 *  PR-5: command 模式由 InputContext === "CommandShelf" 驱动（不再用独立 commandOpen prop）。
 *  早退优先级链: Confirm > Rewind* > Clarification > CommandShelf > running > normal
 *
 *  Phase 4: C.* → theme.* 迁移；窄屏砍非关键 hint。
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

  // ── PR-5: CommandShelf context — 命令菜单打开时 ──
  if (activeContext === "CommandShelf") {
    if (width < 60) {
      return (
        <Box>
          <Text color={theme.textFaint}>↑↓ select  </Text>
          <KeyHint shortcut="Enter" label=" run" color={theme.brand} />
          <Text color={theme.textFaint}>  Esc close</Text>
        </Box>
      )
    }
    return (
      <Box>
        <Text color={theme.textFaint}>↑/↓ select  </Text>
        <KeyHint shortcut="Enter" label=" run  " color={theme.brand} />
        <KeyHint shortcut="Tab" label=" insert  " color={theme.brand} />
        <Text color={theme.textFaint}>Esc close</Text>
      </Box>
    )
  }

  // ── running 模式 ──
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

  // ── normal 模式（闲置） ──
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
