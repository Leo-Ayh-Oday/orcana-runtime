/** format-runtime — runtime counters 格式化，供 Header/StatusBar 复用。
 *
 *  Visual Step 1: 避免 Header/StatusBar/RightRail 重复拼写同一段文本。
 *  返回 string[] 让调用方用各自的分隔符拼接。 */

import type { TuiState } from "./state/types"
import { selectEvidenceSummary, selectGateSummary } from "./state/selectors"

export interface RuntimeCounters {
  ctxPct: number
  cachePct: number
  round: number
  gatePass: number
  gateBlock: number
  gateWarn: number
  gateSkip: number
  evidencePassed: number
  evidenceFailed: number
  evidenceRunning: number
  patchProposed: number
  patchCommitted: number
  patchRolledBack: number
  activeTools: number
}

/** 从 TuiState 提取所有运行时计数器。 */
export function extractRuntimeCounters(state: TuiState): RuntimeCounters {
  const gates = selectGateSummary(state)
  const evidence = selectEvidenceSummary(state)
  const ctxPct = state.tokens.activeContextPercent !== undefined
    ? Math.max(0, Math.min(100, Math.round(state.tokens.activeContextPercent)))
    : Math.round(
        state.tokens.contextMax > 0
          ? (state.tokens.inputTokens / state.tokens.contextMax) * 100
          : 0,
      )
  return {
    ctxPct,
    cachePct: state.tokens.cacheHitRate ?? 0,
    round: state.round,
    gatePass: gates.pass,
    gateBlock: gates.block,
    gateWarn: gates.warn,
    gateSkip: gates.skip,
    evidencePassed: evidence.passed,
    evidenceFailed: evidence.failed,
    evidenceRunning: 0,
    patchProposed: state.patches.filter(p => p.status === "proposed").length,
    patchCommitted: state.patches.filter(p => p.status === "committed").length,
    patchRolledBack: state.patches.filter(p => p.status === "rolled_back").length,
    activeTools: state.tools.filter(t => t.status === "running").length,
  }
}

/** 格式化 StatusBar runtime counters 为紧凑字符串。
 *  "r3 · gates 2p/1b · evidence 1p/1f · patches 1 proposed · tools 2 · ctx 18%"
 *  无数据段不显示。blocked/failed 靠前。 */
export function formatRuntimeCounters(c: RuntimeCounters): string {
  const parts: string[] = []

  // round always (if > 0)
  if (c.round > 0) parts.push(`r${c.round}`)

  // gates — block 靠前
  if (c.gatePass + c.gateBlock + c.gateWarn + c.gateSkip > 0) {
    const segments: string[] = []
    if (c.gateBlock > 0) segments.push(`${c.gateBlock}b`)
    if (c.gatePass > 0) segments.push(`${c.gatePass}p`)
    if (c.gateWarn > 0) segments.push(`${c.gateWarn}w`)
    if (c.gateSkip > 0) segments.push(`${c.gateSkip}s`)
    parts.push(`gates ${segments.join("/")}`)
  }

  // evidence — failed 靠前
  if (c.evidencePassed + c.evidenceFailed + c.evidenceRunning > 0) {
    const segments: string[] = []
    if (c.evidenceFailed > 0) segments.push(`${c.evidenceFailed}f`)
    if (c.evidencePassed > 0) segments.push(`${c.evidencePassed}p`)
    if (c.evidenceRunning > 0) segments.push(`${c.evidenceRunning}r`)
    parts.push(`evidence ${segments.join("/")}`)
  }

  // patches
  const patchTotal = c.patchProposed + c.patchCommitted + c.patchRolledBack
  if (patchTotal > 0) {
    const segments: string[] = []
    if (c.patchProposed > 0) segments.push(`${c.patchProposed} proposed`)
    if (c.patchCommitted > 0) segments.push(`${c.patchCommitted} committed`)
    if (c.patchRolledBack > 0) segments.push(`${c.patchRolledBack} rolled back`)
    parts.push(`patches ${segments.join(" · ")}`)
  }

  // tools
  if (c.activeTools > 0) parts.push(`tools ${c.activeTools}`)

  // ctx/cache
  parts.push(`ctx ${c.ctxPct}%`)

  return parts.join(" · ")
}
