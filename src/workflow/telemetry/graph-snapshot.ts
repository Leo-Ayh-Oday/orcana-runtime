/** Graph snapshot serialization (G0).
 *
 *  Snapshot payloads are projected from trace events (never from raw tool
 *  I/O) and pass through redactForTrace at the write boundary, so a
 *  snapshot is safe to store and safe to diff across runs.
 */

import { redactForTrace } from "../../agent/secret-redactor"
import type { WorkflowSnapshot } from "../types"

export const WORKFLOW_SNAPSHOT_SCHEMA = "0.1" as const

/** Serialize a snapshot to the canonical JSON string (redacted + stable). */
export function serializeSnapshot(snapshot: WorkflowSnapshot): string {
  return `${JSON.stringify(redactForTrace(snapshot), null, 2)}\n`
}

/** Parse a snapshot back from its canonical JSON string.
 *  @throws on invalid payloads (non-object, wrong schema version). */
export function deserializeSnapshot(raw: string): WorkflowSnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`workflow: snapshot is not valid JSON: ${String(error)}`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("workflow: snapshot must be a JSON object")
  }
  const snapshot = parsed as Partial<WorkflowSnapshot>
  if (snapshot.schemaVersion !== WORKFLOW_SNAPSHOT_SCHEMA) {
    throw new Error(`workflow: unsupported snapshot schema "${String(snapshot.schemaVersion)}"`)
  }
  if (typeof snapshot.runId !== "string" || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) {
    throw new Error("workflow: snapshot missing runId/nodes/edges")
  }
  return snapshot as WorkflowSnapshot
}
