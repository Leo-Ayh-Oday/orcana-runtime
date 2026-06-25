/** [PR 4] Context Epoch — four-layer context architecture.
 *
 *  Replaces ad-hoc percentage-based compaction with structured epoch management:
 *
 *    Layer 1: Stable Prefix (system prompt, identity, rules, project kernel)
 *             Already frozen as frozenStablePrefix in loop.ts — not managed here.
 *    Layer 2: Plan State   (MasterPlan, TaskTracker, Ripple, user goal, decisions)
 *             Built via buildPlanStateContext(). Survives epoch rollover.
 *    Layer 3: Task Epoch   (rawMessages for current node)
 *             Rolled over at rolloverChars threshold, replaced with digest.
 *    Layer 4: Volatile Tail (last few rounds of tool calls/results)
 *             Rebuilt after each rollover from retained messages.
 *
 *  Thresholds (character-based, ÷3 ≈ token estimate):
 *    120k chars (~40k tokens) — compress individual tool results (microcompact)
 *    220k chars (~73k tokens) — force-compress + inject epoch budget warning
 *    300k chars (~100k tokens) — epoch rollover
 *
 *  Preservation invariants:
 *    - MasterPlan / TaskPacket / TaskTracker / Evidence / Ripple / userGoal / decisions
 *      are NEVER cleared across epoch rollovers.
 *    - Unclosed tool-use chains block rollover (DeepSeek 400 error).
 */

import type { ProviderMessage } from "../provider/types"
import type { TaskPacket } from "./task-packet"
import type { MasterPlan } from "./master-plan"
import type { RippleObligation } from "../ripple/obligations"

// ── Thresholds ──

export interface EpochThresholds {
  /** ~40k tokens. Microcompact individual tool results. */
  compressChars: number
  /** ~73k tokens. Force-compact older results, warn model. */
  forceCompressChars: number
  /** ~100k tokens. Archive epoch, preserve plan state, restart volatile. */
  rolloverChars: number
}

export const DEFAULT_EPOCH_THRESHOLDS: EpochThresholds = {
  compressChars: Number(process.env.DEEPSEEK_EPOCH_COMPRESS_CHARS) || 120_000,
  forceCompressChars: Number(process.env.DEEPSEEK_EPOCH_FORCE_COMPRESS_CHARS) || 220_000,
  rolloverChars: Number(process.env.DEEPSEEK_EPOCH_ROLLOVER_CHARS) || 300_000,
}

// ── Epoch state ──

export interface EpochSnapshot {
  index: number
  startRound: number
  endRound: number
  messageCountBefore: number
  messageCountAfter: number
  charsArchived: number
  planStateDigest: string
  createdAt: number
}

export interface EpochState {
  thresholds: EpochThresholds
  currentEpochIndex: number
  epochStartRound: number
  rolloverCount: number
  snapshots: EpochSnapshot[]
  /** Total chars trimmed across all epochs. */
  totalCharsTrimmed: number
}

export function createEpochState(thresholds?: Partial<EpochThresholds>): EpochState {
  return {
    thresholds: { ...DEFAULT_EPOCH_THRESHOLDS, ...thresholds },
    currentEpochIndex: 0,
    epochStartRound: 0,
    rolloverCount: 0,
    snapshots: [],
    totalCharsTrimmed: 0,
  }
}

// ── Character estimation (no LLM needed) ──

export function msgCharLen(m: ProviderMessage): number {
  return typeof m.content === "string"
    ? m.content.length
    : JSON.stringify(m.content).length
}

export function totalMessageChars(messages: ProviderMessage[]): number {
  return messages.reduce((sum, m) => sum + msgCharLen(m), 0)
}

// ── Plan state context builder (Layer 2) ──

export interface PlanStateInput {
  masterPlan: MasterPlan | null
  taskTracker: { goal?: string; phase?: string; requiredFiles?: string[]; steps?: Array<{ id: string; title: string; status: string }> } | null
  taskPacket: TaskPacket | null
  rippleObligations: RippleObligation[]
  userGoal: string
  decisions: string[]
  /** Current round number for epoch preamble. */
  round: number
}

/** Build a context message that survives epoch rollover.
 *
 *  This contains the minimal information needed to continue work after
 *  the volatile tail has been archived. It is injected between the
 *  stable prefix and the current task epoch.
 */
export function buildPlanStateContext(input: PlanStateInput): string {
  const lines: string[] = [
    "## Plan State (Context Epoch)",
    "[EPOCH_ANCHOR:v1]",
    "",
  ]

  // User goal
  lines.push(`### Goal: ${input.userGoal.slice(0, 200)}`)
  lines.push("")

  // MasterPlan summary
  if (input.masterPlan) {
    const total = input.masterPlan.nodes.length
    const done = input.masterPlan.nodes.filter(n => n.status === "done").length
    const active = input.masterPlan.nodes.find(n => n.status === "active")
    const blocked = input.masterPlan.nodes.filter(n => n.status === "blocked").length

    lines.push(`### Plan: ${total} nodes, ${done} done, ${blocked} blocked`)
    if (active) {
      const p = active._packet
      const scope = p?.scope?.length ? ` — scope: ${p.scope.join(", ")}` : ""
      lines.push(`- Active: "${active.title}" (${active.id})${scope}`)
      if (p?.verification?.length) {
        const vkinds = p.verification.map(v => v.kind).join(", ")
        lines.push(`  Verification: ${vkinds}`)
      }
      if (p?.doneCriteria?.length) {
        lines.push(`  Done criteria: ${p.doneCriteria.slice(0, 3).join("; ")}`)
      }
    }

    // Pending nodes (non-done, non-active)
    const pending = input.masterPlan.nodes.filter(n => n.status !== "done" && n.status !== "active")
    if (pending.length > 0 && pending.length <= 8) {
      const names = pending.map(n => `"${n.title}"`).join(", ")
      lines.push(`- Pending: ${names}`)
    } else if (pending.length > 8) {
      lines.push(`- Pending: ${pending.length} nodes`)
    }
    lines.push("")
  }

  // TaskTracker summary
  if (input.taskTracker) {
    const steps = input.taskTracker.steps ?? []
    const doneSteps = steps.filter(s => s.status === "done").length
    if (steps.length > 0) {
      lines.push(`### Task Progress: ${doneSteps}/${steps.length} steps`)
      const activeSteps = steps.filter(s => s.status === "running")
      for (const s of activeSteps) {
        lines.push(`- Running: "${s.title.slice(0, 120)}"`)
      }
    }
    if (input.taskTracker.requiredFiles?.length) {
      lines.push(`- Required files: ${input.taskTracker.requiredFiles.join(", ")}`)
    }
    lines.push("")
  }

  // TaskPacket
  if (input.taskPacket) {
    if (input.taskPacket.scope.length > 0) {
      lines.push(`### Scope: ${input.taskPacket.scope.slice(0, 8).join(", ")}`)
    }
    if (input.taskPacket.doneCriteria.length > 0) {
      lines.push(`### Done Criteria: ${input.taskPacket.doneCriteria.slice(0, 4).join("; ")}`)
    }
    lines.push("")
  }

  // Ripple obligations
  if (input.rippleObligations.length > 0) {
    lines.push(`### Ripple Obligations: ${input.rippleObligations.length} pending`)
    for (const ob of input.rippleObligations.slice(0, 6)) {
      lines.push(`- ${ob.reason}: ${ob.targetFile} (via ${ob.symbol})`)
    }
    lines.push("")
  }

  // Decisions
  if (input.decisions.length > 0) {
    lines.push("### Key Decisions")
    for (const d of input.decisions.slice(-8)) {
      lines.push(`- ${d.slice(0, 200)}`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

// ── Tool chain guard ──

/** Check whether rawMessages contain any unclosed tool_use chains.
 *
 *  DeepSeek requires every assistant tool_use block to be immediately
 *  followed by a user tool_result block. If we archive messages while
 *  a tool_use is pending, the next request will be HTTP 400.
 */
export function hasUnclosedToolChain(messages: ProviderMessage[]): boolean {
  let pendingToolUses = 0
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : []
      for (const block of content) {
        if (isRecord(block) && block.type === "tool_use") {
          pendingToolUses++
        }
      }
    }
    if (msg.role === "user") {
      const content = Array.isArray(msg.content) ? msg.content : []
      for (const block of content) {
        if (isRecord(block) && block.type === "tool_result") {
          pendingToolUses = Math.max(0, pendingToolUses - 1)
        }
      }
    }
  }
  return pendingToolUses > 0
}

// ── Epoch action classification ──

export type EpochAction = "none" | "compress" | "forceCompress" | "rollover"

export function classifyEpochAction(
  totalChars: number,
  thresholds: EpochThresholds,
): EpochAction {
  if (totalChars >= thresholds.rolloverChars) return "rollover"
  if (totalChars >= thresholds.forceCompressChars) return "forceCompress"
  if (totalChars >= thresholds.compressChars) return "compress"
  return "none"
}

// ── Epoch rollover ──

export interface RolloverResult {
  /** The replacement messages — plan state context + recent tail. */
  messages: ProviderMessage[]
  /** Number of messages archived. */
  archivedCount: number
  /** Chars removed. */
  charsTrimmed: number
  /** Snapshot of what was archived. */
  snapshot: EpochSnapshot
}

/**
 * Perform an epoch rollover: archive most rawMessages, keep the most
 * recent few rounds, and prepend the plan state digest.
 *
 * Safety: refuses to roll over if unclosed tool chains are detected.
 *
 * @param messages — rawMessages to roll over
 * @param keepRecent — number of assistant+user pairs to retain at the tail (default 3 = ~6 messages)
 * @param planStateContext — serialized plan state (from buildPlanStateContext)
 * @param state — current epoch state
 * @param round — current round number
 */
export function epochRollover(
  messages: ProviderMessage[],
  keepRecent: number,
  planStateContext: string,
  state: EpochState,
  round: number,
): RolloverResult | { blocked: true; reason: string } {
  if (hasUnclosedToolChain(messages)) {
    return {
      blocked: true,
      reason: "Cannot roll over: unclosed tool-use chain detected. Retry after tool results arrive.",
    }
  }

  const charsBefore = totalMessageChars(messages)

  // Find the cut point: keep the most recent `keepRecent` assistant→user pairs
  // Walking backwards to find the cut
  let assistantCount = 0
  let cutIndex = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role === "assistant") assistantCount++
    if (assistantCount >= keepRecent) {
      cutIndex = i
      break
    }
  }

  // Guard: ensure at least 2 messages are retained (one full turn)
  // Using cutIndex on short message lists can produce empty retained sets.
  // e.g. messages.length=2, cutIndex=2 → retained=[]
  const minRetained = 2
  if (messages.length - cutIndex < minRetained) {
    cutIndex = Math.max(0, messages.length - minRetained)
  }

  const archivedMessages = messages.slice(0, cutIndex)
  const retainedMessages = messages.slice(cutIndex)
  // charsTrimmed: actual reduction in raw messages (preamble adds its own chars,
  // so this slightly overstates the net context reduction by ~preamble length).
  const charsAfter = totalMessageChars(retainedMessages)
  const charsTrimmed = charsBefore - charsAfter

  // Build epoch preamble — replaces the archived messages
  const preamble: ProviderMessage = {
    role: "user",
    content: [
      planStateContext,
      "",
      "## Epoch Rollover",
      `Epoch ${state.currentEpochIndex} archived. ${archivedMessages.length} messages (${charsTrimmed} chars) moved to archive.`,
      "Continue from the plan state above. The volatile context has been reset, but all plan state, decisions, and obligations are preserved.",
      "",
      "Do NOT re-execute completed steps — check the Plan State for current progress.",
    ].join("\n"),
  }

  const snapshot: EpochSnapshot = {
    index: state.currentEpochIndex,
    startRound: state.epochStartRound,
    endRound: round,
    messageCountBefore: messages.length,
    messageCountAfter: retainedMessages.length + 1, // +1 for preamble
    charsArchived: charsTrimmed,
    planStateDigest: planStateContext.slice(0, 500),
    createdAt: Date.now(),
  }

  return {
    messages: [preamble, ...retainedMessages],
    archivedCount: archivedMessages.length,
    charsTrimmed,
    snapshot,
  }
}

// ── Budget warning (force-compress threshold) ──

export function formatEpochBudgetWarning(percentUsed: number, thresholds: EpochThresholds): string {
  return [
    "## Context Epoch Budget Warning",
    `Current context usage is ~${Math.round(percentUsed)}% of the active window.`,
    `Compress threshold: ${Math.round(thresholds.compressChars / 1000)}k chars.`,
    `Force-compress threshold: ${Math.round(thresholds.forceCompressChars / 1000)}k chars.`,
    `Epoch rollover threshold: ${Math.round(thresholds.rolloverChars / 1000)}k chars.`,
    "",
    "Continue only the current atomic stage. Do not expand scope.",
    "Complete the current verification/done criteria, then finish.",
    "Do not start new exploration, broad search, or multi-file rewrites.",
  ].join("\n")
}

// ── Epoch digest for status reporting ──

export function formatEpochStatus(state: EpochState, round: number, totalChars: number): string {
  const action = classifyEpochAction(totalChars, state.thresholds)
  const { compressChars, forceCompressChars, rolloverChars } = state.thresholds
  const lines = [
    `epoch: ${state.currentEpochIndex}`,
    `round: ${round}`,
    `chars: ${totalChars}`,
    `action: ${action}`,
    `thresholds: compress=${compressChars} force=${forceCompressChars} rollover=${rolloverChars}`,
    `rollovers: ${state.rolloverCount}`,
  ]
  return lines.join(" | ")
}

// ── Internal helper ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
