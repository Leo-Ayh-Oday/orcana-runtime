/** stream-trace — 开发期流输出追踪。
 *
 *  DEEPSEEK_TUI_TRACE_STREAM=1 开启，输出到 .deepseek-code/tui-stream-trace.jsonl。
 *  每轮记录：delta chunk 数、每 chunk 字符数、reducer 后累计字符数、
 *  final 时累计字符数、render 后显示字符数、是否触发 viewport trim。
 */

import { appendFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"

// ── 类型 ──

export interface StreamTraceChunk {
  index: number
  chars: number
}

export interface StreamTraceRound {
  round: number
  startTime: string
  deltaChunks: StreamTraceChunk[]
  totalDeltaChars: number
  /** reducer 中 accumulate 的最终字符数（final 事件后） */
  finalAccumulatedChars: number
  /** render 时 trimForViewport 前的原始字符数 */
  renderRawChars: number | null
  /** render 时 trimForViewport 后的显示字符数 */
  renderDisplayChars: number | null
  /** 是否触发了 viewport trim */
  viewportTrimmed: boolean | null
  /** final 时被替换的文本次数（assistant.final 非空 text） */
  finalReplaced: boolean
  endTime: string | null
}

export interface StreamTraceState {
  enabled: boolean
  dir: string
  round: number
  deltaChunks: StreamTraceChunk[]
  totalDeltaChars: number
  finalAccumulatedChars: number
  finalReplaced: boolean
}

// ── 工厂 ──

export function createStreamTrace(dir = ".deepseek-code"): StreamTraceState {
  const enabled = process.env.DEEPSEEK_TUI_TRACE_STREAM === "1"
  return {
    enabled,
    dir,
    round: 0,
    deltaChunks: [],
    totalDeltaChars: 0,
    finalAccumulatedChars: 0,
    finalReplaced: false,
  }
}

// ── 记录方法 ──

export function traceStartRound(ts: StreamTraceState, round: number): void {
  if (!ts.enabled) return
  ts.round = round
  ts.deltaChunks = []
  ts.totalDeltaChars = 0
  ts.finalAccumulatedChars = 0
  ts.finalReplaced = false
}

export function traceDeltaChunk(ts: StreamTraceState, chunk: string): void {
  if (!ts.enabled) return
  ts.deltaChunks.push({ index: ts.deltaChunks.length, chars: chunk.length })
  ts.totalDeltaChars += chunk.length
}

export function traceFinalAccumulated(ts: StreamTraceState, chars: number, replaced: boolean): void {
  if (!ts.enabled) return
  ts.finalAccumulatedChars = chars
  ts.finalReplaced = replaced
}

/** 避免频繁 fs write — 每个 chunk 只更新内存，只在 round 结束时 flush。 */
export function traceEndRound(
  ts: StreamTraceState,
  renderRawChars: number | null,
  renderDisplayChars: number | null,
  viewportTrimmed: boolean | null,
): void {
  if (!ts.enabled) return

  const record: StreamTraceRound = {
    round: ts.round,
    startTime: new Date().toISOString(),
    deltaChunks: ts.deltaChunks,
    totalDeltaChars: ts.totalDeltaChars,
    finalAccumulatedChars: ts.finalAccumulatedChars,
    renderRawChars,
    renderDisplayChars,
    viewportTrimmed,
    finalReplaced: ts.finalReplaced,
    endTime: new Date().toISOString(),
  }

  try {
    const dir = resolveTraceDir(ts.dir)
    const file = join(dir, "tui-stream-trace.jsonl")
    appendFileSync(file, JSON.stringify(record) + "\n", "utf8")
  } catch {
    // 静默失败 — trace 不应影响正常运行
  }
}

// ── 内部 ──

function resolveTraceDir(dir: string): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}
