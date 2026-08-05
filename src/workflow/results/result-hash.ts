/** Stable result hashing (G0, consumed by G1 result caching).
 *
 *  stableHash produces a deterministic hash for any JSON-serializable
 *  value: object keys are sorted recursively so equal logical values
 *  always hash equal, regardless of key insertion order.
 *
 *  Deterministic-logic nodes (read-only tools, reducers) will key their
 *  caches on this hash in G1 — the G0 deliverable is the primitive plus
 *  its correctness tests, wired nowhere in the hot path.
 */

import { createHash } from "node:crypto"

/** Serialize a JSON value with recursively sorted object keys. */
export function stableSerialize(value: unknown): string {
  return stableStringify(value)
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null"
  const t = typeof value
  if (t === "number" || t === "boolean") return JSON.stringify(value)
  if (t === "string") return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`
  }
  if (t === "object") {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const parts = keys.map(k => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    return `{${parts.join(",")}}`
  }
  // Functions/symbols/bigints cannot appear in trace-valid JSON; hash as
  // their string form rather than throwing in a telemetry path.
  return JSON.stringify(String(value))
}

/** Stable sha256 hex digest (64 chars) of a JSON value. */
export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value), "utf-8").digest("hex")
}

/** Stable sha256 hex digest of a string. */
export function stableHashString(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex")
}
