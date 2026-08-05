/** HintBar — 底部键位提示（Depthline P3）。
 *
 *  全部内容由 ActionRegistry 派生（presentation/hints.ts），
 *  与 keymap / Ctrl+? 面板同一数据源，消除文案漂移。
 *  主表面 ≤3 动作。
 */

import React from "react"
import { Box, Text } from "ink"
import { theme } from "../theme/theme"
import type { InputContext } from "../input/types"
import { hintsForContext, type HintEntry } from "../presentation/hints"

export interface HintBarProps {
  busy: boolean
  activeContext: InputContext
  width: number
}

export const HintBar = React.memo(function HintBar({ busy, activeContext, width }: HintBarProps) {
  const model = hintsForContext(activeContext, busy, width)
  if (model.hidden) return null

  return (
    <Box>
      {model.entries.map((entry: HintEntry, index) => (
        <React.Fragment key={index}>
          {index > 0 && <Text>  </Text>}
          <Text color={theme.textFaint}>[</Text>
          <Text color={theme.brand}>{entry.shortcut}</Text>
          <Text color={theme.textFaint}>]</Text>
          <Text color={theme.textDim}> {entry.label}</Text>
        </React.Fragment>
      ))}
    </Box>
  )
})
