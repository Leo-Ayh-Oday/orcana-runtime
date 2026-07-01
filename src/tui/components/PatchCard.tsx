/** PatchCard — 渲染补丁提案卡片。
 *  显示：Patch proposed {txId} + 文件路径 + 状态
 *  默认折叠，只显示 summary 行。 */

import React from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import type { TuiPatchEvent } from "../state/types"

export interface PatchCardProps {
  patch: TuiPatchEvent
  width: number
  expanded?: boolean
}

function statusColor(status: TuiPatchEvent["status"]): string {
  switch (status) {
    case "proposed": return C.yellow
    case "committed": return C.green
    case "rolled_back": return C.dim
  }
}

function statusLabel(status: TuiPatchEvent["status"]): string {
  switch (status) {
    case "proposed": return "proposed"
    case "committed": return "committed"
    case "rolled_back": return "rolled back"
  }
}

export const PatchCard = React.memo(function PatchCard({ patch, expanded = false }: PatchCardProps) {
  const color = statusColor(patch.status)
  const fileCount = patch.files.length

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={color}>◆ </Text>
        <Text color={C.white}>Patch {statusLabel(patch.status)}</Text>
        <Text color={C.dim}> {patch.txId}</Text>
      </Box>
      {fileCount === 1 ? (
        <Text color={C.dim}>  {patch.files[0]}</Text>
      ) : fileCount > 1 ? (
        <Text color={C.dim}>  {fileCount} files</Text>
      ) : null}
      {patch.summary && (
        <Text color={C.dim}>  {patch.summary}</Text>
      )}
      {expanded && patch.reason && (
        <Text color={C.dim}>  reason: {patch.reason}</Text>
      )}
    </Box>
  )
})
