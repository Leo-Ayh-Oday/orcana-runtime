import { createHash } from "node:crypto"
import type { CasDigest } from "./contracts"

function canonicalValue(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (typeof value === "bigint") {
    throw new Error("canonical JSON requires bigint values to be encoded explicitly as strings")
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers")
    return JSON.stringify(value)
  }
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const entries = Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalValue(record[key])}`)
    return `{${entries.join(",")}}`
  }
  throw new Error(`canonical JSON rejects ${typeof value}`)
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value)
}

export function sha256Digest(content: string | Uint8Array): CasDigest {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`
}

export function canonicalDigest(value: unknown): CasDigest {
  return sha256Digest(canonicalJson(value))
}

/** Persisted manifests use UTF-16 code-unit ordering, independent of locale/ICU data. */
export function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function parseCanonicalJson<T>(value: string): T {
  return JSON.parse(value) as T
}
