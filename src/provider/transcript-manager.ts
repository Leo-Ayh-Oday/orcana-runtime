/** DeepSeekTranscriptManager — transcript validation for DeepSeek API invariants.
 *
 *  PR-6.3: Centralizes DeepSeek-specific transcript checks that were previously
 *  scattered in context-epoch.ts. Ensures the transcript is always in a state
 *  that DeepSeek's API will accept.
 *
 *  DeepSeek API invariants enforced:
 *    1. Every tool_use block must be immediately followed by a tool_result block
 *       (adjacency requirement — HTTP 400 if violated)
 *    2. Maximum 128 tools per turn (API limit)
 *    3. No unclosed tool chains at epoch rollover (already enforced in
 *       context-epoch.ts via hasUnclosedToolChain)
 *
 *  Usage:
 *    const tm = new DeepSeekTranscriptManager()
 *    if (!tm.canEpochRollover(messages)) { ... block rollover ... }
 */

import type { ProviderMessage } from "./types"

// ── Types ──

export interface TranscriptValidation {
  valid: boolean
  /** Human-readable reason for invalidity. */
  reason?: string
  /** Number of tool_use blocks found. */
  toolUseCount: number
  /** Number of tool_result blocks found. */
  toolResultCount: number
  /** Whether an unclosed tool chain was detected. */
  unclosedChain: boolean
  /** Whether adjacency was violated. */
  adjacencyViolation: boolean
}

export interface TranscriptStats {
  messageCount: number
  assistantMessages: number
  userMessages: number
  toolUseBlocks: number
  toolResultBlocks: number
  thinkingBlocks: number
  textBlocks: number
  totalChars: number
  /** DeepSeek max: 128 tools per turn. */
  toolsInLastTurn: number
}

// ── Constants ──

/** DeepSeek API limit: max tools per request. */
const MAX_TOOLS_PER_TURN = 128

// ── Helpers ──

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

// ── Transcript Manager ──

export class DeepSeekTranscriptManager {
  /**
   * Check whether epoch rollover is safe.
   *
   * Returns false if unclosed tool chains exist — rolling over would cause
   * DeepSeek HTTP 400 on the next request.
   */
  canEpochRollover(messages: ProviderMessage[]): boolean {
    return !hasUnclosedToolChain(messages)
  }

  /**
   * Full transcript validation — checks all DeepSeek invariants.
   */
  validateTranscript(messages: ProviderMessage[]): TranscriptValidation {
    const stats = this.computeStats(messages)
    const unclosedChain = hasUnclosedToolChain(messages)
    const adjacencyViolation = hasAdjacencyViolation(messages)

    const issues: string[] = []
    if (unclosedChain) issues.push("unclosed tool_use chain detected")
    if (adjacencyViolation) issues.push("tool_use not immediately followed by tool_result")
    if (stats.toolsInLastTurn > MAX_TOOLS_PER_TURN) {
      issues.push(`tool count ${stats.toolsInLastTurn} exceeds max ${MAX_TOOLS_PER_TURN}`)
    }

    return {
      valid: issues.length === 0,
      reason: issues.length > 0 ? issues.join("; ") : undefined,
      toolUseCount: stats.toolUseBlocks,
      toolResultCount: stats.toolResultBlocks,
      unclosedChain,
      adjacencyViolation,
    }
  }

  /**
   * Compute transcript statistics for observability and validation.
   */
  computeStats(messages: ProviderMessage[]): TranscriptStats {
    let assistantMessages = 0
    let userMessages = 0
    let toolUseBlocks = 0
    let toolResultBlocks = 0
    let thinkingBlocks = 0
    let textBlocks = 0
    let totalChars = 0
    let toolsInLastTurn = 0

    for (const msg of messages) {
      if (msg.role === "assistant") assistantMessages++
      if (msg.role === "user") userMessages++

      const content = Array.isArray(msg.content) ? msg.content : []
      if (typeof msg.content === "string") {
        totalChars += msg.content.length
      }

      for (const block of content) {
        if (!isRecord(block)) continue
        switch (block.type) {
          case "tool_use":
            toolUseBlocks++
            break
          case "tool_result":
            toolResultBlocks++
            break
          case "thinking":
          case "thinking_blocks":
            thinkingBlocks++
            break
          case "text":
          case "text_delta":
            textBlocks++
            break
        }
        // Estimate chars in structured blocks
        if (typeof block.text === "string") totalChars += (block.text as string).length
      }
    }

    // Tools in last turn: count tool_use in the last assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!
      if (msg.role === "assistant") {
        const content = Array.isArray(msg.content) ? msg.content : []
        for (const block of content) {
          if (isRecord(block) && block.type === "tool_use") {
            toolsInLastTurn++
          }
        }
        break // Only count the LAST assistant turn
      }
    }

    return {
      messageCount: messages.length,
      assistantMessages,
      userMessages,
      toolUseBlocks,
      toolResultBlocks,
      thinkingBlocks,
      textBlocks,
      totalChars,
      toolsInLastTurn,
    }
  }

  /**
   * Check if the last turn has too many tools.
   */
  checkToolLimit(messages: ProviderMessage[]): { ok: boolean; count: number; limit: number } {
    const count = countToolsInLastAssistantTurn(messages)
    return { ok: count <= MAX_TOOLS_PER_TURN, count, limit: MAX_TOOLS_PER_TURN }
  }

  /**
   * Format a human-readable transcript summary for debugging.
   */
  formatStats(messages: ProviderMessage[]): string {
    const s = this.computeStats(messages)
    const toolsInfo = s.toolUseBlocks > 0
      ? `, tools: ${s.toolUseBlocks} use / ${s.toolResultBlocks} result`
      : ""
    return [
      `[transcript: ${s.messageCount} msgs (${s.assistantMessages}A/${s.userMessages}U)`,
      `, ${s.totalChars} chars`,
      toolsInfo,
      `, thinking: ${s.thinkingBlocks}, text: ${s.textBlocks}]`,
    ].join("")
  }
}

// ── Standalone validation functions (exported for reuse) ──

/**
 * Check whether rawMessages contain any unclosed tool_use chains.
 *
 * DeepSeek requires every assistant tool_use block to be immediately
 * followed by a user tool_result block. If we archive messages while
 * a tool_use is pending, the next request will be HTTP 400.
 *
 * Moved here from context-epoch.ts (PR-6.3) for centralized transcript
 * management. The original export in context-epoch.ts is preserved for
 * backward compatibility.
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

/**
 * Check for adjacency violations: tool_use must be immediately followed
 * by tool_result. DeepSeek rejects messages where a tool_use is followed
 * by another tool_use or a text block without an intervening tool_result.
 */
export function hasAdjacencyViolation(messages: ProviderMessage[]): boolean {
  for (let i = 0; i < messages.length - 1; i++) {
    const current = messages[i]!
    const next = messages[i + 1]!

    if (current.role !== "assistant") continue
    if (next.role !== "user") continue

    const currentContent = Array.isArray(current.content) ? current.content : []
    const nextContent = Array.isArray(next.content) ? next.content : []

    // Count tool_use in current (assistant)
    const toolUses = currentContent.filter(b => isRecord(b) && b.type === "tool_use").length
    // Count tool_result in next (user)
    const toolResults = nextContent.filter(b => isRecord(b) && b.type === "tool_result").length

    // If assistant has tool_use but next user doesn't have matching tool_result
    if (toolUses > 0 && toolResults === 0) {
      return true
    }
  }
  return false
}

/**
 * Count tool_use blocks in the last assistant message.
 * Used to enforce DeepSeek's 128 tools-per-turn limit.
 */
export function countToolsInLastAssistantTurn(messages: ProviderMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : []
      let count = 0
      for (const block of content) {
        if (isRecord(block) && block.type === "tool_use") count++
      }
      return count
    }
  }
  return 0
}
