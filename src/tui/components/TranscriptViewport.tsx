/** TranscriptViewport — 块化转录视口（Depthline P4，替代 Scrollback 渲染路径）。
 *
 *  - 每块按显示模式（collapsed/truncated/expanded）展平为行
 *  - 行级缓存（按 block id + 模式 + 文本签名 + 宽度），流式只重算变化的块
 *  - 沿用 Scrollback 的视口数学（maxOffset / auto-follow / adjustScrollOffsetForGrowth）
 *  - 折叠标记：▸ collapsed / ▾ expanded（ASCII 主题用 +/-）
 */

import React, { useEffect, useMemo, useRef } from "react"
import { Box, Text } from "ink"
import { C } from "../theme/theme"
import { theme } from "../theme/theme"
import { getGlyphTheme } from "../tokens"
import type { TranscriptBlock, TranscriptViewState, BlockDisplayMode } from "../presentation/block-model"
import { displayModeFor } from "../presentation/block-model"
import { reduceTranscriptViewState, type TranscriptViewAction } from "../presentation/block-view-state"
import { transcriptTextSignature } from "../presentation/derive-blocks"
import { adjustScrollOffsetForGrowth, type ScrollbackScrollState } from "./Scrollback"
import { renderMetrics } from "../render-metrics"

// ── 块 → 行 ──

export interface BlockLine {
  marker: string
  text: string
  color: string
  indent?: number
  /** 选中块的摘要行（高亮）。 */
  selected?: boolean
}

function blockMarker(kind: TranscriptBlock["kind"], mode: BlockDisplayMode, lifecycle: string): string {
  const g = getGlyphTheme()
  switch (kind) {
    case "user":
      return g.markerUser
    case "assistant":
      return lifecycle === "error" ? g.markerError : g.markerAssistant
    case "tool-group":
    case "plan":
    case "execution-summary":
    case "task":
      return mode === "expanded" ? g.collapseOpen : g.collapseClosed
    default:
      return lifecycle === "error" ? g.markerError : g.markerActivity
  }
}

function blockColor(kind: TranscriptBlock["kind"], lifecycle: string): string {
  switch (kind) {
    case "user": return theme.userMessage
    case "assistant": return lifecycle === "error" ? theme.error : theme.assistantMessage
    case "tool-group": return lifecycle === "running" ? theme.brand : theme.eventTool
    case "plan": return theme.eventPlan
    case "execution-summary": return theme.textDim
    case "task": return lifecycle === "running" ? theme.brand : theme.eventTask
    default: return lifecycle === "error" ? theme.error : theme.textFaint
  }
}

/** 纯函数：块 → 行（mode 决定 summary/details 取舍）。 */
export function blockToLines(block: TranscriptBlock, mode: BlockDisplayMode, selected: boolean): BlockLine[] {
  const marker = blockMarker(block.kind, mode, block.lifecycle)
  const color = blockColor(block.kind, block.lifecycle)
  const lines: BlockLine[] = []

  const summaryLines = block.summary.length > 0 ? block.summary : [""]
  summaryLines.forEach((text, index) => {
    lines.push({ marker: index === 0 ? marker : " ", text, color, selected })
  })

  if (mode === "expanded" && block.details.length > 0) {
    for (const text of block.details) {
      lines.push({ marker: " ", text, color: C.dim, indent: 1 })
    }
  } else if (mode === "truncated" && block.details.length > 0) {
    // truncated：摘要 + 前 2 条详情
    for (const text of block.details.slice(0, 2)) {
      lines.push({ marker: " ", text, color: C.dim, indent: 1 })
    }
    if (block.details.length > 2) {
      lines.push({ marker: " ", text: `… +${block.details.length - 2} more (Enter to expand)`, color: C.fog, indent: 1 })
    }
  }

  return lines
}

// ── 行级缓存 ──

export interface CachedBlockEntry {
  key: string
  lines: BlockLine[]
}

export class BlockLineCache {
  private cache = new Map<string, CachedBlockEntry>()
  private prevWidth = 0

  getOrCompute(block: TranscriptBlock, mode: BlockDisplayMode, width: number, selected: boolean): BlockLine[] {
    if (this.prevWidth !== 0 && this.prevWidth !== width) {
      this.cache.clear()
    }
    this.prevWidth = width

    const textSig = transcriptTextSignature([block])
    const key = `${block.id}:${mode}:${textSig}:${width}:${selected ? "sel" : "nosel"}`
    const hit = this.cache.get(block.id)
    if (hit?.key === key) return hit.lines

    const lines = blockToLines(block, mode, selected)
    this.cache.set(block.id, { key, lines })
    renderMetrics.incMessageFormat()
    return lines
  }

  evictStale(blocks: readonly TranscriptBlock[]): void {
    const liveIds = new Set(blocks.map(b => b.id))
    for (const id of this.cache.keys()) {
      if (!liveIds.has(id)) this.cache.delete(id)
    }
  }

  clear(): void {
    this.cache.clear()
  }

  stats(): { size: number; width: number } {
    return { size: this.cache.size, width: this.prevWidth }
  }
}

// ── 主组件 ──

export interface TranscriptViewportProps {
  blocks: readonly TranscriptBlock[]
  view: TranscriptViewState
  onView: (action: TranscriptViewAction) => void
  width: number
  height: number
  scrollOffset: number
  onScrollState?: (state: ScrollbackScrollState) => void
}

export function buildViewportLines(
  cache: BlockLineCache,
  blocks: readonly TranscriptBlock[],
  view: TranscriptViewState,
  width: number,
): BlockLine[] {
  const all: BlockLine[] = []
  for (const block of blocks) {
    const mode = displayModeFor(view, block)
    const selected = view.selectedBlockId === block.id
    const lines = cache.getOrCompute(block, mode, width, selected)
    all.push(...lines)
    // 块间空一行（用户/正文块后；工具组间不空行）
    if (block.kind === "user" || block.kind === "assistant") {
      all.push({ marker: " ", text: "", color: C.dim })
    }
  }
  cache.evictStale(blocks)
  return all
}

export const TranscriptViewport = React.memo(function TranscriptViewport({
  blocks,
  view,
  onView,
  width,
  height,
  scrollOffset,
  onScrollState,
}: TranscriptViewportProps) {
  const cacheRef = useRef<BlockLineCache>(new BlockLineCache())

  // 派生后清理已删除块的视图状态（prune）
  useEffect(() => {
    onView({ type: "block.prune", liveIds: new Set(blocks.map(b => b.id)) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks])

  const allLines = useMemo(
    () => buildViewportLines(cacheRef.current, blocks, view, width),
    [blocks, view, width],
  )

  const maxOffset = Math.max(0, allLines.length - height)
  const normalizedOffset = Math.max(0, Math.min(scrollOffset, maxOffset))
  const start = Math.max(0, allLines.length - height - normalizedOffset)
  const visibleLines = allLines.slice(start, start + height)
  const hiddenAbove = start > 0
  const hiddenBelow = start + height < allLines.length

  useEffect(() => {
    onScrollState?.({ maxOffset, normalizedOffset, hiddenAbove, hiddenBelow })
  }, [hiddenAbove, hiddenBelow, maxOffset, normalizedOffset, onScrollState])

  renderMetrics.incTranscriptRender()

  if (blocks.length === 0) return null

  const gutter = 3
  return (
    <Box flexDirection="column">
      {hiddenAbove && <Text color={C.dim}>  ↑ earlier</Text>}
      {visibleLines.slice(
        hiddenAbove ? 1 : 0,
        hiddenBelow ? Math.max(0, visibleLines.length - 1) : visibleLines.length,
      ).map((line, index) => (
        <Box key={`${start}-${index}`} flexDirection="row">
          <Box width={gutter}>
            <Text color={line.selected ? theme.brand : line.color}>{line.marker}</Text>
          </Box>
          <Text color={line.selected ? theme.brand : line.color === C.red ? C.red : C.white}>
            {line.indent ? "  ".repeat(line.indent) : ""}{line.text}
          </Text>
        </Box>
      ))}
      {hiddenBelow && <Text color={C.dim}>  ↓ newer</Text>}
    </Box>
  )
})

export { reduceTranscriptViewState }
