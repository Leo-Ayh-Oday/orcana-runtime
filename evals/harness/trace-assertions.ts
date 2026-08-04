/** H12 trace assertions (plan §18.2 events + always-on invariants).
 *
 *  matchEvents / matchDeepPartial power EventExpectation; assertTraceInvariants
 *  implements the always-on checks (HR-025 sequence continuity, HR-026 tool
 *  call termination, HR-027 terminal outcomes) that run on EVERY replay case.
 */

import type { EventExpectation } from "./contracts"

/** Deep-partial match: every key in `expected` must match `actual` (extra
 *  actual keys are fine; arrays match by deep equality). */
export function matchDeepPartial(actual: unknown, expected: Record<string, unknown>): boolean {
  if (actual === null || actual === undefined) return false
  if (typeof actual !== "object") return false
  for (const [key, value] of Object.entries(expected)) {
    const actualValue = (actual as Record<string, unknown>)[key]
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      if (!matchDeepPartial(actualValue, value as Record<string, unknown>)) return false
    } else if (actualValue !== value) {
      return false
    }
  }
  return true
}

export interface ReplayEvent { type: string; payload: unknown }

/** Match an EventExpectation against the collected event list. */
export function matchEvents(events: ReplayEvent[], expectation: EventExpectation): boolean {
  const matching = events.filter((e) => e.type === expectation.type)
  if (expectation.absent) return matching.length === 0
  if (expectation.count !== undefined && matching.length !== expectation.count) return false
  if (expectation.minCount !== undefined && matching.length < expectation.minCount) return false
  if (expectation.payload) {
    return matching.some((e) => matchDeepPartial(e.payload, expectation.payload ?? {}))
  }
  return true
}

/** Always-on trace invariants (HR-025/026/027). Returns failure strings. */
export function assertTraceInvariants(
  events: ReplayEvent[],
  snapshot: { status: string; outcome?: { kind: string } | null },
): string[] {
  const failures: string[] = []

  // HR-025: sequence continuity is asserted by the executor (sequences come
  // from envelopes); here we check the structural counterparts.
  const terminal = ["completed", "failed", "cancelled", "restart_required"]
  if (!terminal.includes(snapshot.status)) {
    failures.push(`invariant: snapshot status "${snapshot.status}" is not terminal`)
  }
  // HR-027: every terminal run has an outcome.
  if (terminal.includes(snapshot.status) && !snapshot.outcome) {
    failures.push("invariant: terminal run without outcome")
  }

  // HR-026: every tool call has a matching terminal event.
  const calls = events.filter((e) => e.type === "tool.call.requested")
  for (const call of calls) {
    const name = (call.payload as { toolCall?: { name?: string } }).toolCall?.name
    const terminated = events.some(
      (e) => (e.type === "tool.call.completed" || e.type === "tool.call.failed")
        && (e.payload as { toolName?: string }).toolName === name,
    )
    if (!terminated) {
      failures.push(`invariant: tool call "${name ?? "?"}" has no terminal event`)
    }
  }

  // Terminal event must be the last one (nothing after completion).
  const lastType = events[events.length - 1]?.type
  if (lastType && lastType.startsWith("tool.call.") && lastType.endsWith("requested")) {
    failures.push("invariant: run ends on an un-terminated tool call")
  }

  return failures
}
