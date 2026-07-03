/** StatusBar — 运行时计数器行（Phase 2 重设计 + PR-8 三态降级）。
 *
 *  宽屏 (≥96): "r2 · gates 3p/1b · evidence 2p/1f · patches 1 proposed · tools 1 · ctx 23%"
 *  窄屏 (60-95): 承接 RightRail 降级 — "ripple verify · gates 2p/1b · ctx 45%"
 *  极窄 (<60): blocked reason 必须可见，其余最小化
 *
 *  PR-8: 三态降级策略
 *    - blocked 状态在所有屏宽下必须可见（P0 优先级）
 *    - 窄屏 + blocked → "! blocked · <reason 24 chars>" 占据首段
 *    - 窄屏 + running → "ripple <phase> · gates Np/Nb · ctx N%"（已有行为）
 *    - 窄屏 + idle → 不显示 runtime 段（Header 显示 idle）
 *
 *  Phase 2: 颜色迁移到 theme.gate/evidence/patch，gate/evidence/patch 三色独立。 */

import React from "react"
import { Box, Text } from "ink"
import { theme } from "../theme/theme"
import type { RuntimeCounters } from "../format-runtime"
import type { RailState } from "./RightRail"

export interface StatusBarProps {
  counters: RuntimeCounters
  cols: number
  /** Phase 2: ripple phase（窄屏 RightRail 降级时显示） */
  ripplePhase?: string
  /** Phase 2: 是否在窄屏模式（承接 RightRail） */
  narrow?: boolean
  /** PR-8: 三态分类结果（用于窄屏降级） */
  railState?: RailState
  /** PR-8: blocked 状态下的原因（窄屏显示） */
  blockedReason?: string
}

export const StatusBar = React.memo(function StatusBar({ counters, cols, ripplePhase, narrow, railState, blockedReason }: StatusBarProps) {
  const hasGates = counters.gatePass + counters.gateBlock + counters.gateWarn + counters.gateSkip > 0
  const hasEvidence = counters.evidencePassed + counters.evidenceFailed + counters.evidenceRunning > 0
  const hasPatches = counters.patchProposed + counters.patchCommitted + counters.patchRolledBack > 0
  const hasTools = counters.activeTools > 0
  const patchTotal = counters.patchProposed + counters.patchCommitted + counters.patchRolledBack

  const segments: Array<{ text: string; color: string }> = []

  // PR-8: blocked 状态在所有屏宽下优先显示
  if (railState === "blocked") {
    const reason = blockedReason ? ` · ${blockedReason}` : ""
    segments.push({
      text: `! blocked${reason}`,
      color: theme.error,
    })
  }

  // Round
  if (counters.round > 0) {
    segments.push({ text: `r${counters.round}`, color: theme.brand })
  }

  // Ripple phase (窄屏承接 RightRail) — blocked 已单独处理，此处跳过
  if (ripplePhase && ripplePhase !== "idle" && ripplePhase !== "blocked") {
    segments.push({
      text: `ripple ${ripplePhase}`,
      color: theme.brand,
    })
  }

  // Gates — block 优先，用独立 gate 色系
  if (hasGates) {
    const parts: string[] = []
    if (counters.gateBlock > 0) parts.push(`${counters.gateBlock}b`)
    if (counters.gatePass > 0) parts.push(`${counters.gatePass}p`)
    if (counters.gateWarn > 0) parts.push(`${counters.gateWarn}w`)
    if (counters.gateSkip > 0) parts.push(`${counters.gateSkip}s`)
    segments.push({
      text: `gates ${parts.join("/")}`,
      color: counters.gateBlock > 0 ? theme.gateBlock : counters.gateWarn > 0 ? theme.gatePending : theme.gatePass,
    })
  }

  // Evidence — failed 优先，用独立 evidence 色系
  if (hasEvidence) {
    const parts: string[] = []
    if (counters.evidenceFailed > 0) parts.push(`${counters.evidenceFailed}f`)
    if (counters.evidencePassed > 0) parts.push(`${counters.evidencePassed}p`)
    if (counters.evidenceRunning > 0) parts.push(`${counters.evidenceRunning}r`)
    segments.push({
      text: `evidence ${parts.join("/")}`,
      color: counters.evidenceFailed > 0 ? theme.error : theme.evidence,
    })
  }

  // Patches — 用独立 patch 色系
  if (hasPatches) {
    const parts: string[] = []
    if (counters.patchProposed > 0) parts.push(`${counters.patchProposed} proposed`)
    if (counters.patchCommitted > 0) parts.push(`${counters.patchCommitted} committed`)
    if (counters.patchRolledBack > 0) parts.push(`${counters.patchRolledBack} rolled back`)
    segments.push({
      text: parts.join(" · "),
      color: counters.patchRolledBack > 0 ? theme.warning : theme.patch,
    })
  }

  // Tools
  if (hasTools) {
    segments.push({ text: `tools ${counters.activeTools}`, color: theme.info })
  }

  // ctx/cache — blocked 状态下也保留 ctx% （关键诊断信息）
  segments.push({
    text: `ctx ${counters.ctxPct}%`,
    color: theme.textFaint,
  })

  // 截断：极窄最多 2 段（blocked 已占 1 段），窄屏最多 5 段，宽屏不限
  // PR-8: blocked 状态下保留至少 2 段（blocked + ctx）
  const maxSegments = cols < 60 ? 2 : narrow ? 5 : segments.length
  const visible = segments.slice(0, maxSegments)

  // 如果无数据，返回空行（保持高度稳定）
  if (visible.length === 0) {
    return (
      <Box height={1}>
        <Text> </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="row" height={1}>
      {visible.map((seg, i) => (
        <React.Fragment key={i}>
          {i > 0 && <Text color={theme.textFaint}> · </Text>}
          <Text color={seg.color}>{seg.text}</Text>
        </React.Fragment>
      ))}
    </Box>
  )
})
