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

import { createHash } from "node:crypto"
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
  compressChars: Number(process.env.ORCANA_EPOCH_COMPRESS_CHARS) || 120_000,
  forceCompressChars: Number(process.env.ORCANA_EPOCH_FORCE_COMPRESS_CHARS) || 220_000,
  rolloverChars: Number(process.env.ORCANA_EPOCH_ROLLOVER_CHARS) || 300_000,
}

/** Scale automatic compaction so it runs before ContextBudgetGate blocks models
 * with windows smaller than DeepSeek V4's 1M tokens. */
export function epochThresholdsForContext(contextMaxTokens: number): EpochThresholds {
  const estimatedWindowChars = Math.max(3, contextMaxTokens * 3)
  const rolloverChars = Math.min(DEFAULT_EPOCH_THRESHOLDS.rolloverChars, Math.floor(estimatedWindowChars * 0.45))
  const forceCompressChars = Math.min(
    DEFAULT_EPOCH_THRESHOLDS.forceCompressChars,
    Math.floor(estimatedWindowChars * 0.38),
    Math.floor(rolloverChars * 0.85),
  )
  const compressChars = Math.min(
    DEFAULT_EPOCH_THRESHOLDS.compressChars,
    Math.floor(estimatedWindowChars * 0.25),
    Math.floor(forceCompressChars * 0.75),
  )
  return { compressChars, forceCompressChars, rolloverChars }
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
  /** K3: ref (artifact store) or sha256 of the archived raw messages. Backfilled
   *  by the caller via persistEpochArchive — epochRollover stays pure. */
  archiveRef?: string
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
  /** K19: chars-per-token observed from the previous provider round's measured
   *  input tokens; calibrates the char thresholds. 3 when unknown. */
  lastMeasuredCharsPerToken?: number
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
// PR-6.3: Canonical implementation moved to provider/transcript-manager.ts.
// Re-exported here for backward compatibility — all new callers should import
// directly from transcript-manager.

import { hasUnclosedToolChain } from "../provider/transcript-manager"
export { hasUnclosedToolChain }

// ── Epoch action classification ──

export type EpochAction = "none" | "compress" | "forceCompress" | "rollover"

/** Scale char thresholds by an observed chars-per-token density.
 *
 *  The defaults assume ~3 chars/token. Real content drifts (code/JSON/CJK pack
 *  more chars per token), so the char thresholds are scaled by `charsPerToken / 3`
 *  to keep the effective *token* thresholds constant. charsPerToken = 3 is the
 *  identity. A non-positive ratio (no measurement / degenerate provider) is
 *  treated as 1 — never invert the thresholds.
 */
export function calibrateEpochThresholds(
  thresholds: EpochThresholds,
  charsPerToken: number,
): EpochThresholds {
  const factor = charsPerToken > 0 ? charsPerToken / 3 : 1
  return {
    compressChars: Math.round(thresholds.compressChars * factor),
    forceCompressChars: Math.round(thresholds.forceCompressChars * factor),
    rolloverChars: Math.round(thresholds.rolloverChars * factor),
  }
}

export function classifyEpochAction(
  totalChars: number,
  thresholds: EpochThresholds,
  charsPerToken = 3,
): EpochAction {
  const effective = calibrateEpochThresholds(thresholds, charsPerToken)
  if (totalChars >= effective.rolloverChars) return "rollover"
  if (totalChars >= effective.forceCompressChars) return "forceCompress"
  if (totalChars >= effective.compressChars) return "compress"
  return "none"
}

// ── Epoch rollover ──

export interface RolloverResult {
  /** The replacement messages — plan state context + recent tail. */
  messages: ProviderMessage[]
  /** Number of messages archived. */
  archivedCount: number
  /** K3: the archived raw messages, preserved verbatim. Callers persist them
   *  (via persistEpochArchive) and record the ref on the snapshot. */
  archivedMessages: ProviderMessage[]
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
 * With `fallback: true` (K22) it instead cuts to the last safe boundary —
 * archiving everything before the most recent complete user message, so the
 * pending tool chain stays intact in the volatile tail.
 *
 * @param messages — rawMessages to roll over
 * @param keepRecent — number of assistant+user pairs to retain at the tail (default 3 = ~6 messages)
 * @param planStateContext — serialized plan state (from buildPlanStateContext)
 * @param state — current epoch state
 * @param round — current round number
 * @param fallback — when true, allow cutting at the last safe boundary even with an unclosed tool chain
 */
export function epochRollover(
  messages: ProviderMessage[],
  keepRecent: number,
  planStateContext: string,
  state: EpochState,
  round: number,
  fallback = false,
): RolloverResult | { blocked: true; reason: string } {
  const unclosedChain = hasUnclosedToolChain(messages)
  if (unclosedChain && !fallback) {
    return {
      blocked: true,
      reason: "Cannot roll over: unclosed tool-use chain detected. Retry after tool results arrive.",
    }
  }

  const charsBefore = totalMessageChars(messages)

  // Find the cut point.
  let cutIndex: number
  let fallbackNote = ""
  if (unclosedChain) {
    // K22 fallback: cut to the last safe boundary — the last complete plain-text
    // user message before any currently-open tool_use. Everything before it is
    // archived; the unclosed chain itself stays intact so DeepSeek's
    // tool_use→tool_result adjacency is never broken.
    const boundary = findSafeRolloverBoundary(messages)
    if (boundary < 0) {
      return {
        blocked: true,
        reason: "Cannot roll over in fallback mode: the entire history is inside an unclosed tool chain.",
      }
    }
    cutIndex = boundary
    fallbackNote = "Rollover executed in FALLBACK mode (unclosed tool chain): archived up to the last safe boundary; the pending tool chain is retained in the volatile tail."
  } else {
    // Normal path: keep the most recent `keepRecent` assistant→user pairs.
    // Walking backwards to find the cut.
    let assistantCount = 0
    cutIndex = messages.length
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
  }

  const archivedMessages = messages.slice(0, cutIndex)
  const retainedMessages = messages.slice(cutIndex)

  // Build epoch preamble — replaces the archived messages
  const preamble: ProviderMessage = {
    role: "user",
    content: [
      planStateContext,
      "",
      "## Epoch Rollover",
      `Epoch ${state.currentEpochIndex} archived. ${archivedMessages.length} messages (${totalMessageChars(archivedMessages)} chars) moved to archive.`,
      "Continue from the plan state above. The volatile context has been reset, but all plan state, decisions, and obligations are preserved.",
      "",
      "Do NOT re-execute completed steps — check the Plan State for current progress.",
      ...(fallbackNote ? [fallbackNote] : []),
    ].join("\n"),
  }

  // charsTrimmed: net reduction — the preamble replaces the archived
  // messages, so its own chars are subtracted from the gross reduction.
  const charsAfter = totalMessageChars(retainedMessages)
  const charsTrimmed = Math.max(0, charsBefore - charsAfter - msgCharLen(preamble))

  const snapshot: EpochSnapshot = {
    index: state.currentEpochIndex,
    startRound: state.epochStartRound,
    endRound: round,
    messageCountBefore: messages.length,
    messageCountAfter: retainedMessages.length + 1, // +1 for preamble
    charsArchived: charsTrimmed,
    // K23: a real digest (sha256), not a content prefix — auditable/reproducible.
    planStateDigest: createHash("sha256").update(planStateContext).digest("hex"),
    createdAt: Date.now(),
  }

  return {
    messages: [preamble, ...retainedMessages],
    archivedCount: archivedMessages.length,
    archivedMessages,
    charsTrimmed,
    snapshot,
  }
}

// ── K22: fallback safe-boundary search ──

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null
}

function isToolResultMessage(m: ProviderMessage): boolean {
  if (typeof m.content === "string") return false
  return m.content.some(b => isRecord(b) && b.type === "tool_result")
}

/** Largest index at which a fresh, complete plain-text user turn starts with
 *  every prior tool_use closed — the last safe archive boundary. Returns -1
 *  when no such boundary exists (the whole history is inside a tool chain). */
function findSafeRolloverBoundary(messages: ProviderMessage[]): number {
  let pendingToolUses = 0
  let boundary = -1
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (pendingToolUses === 0 && m.role === "user" && !isToolResultMessage(m)) {
      boundary = i
    }
    if (m.role === "assistant") {
      const blocks = Array.isArray(m.content) ? m.content : []
      for (const b of blocks) {
        if (isRecord(b) && b.type === "tool_use") pendingToolUses++
      }
    } else if (m.role === "user") {
      const blocks = Array.isArray(m.content) ? m.content : []
      for (const b of blocks) {
        if (isRecord(b) && b.type === "tool_result") pendingToolUses = Math.max(0, pendingToolUses - 1)
      }
    }
  }
  return boundary
}

// ── K3: archive preservation (先持久化事实，再压缩表示) ──

/** Deterministic sha256 of the archived raw messages' serialized JSON. */
export function archiveContentHash(archivedMessages: ProviderMessage[]): string {
  return createHash("sha256").update(JSON.stringify(archivedMessages)).digest("hex")
}

/** Persist the archived raw messages via the artifact store (best-effort).
 *
 *  Returns the artifact ref when the store is present and succeeds; otherwise
 *  falls back to the content sha256 hash. Never throws — a failed persistence
 *  must not block the rollover.
 */
export async function persistEpochArchive(
  artifactStore: { storeContent(content: string): Promise<string> } | undefined,
  archivedMessages: ProviderMessage[],
): Promise<{ ref: string; persisted: boolean }> {
  const fallbackHash = archiveContentHash(archivedMessages)
  if (!artifactStore) return { ref: fallbackHash, persisted: false }
  try {
    const ref = await artifactStore.storeContent(JSON.stringify(archivedMessages))
    return ref ? { ref, persisted: true } : { ref: fallbackHash, persisted: false }
  } catch {
    return { ref: fallbackHash, persisted: false }
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
