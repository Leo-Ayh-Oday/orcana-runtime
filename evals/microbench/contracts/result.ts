/** ORMB 结果契约 — 每个用例 + 整体报告的结构。
 *
 *  ORMB 原则：结果必须详细到能精确定位问题。每条断言带 label/detail，
 *  每个用例带完整事件 trace（text 截断），报告保留 commit / model / usage /
 *  seed / digest。
 */

import type { HardGateName } from "./metrics"
import type { MBEAssertion } from "./case"

/** 运行 header — 每次运行固定（可复现）。 */
export interface MBEHdr {
  suite: string
  orcanaCommit: string
  modelRequested: string
  reasoningEffort?: string
  seed: number
  configurationDigest: string
  startedAt: string
}

/** 精简事件流条目 — text 截断防爆量，保留 type 序列与关键载荷。 */
export interface TraceEntry {
  type: string
  data?: unknown
  seq: number
}

export interface MBECaseResult {
  caseId: string
  title: string
  tags: string[]
  passed: boolean
  assertions: MBEAssertion[]
  failures: string[]
  trace: TraceEntry[]
  /** provider stream 调用次数（重试会 +1）。 */
  calls: number
  retries: number
  sleepsMs: number[]
  durationMs: number
  usage?: Record<string, unknown>
  modelRequested?: string
  modelActual?: string
  error?: string
}

export interface MBEReport {
  header: MBEHdr
  suite: string
  cases: MBECaseResult[]
  /** gate → 失败用例数。全 0 才通过 Hard Gate。 */
  hardGates: Partial<Record<HardGateName, number>>
  summary: { total: number; passed: number; failed: number; passRate: number }
  generatedAt: string
}

/** 把任意载荷压成可打印的短文本（报告用）。 */
export function summarize(data: unknown, maxLen = 160): string {
  if (typeof data === "string") return data.length > maxLen ? data.slice(0, maxLen) + "…" : data
  try {
    const s = JSON.stringify(data)
    return s.length > maxLen ? s.slice(0, maxLen) + "…" : s
  } catch {
    return String(data)
  }
}
