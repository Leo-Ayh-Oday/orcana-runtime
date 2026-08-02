import type { AgentRunState } from "./types"

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type AgentRunSnapshot = Readonly<{ [key: string]: JsonValue }>

function toJsonValue(value: unknown, seen: WeakSet<object>): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "bigint") return String(value)
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined

  if (typeof value !== "object") return String(value)
  if (seen.has(value)) throw new TypeError("AgentRunState contains a circular reference")
  seen.add(value)

  let result: JsonValue
  if (Array.isArray(value)) {
    result = value
      .map(item => toJsonValue(item, seen))
      .filter((item): item is JsonValue => item !== undefined)
  } else if (value instanceof Set) {
    result = [...value]
      .map(item => toJsonValue(item, seen))
      .filter((item): item is JsonValue => item !== undefined)
  } else if (value instanceof Date) {
    result = value.toISOString()
  } else {
    const record: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      const converted = toJsonValue(item, seen)
      if (converted !== undefined) record[key] = converted
    }
    result = record
  }

  seen.delete(value)
  return result
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child)
  }
  return value
}

/**
 * Produces a detached, JSON-safe, deeply frozen projection. AgentRunState does
 * not contain services, so Provider/Tool/Hook/Sandbox capabilities cannot leak
 * into persistence through this API.
 */
export function snapshotAgentRunState(state: AgentRunState): AgentRunSnapshot {
  const snapshot = toJsonValue(state, new WeakSet())
  if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object") {
    throw new TypeError("AgentRunState snapshot must be an object")
  }
  return deepFreeze(snapshot) as AgentRunSnapshot
}
