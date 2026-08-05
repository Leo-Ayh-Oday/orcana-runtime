/** golden — 无 ANSI 呈现文本（Depthline P5 golden 矩阵）。
 *
 *  把 TuiState 呈现为纯文本（不含颜色码），供 golden snapshot 测试：
 *    1. SessionLine（buildSessionLineFields）
 *    2. Transcript（deriveBlocks + blockToLines + 视口裁剪）
 *    3. ActivityLine（activityLineText）
 *    4. InteractionSlot（pendingQuestion / clarification）
 *    5. Overlay（runtime-inspector）
 *    6. HintBar（hintsForContext）
 *
 *  颜色不进入 golden 文本：token 映射由 theme 单测覆盖，避免终端能力抖动。
 */

import type { TuiState } from "../state/types"
import { renderSessionLine } from "../components/SessionLine"
import { emptySurfaceLines } from "../components/AppShell"
import { deriveTranscriptBlocks } from "./derive-blocks"
import { displayModeFor, EMPTY_VIEW } from "./block-model"
import { blockToLines, type BlockLine } from "../components/TranscriptViewport"
import { activityLineText } from "../components/ActivityLine"
import { selectThinkingDock } from "../thinking/selectThinkingDock"
import { hintsForContext } from "./hints"
import { formatRuntimeInspectorLines } from "../components/overlays/RuntimeInspector"
import { selectRightRail } from "../state/selectors"

export interface GoldenOptions {
  cols: number
  rows: number
  /** 固定时间（stalled 文案确定性）。 */
  now?: number
  /** overlay 呈现（inspector 场景）。 */
  overlay?: "none" | "inspector"
  /** 手动指定 HintBar 上下文（command-shelf 场景）。 */
  hintContext?: "Scrollback" | "CommandShelf"
}

export function presentState(state: TuiState, opts: GoldenOptions): string {
  const { cols, rows, now = 1_700_000_000_000, overlay = "none", hintContext } = opts
  const out: string[] = []
  const isWorking = !state.done && !state.errorLine

  // ── 1. SessionLine（双行：品牌行 + 信息行） ──
  const sessionLines = renderSessionLine({
    mode: state.mode,
    done: state.done,
    errorLine: state.errorLine,
    status: state.status,
    isWorking,
    queueCount: state.queueCount,
    provider: state.session.provider,
    modelName: state.modelName,
    branch: state.session.branch,
    repoRoot: state.session.repoRoot,
    ctxPct: state.tokens.contextMax > 0 ? Math.round((state.tokens.inputTokens / state.tokens.contextMax) * 100) : 0,
    cachePct: state.tokens.cacheHitRate !== undefined ? Math.round(state.tokens.cacheHitRate * 100) : 0,
    cols,
  })
  out.push(...sessionLines)

  // ── 2. Transcript（块化 + 视口） ──
  const blocks = deriveTranscriptBlocks(state)
  const allLines: BlockLine[] = []
  for (const block of blocks) {
    const mode = displayModeFor(EMPTY_VIEW, block)
    allLines.push(...blockToLines(block, mode, false))
    if (block.kind === "user" || block.kind === "assistant") {
      allLines.push({ marker: " ", text: "", color: "" })
    }
  }

  const sessionRows = cols >= 60 ? 2 : 1
  const chromeRows = 3 + (sessionRows - 1) // session + composer(1) + hints(1)
  const viewHeight = Math.max(4, rows - chromeRows)
  const maxOffset = Math.max(0, allLines.length - viewHeight)
  // golden 一律 auto-follow（scrollOffset = 0）
  const start = Math.max(0, allLines.length - viewHeight)
  const visible = allLines.slice(start, start + viewHeight)
  const hiddenAbove = start > 0
  const hiddenBelow = start + viewHeight < allLines.length

  const transcriptLines: string[] = []
  if (hiddenAbove) transcriptLines.push("  ↑ earlier")
  for (const line of visible) {
    const indent = line.indent ? "  ".repeat(line.indent) : ""
    transcriptLines.push(`${line.marker} ${indent}${line.text}`)
  }
  if (hiddenBelow) transcriptLines.push("  ↓ newer")
  const transcriptText = transcriptLines.join("\n")
  if (transcriptText) {
    out.push(transcriptText)
  } else if (state.messages.length === 0 && state.done) {
    // 空态：品牌面板（与 EmptySurface 一致）
    out.push(emptySurfaceLines(state.mode, state.modelName, cols).join("\n"))
  } else {
    out.push("(empty)")
  }

  // ── 3. Overlay（inspector） ──
  if (overlay === "inspector") {
    const rightRail = selectRightRail(state)
    const lines = formatRuntimeInspectorLines(rightRail, state.status, state.done, state.errorLine)
    out.push("╭─ runtime ─┐")
    for (const line of lines) out.push(`│ ${line.text}`)
    out.push("╰───────────╯")
  }

  // ── 4. ActivityLine ──
  const dock = selectThinkingDock(state, {})
  if (dock.visible && overlay !== "inspector") {
    out.push(activityLineText(dock, false, 0, now))
  }

  // ── 5. InteractionSlot ──
  if (state.pendingQuestion) {
    out.push(`? ${state.pendingQuestion.question}`)
  } else if (state.clarification) {
    const q = state.clarification.questions[state.clarification.index]
    out.push(`clarify 1/${state.clarification.questions.length} / choose one`)
    out.push(q ? `  ${q.title}` : "")
  }

  // ── 6. Composer + HintBar ──
  const divider = `╭${"─".repeat(Math.max(0, Math.min(cols - 2, 20) - 2))}╮`
  out.push(divider)
  const context = hintContext ?? (state.clarification ? "Clarification" : "Scrollback")
  const hints = hintsForContext(context, isWorking, cols)
  out.push(hints.entries.map(e => `[${e.shortcut}] ${e.label.trim()}`).join("  "))

  return out.join("\n")
}
