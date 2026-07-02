/** RewindModal — 回退检查点时间线（Phase 5）。
 *
 *  三态：
 *    1. list — 时间线列表，↑↓ 选择，Enter 进入确认
 *    2. confirm — 确认回退范围（code / conversation / both），预览受影响文件
 *    3. progress — 回退执行中，显示进度动画
 *
 *  键盘由 InputContext.RewindList/RewindConfirm 处理（Phase 2 keymap）。 */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import { getGlyphTheme } from "../tokens"
import type { TuiRewindEntry, TuiRewindListState, TuiRewindConfirmState, TuiRewindProgressState } from "../rewind-stubs"
import type { RewindMode } from "../../agent/rewind"

// ── RewindList（时间线列表） ──

export interface RewindListProps {
  state: TuiRewindListState
  width?: number
}

export const RewindList = React.memo(function RewindList({ state, width }: RewindListProps) {
  const w = width ?? 72

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={C.cyan} paddingX={1}>
      <Box flexDirection="row">
        <Text bold color={C.cyan}>{getGlyphTheme().rewindIcon} Rewind</Text>
        <Text color={C.dim}> checkpoint timeline</Text>
      </Box>

      {state.entries.length === 0 && (
        <Text color={C.dim}>  No checkpoints available.</Text>
      )}

      {state.entries.slice(-8).map((entry, idx) => {
        const realIdx = state.entries.length - Math.min(8, state.entries.length) + idx
        const selected = realIdx === state.selectedIndex
        const date = new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
        return (
          <Box key={entry.checkpointId} flexDirection="row">
            <Box width={3}>
              <Text color={selected ? C.cyan : C.dim}>{selected ? ">" : " "}</Text>
            </Box>
            <Text color={selected ? C.white : C.dim}>
              R{entry.round} {date} {entry.fileCount}f {Math.round(entry.conversationTokens / 1000)}K {entry.summary.slice(0, 48)}
            </Text>
          </Box>
        )
      })}

      <Box flexDirection="row" marginTop={1}>
        <Text color={C.dim}>↑↓ select  </Text>
        <Text color={C.green}>Enter</Text>
        <Text color={C.dim}> confirm  </Text>
        <Text color={C.dim}>Esc close</Text>
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

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={C.yellow} paddingX={1}>
      <Box flexDirection="row">
        <Text bold color={C.yellow}>⟲ Confirm Rewind</Text>
        <Text color={C.dim}> to round {state.targetRound}</Text>
      </Box>

      <Box flexDirection="row">
        <Text color={C.dim}>scope </Text>
        <Text color={C.white}>{modeLabel(state.mode)}</Text>
      </Box>

      <Box flexDirection="row">
        <Text color={C.dim}>files </Text>
        <Text color={C.yellow}>{state.previewFiles.length} affected</Text>
      </Box>

      {state.previewFiles.length > 0 && (
        <Box flexDirection="column">
          {state.previewFiles.slice(0, 5).map((file, idx) => (
            <Text key={idx} color={C.dim}>  {file}</Text>
          ))}
          {state.previewFiles.length > 5 && (
            <Text color={C.dim}>  +{state.previewFiles.length - 5} more</Text>
          )}
        </Box>
      )}

      <Box flexDirection="row" marginTop={1}>
        <Text color={C.green}>y</Text>
        <Text color={C.dim}> confirm rewind  </Text>
        <Text color={C.red}>n</Text>
        <Text color={C.dim}> cancel</Text>
      </Box>
    </Box>
  )
})

// ── RewindProgress（回退执行进度） ──

export interface RewindProgressProps {
  state: TuiRewindProgressState
  tick: number
  width?: number
}

export const RewindProgress = React.memo(function RewindProgress({ state, tick }: RewindProgressProps) {
  const pct = state.totalFiles > 0 ? Math.round((state.restoredFiles.length / state.totalFiles) * 100) : 0
  const barLen = 28
  const filled = Math.round((pct / 100) * barLen)
  const bar = "█".repeat(filled) + "░".repeat(barLen - filled)
  const g = getGlyphTheme()
  const spinner = g.spinnerChars[tick % g.spinnerLen] ?? "?"

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={C.cyan} paddingX={1}>
      <Box flexDirection="row">
        <Text color={C.cyan}>{spinner} </Text>
        <Text bold color={C.cyan}>Rewinding</Text>
        <Text color={C.dim}> to round {state.targetRound}</Text>
      </Box>

      <Box flexDirection="row">
        <Text color={state.done ? C.green : C.cyan}>{bar}</Text>
        <Text color={C.dim}> {pct}%</Text>
      </Box>

      {state.restoredFiles.length > 0 && (
        <Text color={C.dim}>
          {state.restoredFiles.length}/{state.totalFiles} files restored
        </Text>
      )}

      {state.done && (
        <Box flexDirection="row" marginTop={1}>
          <Text color={C.green}>✓ Rewind complete. Session restored to round {state.targetRound}.</Text>
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
  tick: number
  width?: number
}

export const RewindModal = React.memo(function RewindModal({ modal, tick, width }: RewindModalProps) {
  switch (modal.phase) {
    case "list":
      return <RewindList state={modal.state} width={width} />
    case "confirm":
      return <RewindConfirm state={modal.state} width={width} />
    case "progress":
      return <RewindProgress state={modal.state} tick={tick} width={width} />
  }
})
