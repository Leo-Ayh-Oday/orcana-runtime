import React from "react"
import { Box, Text } from "ink"
import { theme } from "../theme/theme"
import { palette } from "../theme/palette"
import type { SlashCommandHint, CommandKind } from "../input"
import type { ScoredCommand } from "../commands/score"

export function commandKindColor(_kind: CommandKind | undefined, enabled: boolean = true): string {
  if (enabled === false) return palette.fog
  return theme.text
}

export interface CommandShelfProps {
  matches: ReadonlyArray<ScoredCommand<SlashCommandHint>>
  selectedIndex: number
  windowSize?: number
  width?: number
}

export function commandShelfWindowStart(selectedIndex: number, total: number, windowSize: number): number {
  if (total <= 0) return 0
  const size = Math.max(1, windowSize)
  if (total <= size) return 0
  const safeSelected = Math.max(0, Math.min(selectedIndex, total - 1))
  const centered = safeSelected - Math.floor(size / 2)
  return Math.max(0, Math.min(centered, total - size))
}

export function commandShelfRows(total: number, windowSize: number): number {
  if (total <= 0) return 1
  const visible = Math.min(total, Math.max(1, windowSize))
  return visible + (total > visible ? 1 : 0)
}

export function CommandShelf({ matches, selectedIndex, windowSize = 7, width = 80 }: CommandShelfProps) {
  if (matches.length === 0) {
    return (
      <Box flexDirection="column" marginBottom={1} marginLeft={2}>
        <Text color={theme.textFaint}>No matching command</Text>
      </Box>
    )
  }

  const maxDescWidth = Math.max(20, width - 30)
  const safeSelectedIndex = Math.max(0, Math.min(selectedIndex, matches.length - 1))
  const start = commandShelfWindowStart(safeSelectedIndex, matches.length, windowSize)
  const end = Math.min(matches.length, start + Math.max(1, windowSize))
  const visibleMatches = matches.slice(start, end)
  const hasOverflow = matches.length > visibleMatches.length

  return (
    <Box flexDirection="column" marginBottom={1} marginLeft={2}>
      {visibleMatches.map((m, index) => {
        const absoluteIndex = start + index
        const selected = absoluteIndex === safeSelectedIndex
        const cmd = m.command
        const isEnabled = cmd.enabled !== false
        const displayCmd = cmd.displayName ?? cmd.name
        const nameColor = commandKindColor(cmd.kind, isEnabled)
        const renderedNameColor = selected && isEnabled ? theme.brand : nameColor
        const desc =
          cmd.description.length > maxDescWidth
            ? `${cmd.description.slice(0, maxDescWidth - 1)}...`
            : cmd.description

        return (
          <Box key={cmd.name} flexDirection="row">
            <Text color={selected ? theme.brand : theme.textFaint}>
              {selected ? ">" : " "}{" "}
            </Text>
            <Text color={renderedNameColor}>/{displayCmd}</Text>
            <Text color={theme.textFaint}> {desc}</Text>
            {isEnabled === false && cmd.disabledReason && (
              <Text color={theme.textFaint}> ({cmd.disabledReason})</Text>
            )}
          </Box>
        )
      })}
      {hasOverflow && (
        <Text color={theme.textFaint}>
          {start > 0 ? `${start} above` : ""}
          {start > 0 && end < matches.length ? " / " : ""}
          {end < matches.length ? `${matches.length - end} below` : ""}
        </Text>
      )}
    </Box>
  )
}
