/** RewindModal — 回退检查点时间线（Phase 7 migration）。
 *
 *  Phase 7: C.* → theme.* 全量迁移，ASCII-safe 默认。
 *  三态: list / confirm / progress。
 *  键盘由 InputContext.RewindList/RewindConfirm 处理（Phase 2 keymap）。 */

import React from "react"
import { Box, Text } from "ink"
import { theme } from "../theme/theme"
import { getGlyphTheme } from "../tokens"
import { useClock } from "../clock"
import type { TuiRewindListState, TuiRewindConfirmState, TuiRewindProgressState } from "../rewind-stubs"
import type { RewindMode } from "../../agent/rewind"

// ── RewindList（时间线列表） ──

export interface RewindListProps {
  state: TuiRewindListState
  width?: number
}

export const RewindList = React.memo(function RewindList({ state, width }: RewindListProps) {
  const w = width ?? 72
  const g = getGlyphTheme()

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.info} paddingX={1}>
      <Box flexDirection="row">
        <Text bold color={theme.info}>{g.rewindIcon} Rewind</Text>
        <Text color={theme.textFaint}> checkpoint timeline</Text>
      </Box>

      {state.entries.length === 0 && (
        <Text color={theme.textFaint}>  No checkpoints available.</Text>
      )}

      {state.entries.slice(-8).map((entry, idx) => {
        const realIdx = state.entries.length - Math.min(8, state.entries.length) + idx
        const selected = realIdx === state.selectedIndex
        const date = new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
        return (
          <Box key={entry.checkpointId} flexDirection="row">
            <Box width={3}>
              <Text color={selected ? theme.brand : theme.textFaint}>{selected ? ">" : " "}</Text>
            </Box>
            <Text color={selected ? theme.text : theme.textFaint}>
              R{entry.round} {date} {entry.fileCount}f {Math.round(entry.conversationTokens / 1000)}K {entry.summary.slice(0, 48)}
            </Text>
          </Box>
        )
      })}

      <Box flexDirection="row" marginTop={1}>
        <Text color={theme.textFaint}>Up/Down select  </Text>
        <Text color={theme.success}>Enter</Text>
        <Text color={theme.textFaint}> confirm  </Text>
        <Text color={theme.textFaint}>Esc close</Text>
      </Box>
    </Box>
  )
})

// ── RewindConfirm（确认回退范围） ──

function modeLabel(mode: RewindMode): string {
  switch (mode) {
    case "code": return "code only"
    case "conversation": return "conversation only"
    case "both": return "code + conversation"
  }
}

export interface RewindConfirmProps {
  state: TuiRewindConfirmState
  width?: number
}

export const RewindConfirm = React.memo(function RewindConfirm({ state, width }: RewindConfirmProps) {
  const w = width ?? 72
  const g = getGlyphTheme()

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.warning} paddingX={1}>
      <Box flexDirection="row">
        <Text bold color={theme.warning}>{g.rewindIcon} Confirm Rewind</Text>
        <Text color={theme.textFaint}> to round {state.targetRound}</Text>
      </Box>

      <Box flexDirection="row">
        <Text color={theme.textFaint}>scope </Text>
        <Text color={theme.text}>{modeLabel(state.mode)}</Text>
      </Box>

      <Box flexDirection="row">
        <Text color={theme.textFaint}>files </Text>
        <Text color={theme.warning}>{state.previewFiles.length} affected</Text>
      </Box>

      {state.previewFiles.length > 0 && (
        <Box flexDirection="column">
          {state.previewFiles.slice(0, 5).map((file, idx) => (
            <Text key={idx} color={theme.textFaint}>  {file}</Text>
          ))}
          {state.previewFiles.length > 5 && (
            <Text color={theme.textFaint}>  +{state.previewFiles.length - 5} more</Text>
          )}
        </Box>
      )}

      <Box flexDirection="row" marginTop={1}>
        <Text color={theme.success}>y</Text>
        <Text color={theme.textFaint}> confirm rewind  </Text>
        <Text color={theme.error}>n</Text>
        <Text color={theme.textFaint}> cancel</Text>
      </Box>
    </Box>
  )
})

// ── RewindProgress（回退执行进度） ──

export interface RewindProgressProps {
  state: TuiRewindProgressState
  width?: number
}

export const RewindProgress = React.memo(function RewindProgress({ state }: RewindProgressProps) {
  const { tick } = useClock()
  const pct = state.totalFiles > 0 ? Math.round((state.restoredFiles.length / state.totalFiles) * 100) : 0
  const barLen = 28
  const filled = Math.round((pct / 100) * barLen)
  const g = getGlyphTheme()
  const bar = g.progressFill.repeat(filled) + g.progressEmpty.repeat(barLen - filled)
  const spinner = g.spinnerChars[tick % g.spinnerLen] ?? "?"

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.info} paddingX={1}>
      <Box flexDirection="row">
        <Text color={theme.info}>{spinner} </Text>
        <Text bold color={theme.info}>Rewinding</Text>
        <Text color={theme.textFaint}> to round {state.targetRound}</Text>
      </Box>

      <Box flexDirection="row">
        <Text color={state.done ? theme.success : theme.info}>{bar}</Text>
        <Text color={theme.textFaint}> {pct}%</Text>
      </Box>

      {state.restoredFiles.length > 0 && (
        <Text color={theme.textFaint}>
          {state.restoredFiles.length}/{state.totalFiles} files restored
        </Text>
      )}

      {state.done && (
        <Box flexDirection="row" marginTop={1}>
          <Text color={theme.success}>v Rewind complete. Session restored to round {state.targetRound}.</Text>
        </Box>
      )}
    </Box>
  )
})

// ── 联合组件 ──

export type RewindModalState =
  | { phase: "list"; state: TuiRewindListState }
  | { phase: "confirm"; state: TuiRewindConfirmState }
  | { phase: "progress"; state: TuiRewindProgressState }

export interface RewindModalProps {
  modal: RewindModalState
  width?: number
}

export const RewindModal = React.memo(function RewindModal({ modal, width }: RewindModalProps) {
  switch (modal.phase) {
    case "list":
      return <RewindList state={modal.state} width={width} />
    case "confirm":
      return <RewindConfirm state={modal.state} width={width} />
    case "progress":
      return <RewindProgress state={modal.state} width={width} />
  }
})
