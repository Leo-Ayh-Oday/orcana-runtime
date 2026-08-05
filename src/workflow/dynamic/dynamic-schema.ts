/** Dynamic graph JSON schema (G6): the only shape a model may produce.
 *
 *  parseDynamicSpec is a pure JSON parse — no eval, no code execution,
 *  no prototypes. Anything that is not JSON, or not an object with the
 *  declared fields, is rejected before it can reach the compiler.
 */

import type { WorkflowSpec } from "../types"

export interface DynamicNodePayload {
  id: string
  /** Registered node type: read | write | verify | reduce. */
  type?: "read" | "write" | "verify" | "reduce"
  handler: string
  input: Record<string, unknown>
  dependsOn?: string[]
}

export interface DynamicGraphPayload {
  schemaVersion: "0.1"
  specId: string
  mode?: "readonly" | "read-write"
  maxParallel?: number
  nodes: DynamicNodePayload[]
}

/** Registered node types (G6) — a node's type must agree with its handler. */
export const DYNAMIC_NODE_TYPES = ["read", "write", "verify", "reduce"] as const

export type DynamicNodeType = (typeof DYNAMIC_NODE_TYPES)[number]

export interface DynamicParseError {
  ok: false
  reason: string
}

export type DynamicParseResult = { ok: true; payload: DynamicGraphPayload } | DynamicParseError

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseNodes(value: unknown, path: string): DynamicNodePayload[] | null {
  if (!Array.isArray(value)) return null
  const nodes: DynamicNodePayload[] = []
  for (let i = 0; i < value.length; i++) {
    const item = value[i] as Record<string, unknown>
    if (!isPlainObject(item)) return null
    if (typeof item["id"] !== "string" || typeof item["handler"] !== "string") return null
    if (item["type"] !== undefined && !DYNAMIC_NODE_TYPES.includes(item["type"] as DynamicNodeType)) return null
    if (!isPlainObject(item["input"])) return null
    if (item["dependsOn"] !== undefined && !Array.isArray(item["dependsOn"])) return null
    nodes.push({
      id: item["id"],
      type: item["type"] as DynamicNodeType | undefined,
      handler: item["handler"],
      input: item["input"] as Record<string, unknown>,
      dependsOn: (item["dependsOn"] as string[] | undefined)?.filter(d => typeof d === "string"),
    })
  }
  return nodes
}

/** Parse untrusted model JSON into a validated structural payload. */
export function parseDynamicSpec(raw: unknown, path = "dynamic"): DynamicParseResult {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw)
    } catch {
      return { ok: false, reason: `${path}: not valid JSON` }
    }
  }
  if (!isPlainObject(raw)) {
    return { ok: false, reason: `${path}: must be a JSON object` }
  }
  if (raw["schemaVersion"] !== "0.1" && raw["schemaVersion"] !== "0.2") {
    return { ok: false, reason: `${path}: schemaVersion must be "0.1" or "0.2"` }
  }
  if (typeof raw["specId"] !== "string") {
    return { ok: false, reason: `${path}: specId must be a string` }
  }
  if (raw["mode"] !== undefined && raw["mode"] !== "readonly" && raw["mode"] !== "read-write") {
    return { ok: false, reason: `${path}: mode must be "readonly" or "read-write"` }
  }
  if (raw["maxParallel"] !== undefined && (typeof raw["maxParallel"] !== "number" || raw["maxParallel"] < 1)) {
    return { ok: false, reason: `${path}: maxParallel must be a positive integer` }
  }
  const nodes = parseNodes(raw["nodes"], `${path}.nodes`)
  if (!nodes) {
    return { ok: false, reason: `${path}.nodes: each node needs id/handler/input and optional type/dependsOn` }
  }
  if (nodes.length === 0) {
    return { ok: false, reason: `${path}.nodes: at least one node required` }
  }
  return {
    ok: true,
    payload: {
      schemaVersion: "0.1",
      specId: raw["specId"],
      mode: raw["mode"] as "readonly" | "read-write" | undefined,
      maxParallel: raw["maxParallel"] as number | undefined,
      nodes,
    },
  }
}

/** Cast a parsed payload to the spec shape (compile step, not validation). */
export function payloadToSpec(payload: DynamicGraphPayload): WorkflowSpec {
  return {
    schemaVersion: "0.1",
    specId: payload.specId,
    mode: payload.mode ?? "readonly",
    maxParallel: payload.maxParallel,
    nodes: payload.nodes.map(n => ({
      id: n.id,
      handler: n.handler,
      input: n.input,
      dependsOn: n.dependsOn ?? [],
    })),
  }
}
