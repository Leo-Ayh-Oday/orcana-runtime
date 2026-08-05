/** HintBar — 底部键位提示（Depthline P2，替代 FooterHints）。
 *
 *  P3 起 HintBar 从 ActionRegistry 统一派生（≤3 动作）。
 *  P2 过渡：modal 上下文沿用静态文案，主表面使用注册表动作。
 */

import React from "react"
import { Box, Text } from "ink"
import { theme } from "../theme/theme"
import type { InputContext } from "../input/types"
import { findAction } from "../presentation/actions"

export interface HintBarProps {
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

export const HintBar = React.memo(function HintBar({ busy, activeContext, width }: HintBarProps) {
  // ── Modal 上下文：早退 ──

  if (activeContext === "Confirm") {
    return (
      <Box>
        <KeyHint shortcut="1" label=" approve once  " color={theme.success} />
        <KeyHint shortcut="2" label=" approve session  " color={theme.success} />
        <KeyHint shortcut="3" label=" deny" color={theme.error} />
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

  if (activeContext === "RuntimeDialog") {
    return (
      <Box>
        <Text color={theme.textFaint}>↑↓ select  </Text>
        <KeyHint shortcut="Enter" label=" confirm  " color={theme.success} />
        <Text color={theme.textFaint}>type search/key  Esc close</Text>
      </Box>
    )
  }

  if (activeContext === "CommandShelf") {
    return (
      <Box>
        <Text color={theme.textFaint}>↑↓ select  </Text>
        <KeyHint shortcut="Enter" label=" run  " color={theme.brand} />
        <Text color={theme.textFaint}>{width < 60 ? "Esc close" : "Tab insert  ·  Esc close"}</Text>
      </Box>
    )
  }

  // ── 主表面：≤3 动作 ──
  const runtimeLabel = findAction("runtime.open")?.label ?? "activity"

  if (busy) {
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
        <KeyHint shortcut="Esc" label=" stop  " color={theme.error} />
        <KeyHint shortcut="Ctrl+T" label={` ${runtimeLabel}`} color={theme.brand} />
      </Box>
    )
  }

  // idle
  if (width < 60) {
    return (
      <Box>
        <KeyHint shortcut="Enter" label=" send  " color={theme.brand} />
        <KeyHint shortcut="/" label=" commands" color={theme.brand} />
      </Box>
    )
  }
  return (
    <Box>
      <KeyHint shortcut="Enter" label=" send  " color={theme.brand} />
      <KeyHint shortcut="/" label=" commands  " color={theme.brand} />
      <KeyHint shortcut="?" label=" shortcuts" color={theme.brand} />
    </Box>
  )
})
