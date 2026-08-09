import { createHash } from "node:crypto"
import type { CasDigest } from "./contracts"

function canonicalValue(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null"
  if (value === undefined) throw new Error("canonical JSON rejects undefined values")
  if (typeof value === "bigint") {
    throw new Error("canonical JSON requires bigint values to be encoded explicitly as strings")
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers")
    return JSON.stringify(value)
  }
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("canonical JSON rejects cyclic arrays")
    ancestors.add(value)
    try {
      return `[${Array.from(
        { length: value.length },
        (_, index) => canonicalValue(value[index], ancestors),
      ).join(",")}]`
    } finally {
      ancestors.delete(value)
    }
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("canonical JSON accepts only plain objects")
    }
    if (ancestors.has(value)) throw new Error("canonical JSON rejects cyclic objects")
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error("canonical JSON rejects symbol keys")
    }
    const record = value as Record<string, unknown>
    const descriptors = Object.getOwnPropertyDescriptors(record)
    if (Object.values(descriptors).some(descriptor => descriptor.get || descriptor.set)) {
      throw new Error("canonical JSON rejects accessors")
    }
    if (Object.values(descriptors).some(descriptor => !descriptor.enumerable)) {
      throw new Error("canonical JSON rejects non-enumerable properties")
    }
    ancestors.add(value)
    try {
      const entries = Object.keys(record)
        .sort()
        .map(key => `${JSON.stringify(key)}:${canonicalValue(descriptors[key]!.value, ancestors)}`)
      return `{${entries.join(",")}}`
    } finally {
      ancestors.delete(value)
    }
  }
  throw new Error(`canonical JSON rejects ${typeof value}`)
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value, new Set())
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
