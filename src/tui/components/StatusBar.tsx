/** StatusBar — 运行时计数器行（Visual Step 2）。
 *
 *  Visual Step 2: 单一 formatRuntimeCounters 驱动，不再有 16 个独立 prop。
 *  "r3 · gates 2p/1b · evidence 1p/1f · patches 1 proposed · tools 2 · ctx 18%"
 *
 *  规则：
 *    - 无数据不显示该段（formatRuntimeCounters 内部处理）
 *    - blocked/failed 优先并高亮
 *    - 窄屏自动减少段数
 */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import type { RuntimeCounters } from "../format-runtime"

export interface StatusBarProps {
  counters: RuntimeCounters
  cols: number
}

export const StatusBar = React.memo(function StatusBar({ counters, cols }: StatusBarProps) {
  const hasGates = counters.gatePass + counters.gateBlock + counters.gateWarn + counters.gateSkip > 0
  const hasEvidence = counters.evidencePassed + counters.evidenceFailed + counters.evidenceRunning > 0
  const hasPatches = counters.patchProposed + counters.patchCommitted + counters.patchRolledBack > 0

  const segments: Array<{ text: string; color: string }> = []

  // Round
  if (counters.round > 0) {
    segments.push({ text: `r${counters.round}`, color: C.cyan })
  }

  // Gates — block 优先
  if (hasGates) {
    const parts: string[] = []
    if (counters.gateBlock > 0) parts.push(`${counters.gateBlock}b`)
    if (counters.gatePass > 0) parts.push(`${counters.gatePass}p`)
    if (counters.gateWarn > 0) parts.push(`${counters.gateWarn}w`)
    if (counters.gateSkip > 0) parts.push(`${counters.gateSkip}s`)
    segments.push({
      text: `gates ${parts.join("/")}`,
      color: counters.gateBlock > 0 ? C.red : counters.gateWarn > 0 ? C.yellow : C.green,
    })
  }

  // Evidence — failed 优先
  if (hasEvidence) {
    const parts: string[] = []
    if (counters.evidenceFailed > 0) parts.push(`${counters.evidenceFailed}f`)
    if (counters.evidencePassed > 0) parts.push(`${counters.evidencePassed}p`)
    if (counters.evidenceRunning > 0) parts.push(`${counters.evidenceRunning}r`)
    segments.push({
      text: `evidence ${parts.join("/")}`,
      color: counters.evidenceFailed > 0 ? C.red : C.green,
    })
  }

  // Patches
  if (hasPatches) {
    const parts: string[] = []
    if (counters.patchProposed > 0) parts.push(`${counters.patchProposed} proposed`)
    if (counters.patchCommitted > 0) parts.push(`${counters.patchCommitted} committed`)
    if (counters.patchRolledBack > 0) parts.push(`${counters.patchRolledBack} rolled back`)
    segments.push({
      text: parts.join(" · "),
      color: counters.patchRolledBack > 0 ? C.yellow : C.dim,
    })
  }

  // Tools
  if (counters.activeTools > 0) {
    segments.push({ text: `tools ${counters.activeTools}`, color: C.cyan })
  }

  // ctx/cache
  segments.push({
    text: `ctx ${counters.cachePct >= 0 ? `${counters.ctxPct}%` : `${counters.ctxPct}%`}`,
    color: C.dim,
  })

  // Narrow screen: drop low-priority segments
  const maxSegments = cols < 80 ? 3 : cols < 100 ? 5 : segments.length
  const visible = segments.slice(0, maxSegments)

  return (
    <Box flexDirection="row">
      {visible.map((seg, i) => (
        <React.Fragment key={i}>
          {i > 0 && <Text color={C.dim}> · </Text>}
          <Text color={seg.color}>{seg.text}</Text>
        </React.Fragment>
      ))}
    </Box>
  )
})
