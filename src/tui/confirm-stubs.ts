/** PR-5.2: TUI Confirmation Interface Stubs
 *
 *  These types define the contract for Risk 4-5 tool confirmation UI
 *  in both CLI and TUI environments. Each high-risk tool invocation
 *  generates a confirmation request that the user must explicitly approve.
 *
 *  Actual TUI rendering will be implemented in Phase 9 (PR-9.4).
 */

import type { RiskLevel } from "../agent/tool-risk"

// ── Confirmation request ──

/** A single high-risk tool invocation awaiting user confirmation. */
export interface ConfirmRequest {
  /** Unique id for this confirmation (traceable in policy logs). */
  requestId: string
  toolName: string
  riskLevel: RiskLevel
  riskDescription: string
  /** Key parameters (truncated for display). */
  params: Record<string, unknown>
  /** The gate that triggered the confirmation requirement. */
  source: string
  priority: number
  timestamp: number
}

// ── CLI confirmation ──

/** CLI confirmation prompt text for a high-risk tool.
 *  Injected into the agent context as a <system-reminder> block. */
export function formatCliConfirmPrompt(req: ConfirmRequest): string {
  const paramsStr = JSON.stringify(req.params).slice(0, 200)
  return [
    `<system-reminder>`,
    `[Risk-${req.riskLevel} 确认] ${req.riskDescription}`,
    `工具: ${req.toolName}`,
    `参数: ${paramsStr}`,
    ``,
    `此操作需要你逐次确认。回复 "批准" 或 "允许" 来执行，或 "拒绝" 来跳过。`,
    `不允许会话级自动批准。`,
    `</system-reminder>`,
  ].join("\n")
}

// ── TUI confirmation state ──

/** State for the TUI confirmation dialog (modal overlay). */
export interface TuiConfirmDialogState {
  visible: boolean
  requests: ConfirmRequest[]
  /** Index of the currently focused request. */
  focusedIndex: number
}

/** Create an empty confirmation dialog state. */
export function createConfirmDialogState(): TuiConfirmDialogState {
  return { visible: false, requests: [], focusedIndex: 0 }
}

// ── TUI confirmation actions ──

/** User actions for the TUI confirmation dialog. */
export type TuiConfirmAction =
  | { type: "SHOW_CONFIRM"; request: ConfirmRequest }
  | { type: "APPROVE_CONFIRM"; requestId: string }
  | { type: "DENY_CONFIRM"; requestId: string }
  | { type: "DENY_ALL_CONFIRM" }
  | { type: "DISMISS_CONFIRM" }

// ── Confirmation result ──

export type ConfirmDecision = "approved" | "denied" | "dismissed"

export interface ConfirmResult {
  requestId: string
  decision: ConfirmDecision
  timestamp: number
}

/** Format a confirmation result for CLI display. */
export function formatConfirmResult(result: ConfirmResult, toolName: string): string {
  const green = (s: string) => `\x1b[1;32m${s}\x1b[0m`
  const red = (s: string) => `\x1b[1;31m${s}\x1b[0m`

  switch (result.decision) {
    case "approved":
      return green(`✓ 已批准 ${toolName}`)
    case "denied":
      return red(`✗ 已拒绝 ${toolName}`)
    case "dismissed":
      return `- 已跳过 ${toolName}`
  }
}
