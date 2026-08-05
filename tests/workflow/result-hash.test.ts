/** G0: stable result hashing — determinism and collision sanity. */

import { describe, expect, test } from "bun:test"
import { stableHash, stableHashString, stableSerialize } from "../../src/workflow/results/result-hash"

describe("stableSerialize (G0)", () => {
  test("key order does not change the serialization", () => {
    expect(stableSerialize({ a: 1, b: 2 })).toBe(stableSerialize({ b: 2, a: 1 }))
  })

  test("nested objects are sorted recursively", () => {
    expect(stableSerialize({ z: { b: 1, a: 2 }, y: 3 })).toBe(stableSerialize({ y: 3, z: { a: 2, b: 1 } }))
  })

  test("arrays preserve order", () => {
    expect(stableSerialize([1, 2])).toBe("[1,2]")
    expect(stableSerialize([2, 1])).not.toBe("[1,2]")
  })

  test("value types are preserved", () => {
    expect(stableSerialize(1)).toBe("1")
    expect(stableSerialize("1")).toBe('"1"')
    expect(stableSerialize(null)).toBe("null")
    expect(stableSerialize(undefined)).toBe("null")
  })
})

describe("stableHash (G0)", () => {
  test("equal logical values hash equal", () => {
    expect(stableHash({ path: "src/a.ts", mode: "read" })).toBe(stableHash({ mode: "read", path: "src/a.ts" }))
  })

  test("different values hash different", () => {
    expect(stableHash({ path: "src/a.ts" })).not.toBe(stableHash({ path: "src/b.ts" }))
    expect(stableHash(1)).not.toBe(stableHash("1"))
  })

  test("sha256 hex digest, 64 chars", () => {
    expect(stableHash("x")).toMatch(/^[0-9a-f]{64}$/)
    expect(stableHashString("x")).toMatch(/^[0-9a-f]{64}$/)
  })

  test("stable across calls", () => {
    const input = { tool: "read_file", input: { path: "a", startLine: 1 } }
    expect(stableHash(input)).toBe(stableHash(input))
  })
})
