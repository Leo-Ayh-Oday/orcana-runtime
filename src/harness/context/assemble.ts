/** ContextSlice → ProviderMessage assembly (H10) — the byte-frozen single point.
 *
 *  Group assemblers replicate the exact bytes the loop used to build:
 *    - "stable-prefix": `## Stable Prefix Context\n[CACHE_ANCHOR:v3]` header +
 *      parts joined by "\n\n" (round.ts :168). When a single contribution
 *      already carries the full frozen prefix (rounds ≥ 1), it passes through
 *      byte-for-byte — never rebuilt (plan §23 cache stability).
 *    - "volatile-round": the `## Volatile Round Context` header + chunks
 *      joined by "\n\n" (pre-loop buildVolatileContextMessage :154-160).
 *  Ungrouped contributions become one user message each; empty content is
 *  skipped (mirroring the old conditional expansion). Every call returns a
 *  NEW array — estimateRoundTokens mutates the array it receives.
 */

import type { ContextContribution, ContextSlice } from "../contracts/context"
import type { ProviderMessage } from "../../provider/types"

const STABLE_PREFIX_HEADER = "## Stable Prefix Context\n[CACHE_ANCHOR:v3]"
const VOLATILE_HEADER = "## Volatile Round Context"

/** Assemble contributions into the context message list (byte-frozen order). */
export function contextSliceToMessages(slice: ContextSlice): ProviderMessage[] {
  const messages: ProviderMessage[] = []
  const emittedGroups = new Set<string>()

  // Single pass in contribution order: a group renders at the position of its
  // first member (parts merged by priority); ungrouped contributions render
  // individually. This preserves the legacy message order exactly.
  for (const contribution of slice.contributions) {
    if (contribution.group) {
      if (emittedGroups.has(contribution.group)) continue
      emittedGroups.add(contribution.group)
      const parts = slice.contributions.filter((c) => c.group === contribution.group)
      const message = assembleGroup(contribution.group, parts)
      if (message) messages.push(message)
    } else {
      if (contribution.content.trim() === "") continue
      messages.push({ role: "user", content: contribution.content })
    }
  }

  return messages
}

function assembleGroup(group: string, parts: ContextContribution[]): ProviderMessage | null {
  const sorted = [...parts].sort((a, b) => a.priority - b.priority)
  const nonEmpty = sorted.filter((p) => p.content.trim() !== "")

  if (group === "stable-prefix") {
    // Rounds ≥ 1: the frozen prefix passes through byte-for-byte. Other
    // stable providers return empty parts then, so the group has exactly one
    // non-empty member carrying the full frozen message.
    if (nonEmpty.length === 1 && nonEmpty[0]!.content.includes("[CACHE_ANCHOR:v3]")) {
      return { role: "user", content: nonEmpty[0]!.content }
    }
    const partsText = nonEmpty.map((p) => p.content)
    if (partsText.length === 0) return null
    return { role: "user", content: [STABLE_PREFIX_HEADER, partsText.join("\n\n")].join("\n\n") }
  }

  if (group === "volatile-round") {
    // A single contribution that already IS the volatile message passes through.
    if (nonEmpty.length === 1 && nonEmpty[0]!.content.startsWith(VOLATILE_HEADER)) {
      return { role: "user", content: nonEmpty[0]!.content }
    }
    const chunks = nonEmpty.map((p) => p.content)
    if (chunks.length === 0) return null
    return { role: "user", content: [VOLATILE_HEADER, chunks.join("\n\n")].join("\n\n") }
  }

  // Unknown group: treat parts as independent messages (defensive).
  const messages: ProviderMessage[] = []
  for (const part of sorted) {
    if (part.content.trim() === "") continue
    messages.push({ role: "user", content: part.content })
  }
  return messages[0] ?? null
}

/** Extract the assembled stable prefix message for run-0 persistence. */
export function stableMessageOf(slice: ContextSlice): ProviderMessage | null {
  const messages = contextSliceToMessages(slice)
  const stable = messages.find((m) => typeof m.content === "string" && m.content.includes("[CACHE_ANCHOR:v3]"))
  return stable ?? null
}
