/** Legacy trace migration (H5, plan §12.4).
 *
 *  The pre-Harness AgentRunTrace wrote `{ runId, timestamp, type, data }`
 *  JSONL lines. migrateLegacyTraceLine() converts one such line into a typed
 *  EventEnvelope so old traces stay readable by shared types; unknown or
 *  corrupt lines return null (skip).
 */

import { randomUUID } from "node:crypto"
import { HARNESS_EVENT_SCHEMA_VERSION } from "../contracts/events"
import type { EventEnvelope } from "../contracts/events"

interface LegacyTraceLine {
  runId?: unknown
  timestamp?: unknown
  type?: unknown
  data?: unknown
}

export function migrateLegacyTraceLine(line: string, sequenceOffset = 0): EventEnvelope<unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const record = parsed as LegacyTraceLine
  if (typeof record.type !== "string") return null
  const runId = typeof record.runId === "string" ? record.runId : "legacy"
  return {
    schemaVersion: HARNESS_EVENT_SCHEMA_VERSION,
    eventId: randomUUID(),
    sequence: sequenceOffset + 1,
    runId,
    sessionId: "legacy",
    type: record.type,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString(),
    payload: { legacy: record.data },
  }
}

/** Migrate an entire legacy JSONL trace file into envelopes (ordered). */
export function migrateLegacyTrace(text: string): Array<EventEnvelope<unknown>> {
  const envelopes: Array<EventEnvelope<unknown>> = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    const envelope = migrateLegacyTraceLine(line, envelopes.length)
    if (envelope) envelopes.push(envelope)
  }
  return envelopes
}
