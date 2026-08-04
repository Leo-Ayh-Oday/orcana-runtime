import { describe, expect, test } from "bun:test"
import { validateJsonSchema } from "../../src/harness/capabilities/schema-validator"
import { validateJsonSchema as legacy } from "../../src/harness/interrupts/response-validator"
import type { JsonSchema } from "../../src/harness/contracts/schema"

// RT-1: the shared schema validator (moved verbatim from interrupt response
// validation) — behavior is identical through both entry points.

const OBJECT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    // The shared validator is typeof-based: JSON integers surface as
    // "number" — schemas declare number (existing H7 semantics, unchanged).
    count: { type: "number" },
    tags: { type: "array", items: { type: "string" } },
    mode: { type: "string", enum: ["auto", "confirm", "strict"] },
  },
  required: ["path"],
}

describe("RT-1 schema validator", () => {
  test("valid object passes with no errors", () => {
    expect(validateJsonSchema({ path: "a.ts", count: 3, tags: ["x"], mode: "auto" }, OBJECT_SCHEMA)).toEqual([])
  })

  test("missing required property fails", () => {
    const errors = validateJsonSchema({ count: 1 }, OBJECT_SCHEMA)
    expect(errors.some((e) => e.includes("path: required property missing"))).toBe(true)
  })

  test("wrong type fails", () => {
    const errors = validateJsonSchema({ path: "a.ts", count: "not-a-number" }, OBJECT_SCHEMA)
    expect(errors.some((e) => e.includes("$.count"))).toBe(true)
  })

  test("enum violation fails", () => {
    const errors = validateJsonSchema({ path: "a.ts", mode: "bogus" }, OBJECT_SCHEMA)
    expect(errors.some((e) => e.includes("value not in enum"))).toBe(true)
  })

  test("array item validation", () => {
    const errors = validateJsonSchema({ path: "a.ts", tags: [1, "ok"] }, OBJECT_SCHEMA)
    expect(errors.some((e) => e.includes("$.tags[0]"))).toBe(true)
  })

  test("null vs null-schema", () => {
    expect(validateJsonSchema(null, { type: "null" })).toEqual([])
    expect(validateJsonSchema(null, { type: "string" })).not.toEqual([])
  })

  test("unions of types accept any member", () => {
    const schema: JsonSchema = { type: ["string", "null"] }
    expect(validateJsonSchema("x", schema)).toEqual([])
    expect(validateJsonSchema(null, schema)).toEqual([])
    expect(validateJsonSchema(42, schema)).not.toEqual([])
  })

  test("legacy entry point is byte-identical behavior", () => {
    const input = { path: "a.ts", count: "x" }
    expect(validateJsonSchema(input, OBJECT_SCHEMA)).toEqual(legacy(input, OBJECT_SCHEMA))
  })
})
