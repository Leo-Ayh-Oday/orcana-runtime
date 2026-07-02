/** HeaderBar — 顶部身份栏（Visual Step 2）。
 *
 *  Visual Step 2: 一行稳定身份 + 短脉冲 sonar 条。
 *  "Orcana  mode:<mode>  provider/model  state:<state>  q:<n>"
 *
 *  Sonar 行为:
 *    - idle: 静态细线 "─"
 *    - running: 低频 pulse (~•~)
 *    - blocked/error: "!" red stop marker
 *    - done: 静止，不动画
 */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import type { TuiMode } from "../state/types"
import { ModeBadge } from "./ModeContract"
import { tuiTokens } from "../tokens"

export interface HeaderBarProps {
  modelName: string
  provider?: string
  mode: TuiMode
  done: boolean
  errorLine: string
  queueCount: number
  tick: number
  cols: number
  isWorking: boolean
}

/** 状态词简化为单字：done / running / error / idle */
function stateWord(done: boolean, error: string, isWorking: boolean): string {
  if (error) return "error"
  if (done) return "done"
  if (isWorking) return "running"
  return "idle"
}

function stateColor(done: boolean, error: string, isWorking: boolean): string {
  if (error) return C.red
  if (done) return C.green
  if (isWorking) return C.cyan
  return C.dim
}

/** Short pulse bar — 20 chars wide, not spanning entire terminal. */
function SonarPulse({ tick, active, blocked }: { tick: number; active: boolean; blocked: boolean }) {
  const S = tuiTokens.motion.sonar
  const width = 20
  if (blocked) {
    const bar = S.stop + S.dot.repeat(width - 1)
    return <Text color={C.red}>{bar}</Text>
  }
  if (!active) {
    return <Text color={C.border}>{S.idle.repeat(width)}</Text>
  }
  // Running: pulse that moves
  const pos = tick % width
  const bar = S.idle.repeat(pos) + S.pulse + S.idle.repeat(Math.max(0, width - pos - 1))
  return <Text color={C.cyan}>{bar}</Text>
}

export const HeaderBar = React.memo(function HeaderBar({
  modelName,
  provider,
  mode,
  done,
  errorLine,
  queueCount,
  tick,
  cols,
  isWorking,
}: HeaderBarProps) {
  const st = stateWord(done, errorLine, isWorking)
  const stColor = stateColor(done, errorLine, isWorking)
  const blocked = st === "error"

  return (
    <Box height={2} flexDirection="column">
      <Box flexDirection="row">
        <Text bold color={C.cyan}>Orcana</Text>
        <Text color={C.dim}>  mode:</Text>
        <ModeBadge mode={mode} />
        <Text color={C.dim}>  {provider ? `${provider}/` : ""}{modelName}</Text>
        <Text color={C.dim}>  state:</Text>
        <Text color={stColor}>{st}</Text>
        {queueCount > 0 && (
          <>
            <Text color={C.dim}>  q:</Text>
            <Text color={C.cyan}>{queueCount}</Text>
          </>
        )}
      </Box>
      <SonarPulse tick={tick} active={isWorking && !blocked} blocked={blocked} />
    </Box>
  )
})
