import type { ToolResult } from "../tools/registry"

export interface ToolLedgerEntry {
  id: string
  round: number
  tool: string
  startedAt: number
  durationMs: number
  success: boolean
  blocked: boolean
  /** True when the tool was interrupted by run abort before full post-processing. */
  aborted: boolean
  changedFiles: string[]
  gate?: string
  gateStatus?: string
  error?: string
}

export class ToolExecutionLedger {
  private entries: ToolLedgerEntry[] = []

  record(input: {
    id: string
    round: number
    tool: string
    startedAt: number
    result: ToolResult | { success: boolean; content: string; metadata?: Record<string, unknown> }
    changedFiles?: string[]
  }): ToolLedgerEntry {
    const metadata = input.result.metadata ?? {}
    const gate = typeof metadata.gate === "string" ? metadata.gate : undefined
    const gateDetail = gate && metadata[gate] && typeof metadata[gate] === "object"
      ? metadata[gate] as Record<string, unknown>
      : undefined
    const entry: ToolLedgerEntry = {
      id: input.id,
      round: input.round,
      tool: input.tool,
      startedAt: input.startedAt,
      durationMs: Math.max(0, Date.now() - input.startedAt),
      success: input.result.success,
      blocked: Boolean(metadata.blocked || metadata.hookBlocked || /\[blocked\]/i.test(input.result.content)),
      aborted: Boolean(metadata.aborted),
      changedFiles: [...new Set(input.changedFiles ?? [])],
      gate,
      gateStatus: typeof gateDetail?.status === "string" ? gateDetail.status : undefined,
      error: input.result.success ? undefined : input.result.content.slice(0, 300),
    }
    this.entries.push(entry)
    return entry
  }

  snapshot(): ToolLedgerEntry[] {
    return this.entries.map(entry => ({ ...entry, changedFiles: [...entry.changedFiles] }))
  }

  failedCount(): number {
    return this.entries.filter(entry => !entry.success).length
  }

  blockedCount(): number {
    return this.entries.filter(entry => entry.blocked).length
  }

  changedFiles(): string[] {
    return [...new Set(this.entries.flatMap(entry => entry.changedFiles))]
  }
}

export function formatToolLedgerStatus(entry: ToolLedgerEntry): string {
  const state = entry.blocked ? "blocked" : entry.success ? "ok" : "fail"
  const files = entry.changedFiles.length ? ` files=${entry.changedFiles.length}` : ""
  const gate = entry.gate ? ` gate=${entry.gate}` : ""
  const gateStatus = entry.gateStatus ? ` status=${entry.gateStatus}` : ""
  return `tool-ledger: ${entry.tool} ${state} ${entry.durationMs}ms${files}${gate}${gateStatus}`
}
