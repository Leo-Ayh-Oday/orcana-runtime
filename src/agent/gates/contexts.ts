/** Phase-specific context types for gate chains.
 *
 *  Contexts are mutable — gates read AND write to the context, just like
 *  the current loop.ts mutates shared state variables. GateResult only
 *  signals pass/block; all computed data lives on the context.
 *
 *  This matches the existing coding style in loop.ts where gates mutate
 *  variables like `rippleBlockActive`, `rateLimitShell++`, etc.
 */

import type { ProviderMessage } from "../../provider/types"
import type { ToolDescriptor, ToolResult } from "../../tools/registry"
import type { RippleReport } from "../../ripple/types"
import type { RippleObligation } from "../../ripple/obligations"
import type { TaskTracker } from "../task-tracker"
import type { PermissionGate } from "../permission"
import type { VerificationResult } from "../../verification/result"
import type { ConfidenceEvaluator } from "../../evaluator/confidence"
import type { ContextBudgetMode } from "./context-budget"

// ── Pre-round context ──

export interface PreRoundContext {
  round: number
  /** Estimated input tokens for this round. */
  roundInputTokens: number
  contextMax: number
  /** Full original tool set (never modified by gates). */
  fullTools: ToolDescriptor[]
  /** Working tool set (mutated by each gate in sequence). */
  tools: ToolDescriptor[]
  rippleReports: RippleReport[]
  pendingRippleObligations: RippleObligation[]
  /** Whether intent is readonly-driven. */
  intentReadonly: boolean
  /** Whether we're in a planning-only phase. */
  taskPlanning: boolean
  /** Whether ContextReadiness requires more read/locate work before writes. */
  contextReadinessBlocked?: boolean
  /** Whether cache-stable tools are enabled (bypasses disclosure/ripple filters). */
  cacheStableTools: boolean
  /** Context text for tool disclosure (provider messages + system prompt). */
  disclosureContextText: string

  // ── Outputs (set by gates) ──
  contextBudgetMode: ContextBudgetMode
  contextBudgetPercent: number
  budgetMessage: ProviderMessage | null
  announcedDegraded: boolean
  rippleBlockActive: boolean
  contextReadinessBlockActive?: boolean
  /** Tokens saved by tool disclosure (for status display). */
  tokensSaved: number
  /** Final active tools for this round (set by the last gate in chain). */
  activeTools: ToolDescriptor[]
}

// ── Tool execution context ──

export interface ToolContext {
  toolCall: { id: string; name: string; input: Record<string, unknown> }
  tool: ToolDescriptor | undefined
  intentPolicy: { mode: string; reason: string }
  taskTracker: TaskTracker | null
  rippleBlockActive: boolean
  pendingRippleObligations: RippleObligation[]
  permissionGate: PermissionGate
  permissionMode: "full" | "strict"
  rateLimitShell: number
  rateLimitFile: number
  rateLimitNetwork: number
  webSearchFailedThisTurn: boolean
  webSearchFailReason: string
  finalText: string

  // ── Outputs (set by gates) ──
  /** Incremented rate limit counter name ("" if none). */
  incrementRateLimit: "shell" | "file" | "network" | ""
  /** Tool result when blocked (set by gate before returning pass=false). */
  blockedResult?: ToolResult
}

// ── Completion context ──

export interface CompletionContext {
  round: number
  finalText: string
  intentPolicy: { mode: string; reason: string }
  taskTracker: TaskTracker | null
  pendingRippleObligations: RippleObligation[]
  taskHadWrite: boolean
  taskToolErrors: number
  taskModifiedFiles: number
  lastTypecheck: { passed: boolean; issues: number; output?: string } | undefined
  lastRippleReports: RippleReport[]
  lastVerificationResults: VerificationResult[]
  planApproved: boolean
  planningRejections: number
  maxRounds: number
  priorTools: string[]
  priorFiles: Set<string>
  confidenceEvaluator: ConfidenceEvaluator

  // ── Outputs (set by gates) ──
  /** Non-null when a gate blocks completion; loop.ts injects this as a user message. */
  completionBlockMessage: string | null
  /** Set to true when the loop should break (plan_ready, impossible, etc.). */
  shouldBreak: boolean
  /** Yield event to emit before breaking (e.g. plan_ready). */
  breakEvent: { type: string; data: unknown } | null
  /** Status message to yield. */
  statusMessage: string
  /** Messages to inject into rawMessages. */
  injectMessages: Array<{ role: string; content: string }>
  /** Trace event to record. */
  traceEvent: { gate: string; decision: string; [key: string]: unknown } | null
}
