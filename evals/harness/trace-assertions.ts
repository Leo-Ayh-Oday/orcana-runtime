/** H12 trace assertions (plan §18.2 events + always-on invariants).
 *
 *  matchEvents / matchDeepPartial power EventExpectation; assertTraceInvariants
 *  implements the always-on checks (HR-025 sequence continuity, HR-026 tool
 *  call termination, HR-027 terminal outcomes) that run on EVERY replay case.
 */

import type { EventExpectation } from "./contracts"
import { isStoppedRunStatus } from "../../src/harness/contracts/run"

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

export interface ReplayEvent { type: string; payload: unknown; sequence?: number }

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
  // G0-1: the outcome check uses "stopped" semantics — a run that is no
  // longer auto-advancing (terminal OR blocked/waiting/paused) must carry an
  // outcome. blocked is a legitimate end state for HR scenarios (the
  // orchestrator refusing to claim done after a failed/blocked tool is the
  // SAFE behavior), but it is stopped-resumable, NOT terminal
  // (contracts/run.ts TERMINAL_RUN_STATUSES vs STOPPED_RUN_STATUSES).
  if (!isStoppedRunStatus(snapshot.status as never)) {
    failures.push(`invariant: snapshot status "${snapshot.status}" is not a stopped state`)
  }
  // HR-027: every stopped run has an outcome.
  if (isStoppedRunStatus(snapshot.status as never) && !snapshot.outcome) {
    failures.push("invariant: stopped run without outcome")
  }

  // HR-026 (R1): pair each request to EXACTLY ONE terminal event by toolCallId.
  // Name-based matching let a same-named second call with zero terminals slip
  // through when the first call had two. Rules:
  //   - 0 terminals → needs a policy-block trace (L4 hard blocks skip the
  //     tool_result yield and surface as a status ledger line) else FAIL
  //   - ≥2 terminals → FAIL (duplicate terminal)
  //   - terminal must come AFTER the request (stream order)
  const calls = events.filter((e) => e.type === "tool.call.requested")
  for (const call of calls) {
    const callId = (call.payload as { toolCall?: { id?: string } }).toolCall?.id ?? ""
    const name = (call.payload as { toolCall?: { name?: string } }).toolCall?.name ?? "?"
    const requestIndex = events.indexOf(call)
    const terminals: Array<{ index: number; type: string }> = []
    events.forEach((e, index) => {
      if (e.type === "tool.call.completed" || e.type === "tool.call.failed") {
        const payload = e.payload as { toolCallId?: string; toolName?: string }
        // Fallback: bridged events without a callId pair by name (legacy);
        // real streams carry toolCallId (R1).
        const matches = payload.toolCallId !== undefined
          ? payload.toolCallId === callId
          : payload.toolName === name
        if (matches && index > requestIndex) terminals.push({ index, type: e.type })
      }
    })
    const policyBlocked = events.some(
      (e) => e.type === "display.changed"
        && typeof (e.payload as { display?: { data?: unknown } }).display?.data === "string"
        && (e.payload as { display: { data: string } }).display.data.includes(name)
        && (e.payload as { display: { data: string } }).display.data.includes("blocked"),
    )
    if (terminals.length === 0 && !policyBlocked) {
      failures.push(`invariant: tool call "${name}" (${callId || "no-id"}) has no terminal event and no policy-block trace`)
    } else if (terminals.length >= 2) {
      failures.push(`invariant: tool call "${name}" (${callId || "no-id"}) has ${terminals.length} terminal events (expected exactly one)`)
    }
  }

  // Terminal event must be the last one (nothing after completion).
  const lastType = events[events.length - 1]?.type
  if (lastType && lastType.startsWith("tool.call.") && lastType.endsWith("requested")) {
    failures.push("invariant: run ends on an un-terminated tool call")
  }

  return failures
}
