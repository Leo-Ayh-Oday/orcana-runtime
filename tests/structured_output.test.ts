/** Tests for StructuredOutput — PR-6.4. */
import { describe, expect, test } from "bun:test"
import {
  callWithStructuredOutput,
  zodToJsonSchema,
  objectSchema,
  type StructuredCallOptions,
  type StructuredOutputResult,
} from "../src/agent/structured-output"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"

// ── Zod mock helpers (no zod dependency) ──

function zodString() {
  return { _def: { typeName: "ZodString" } }
}

function zodNumber() {
  return { _def: { typeName: "ZodNumber" } }
}

function zodBoolean() {
  return { _def: { typeName: "ZodBoolean" } }
}

function zodEnum(values: string[]) {
  return { _def: { typeName: "ZodEnum", values } }
}

function zodArray(inner: unknown) {
  return { _def: { typeName: "ZodArray", type: inner } }
}

function zodObject(shape: Record<string, unknown>) {
  return { _def: { typeName: "ZodObject", shape } }
}

function zodOptional(inner: unknown) {
  return { _def: { typeName: "ZodOptional", innerType: inner } }
}

function zodNullable(inner: unknown) {
  return { _def: { typeName: "ZodNullable", innerType: inner } }
}

function zodEffects(inner: unknown) {
  return { _def: { typeName: "ZodEffects", schema: inner } }
}

// ── Mock providers ──

function textProvider(text: string): LLMProvider {
  return {
    async *streamChat(_opts: ProviderCallOptions): AsyncGenerator<StreamEvent> {
      yield { type: "text", data: text }
      yield { type: "done" }
    },
  }
}

function jsonProvider(data: unknown): LLMProvider {
  return textProvider(JSON.stringify(data))
}

function errorProvider(): LLMProvider {
  return {
    async *streamChat(_opts: ProviderCallOptions): AsyncGenerator<StreamEvent> {
      yield { type: "error", data: "provider failure" }
    },
  }
}

function emptyProvider(): LLMProvider {
  return {
    async *streamChat(_opts: ProviderCallOptions): AsyncGenerator<StreamEvent> {
      yield { type: "done" }
    },
  }
}

// ── zodToJsonSchema ──

describe("zodToJsonSchema", () => {
  test("converts ZodString", () => {
    expect(zodToJsonSchema(zodString())).toEqual({ type: "string" })
  })

  test("converts ZodNumber", () => {
    expect(zodToJsonSchema(zodNumber())).toEqual({ type: "number" })
  })

  test("converts ZodBoolean", () => {
    expect(zodToJsonSchema(zodBoolean())).toEqual({ type: "boolean" })
  })

  test("converts ZodEnum", () => {
    expect(zodToJsonSchema(zodEnum(["a", "b", "c"]))).toEqual({
      type: "string",
      enum: ["a", "b", "c"],
    })
  })

  test("converts ZodArray", () => {
    expect(zodToJsonSchema(zodArray(zodString()))).toEqual({
      type: "array",
      items: { type: "string" },
    })
  })

  test("converts ZodObject with required fields", () => {
    const schema = zodToJsonSchema(zodObject({
      name: zodString(),
      age: zodNumber(),
    }))
    expect(schema).toEqual({
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name", "age"],
    })
  })

  test("converts ZodObject with optional fields", () => {
    const schema = zodToJsonSchema(zodObject({
      name: zodString(),
      bio: zodOptional(zodString()),
    }))
    expect(schema).toEqual({
      type: "object",
      properties: { name: { type: "string" }, bio: { type: "string" } },
      required: ["name"], // bio is optional
    })
  })

  test("converts ZodObject with nullable fields", () => {
    const schema = zodToJsonSchema(zodObject({
      name: zodString(),
      age: zodNullable(zodNumber()),
    }))
    const props = (schema as Record<string, unknown>).properties as Record<string, unknown>
    expect(props.age).toEqual({ type: "number", nullable: true })
  })

  test("zodOptional unwraps inner type", () => {
    expect(zodToJsonSchema(zodOptional(zodString()))).toEqual({ type: "string" })
  })

  test("zodNullable wraps inner type with nullable", () => {
    expect(zodToJsonSchema(zodNullable(zodString()))).toEqual({
      type: "string",
      nullable: true,
    })
  })

  test("zodEffects/refine returns inner schema", () => {
    expect(zodToJsonSchema(zodEffects(zodString()))).toEqual({ type: "string" })
  })

  test("unknown type returns minimal object schema", () => {
    expect(zodToJsonSchema(null)).toEqual({ type: "object" })
    expect(zodToJsonSchema({})).toEqual({ type: "object" })
  })
})

// ── objectSchema ──

describe("objectSchema", () => {
  test("creates schema from simple field map", () => {
    const s = objectSchema({ name: "string", count: "number" })
    expect(s).toEqual({
      type: "object",
      properties: { name: { type: "string" }, count: { type: "number" } },
      required: ["name", "count"],
    })
  })

  test("supports enum fields", () => {
    const s = objectSchema({ status: { type: "string", enum: ["a", "b"] } })
    const props = (s as Record<string, unknown>).properties as Record<string, unknown>
    expect(props.status).toEqual({ type: "string", enum: ["a", "b"] })
  })
})

// ── callWithStructuredOutput ──

describe("callWithStructuredOutput", () => {
  test("successful JSON parse returns typed result", async () => {
    const result = await callWithStructuredOutput({
      provider: jsonProvider({ name: "test", value: 42 }),
      model: "deepseek-v4-flash",
      system: "test",
      prompt: "return json",
      schemaName: "test",
      maxRetries: 0,
    })
    expect(result.parsed).toBe(true)
    expect(result.data).toEqual({ name: "test", value: 42 })
    expect(result.source).toBe("api_json")
    expect(result.retries).toBe(0)
  })

  test("retries on JSON parse failure with empty provider", async () => {
    const result = await callWithStructuredOutput({
      provider: emptyProvider(),
      model: "deepseek-v4-flash",
      system: "test",
      prompt: "return json",
      schemaName: "test",
      maxRetries: 1,
    })
    expect(result.parsed).toBe(false)
    expect(result.data).toBeNull()
    expect(result.retries).toBe(1) // both attempts failed
  })

  test("provider error is retried", async () => {
    const result = await callWithStructuredOutput({
      provider: errorProvider(),
      model: "deepseek-v4-flash",
      system: "test",
      prompt: "return json",
      schemaName: "test",
      maxRetries: 1,
    })
    expect(result.data).toBeNull()
    expect(result.error).toBeDefined()
  })

  test("text fallback is used when all retries fail", async () => {
    const result = await callWithStructuredOutput({
      provider: textProvider("not json at all"),
      model: "deepseek-v4-flash",
      system: "test",
      prompt: "write something",
      schemaName: "test",
      maxRetries: 0,
      textFallback: (text: string) => ({ fallback: text }),
    })
    expect(result.parsed).toBe(false)
    expect(result.data).toEqual({ fallback: "not json at all" })
    expect(result.source).toBe("text_fallback")
  })

  test("validator is called on parsed data", async () => {
    const result = await callWithStructuredOutput({
      provider: jsonProvider({ name: "test" }),
      model: "deepseek-v4-flash",
      system: "test",
      prompt: "return json",
      schemaName: "test",
      maxRetries: 0,
      validator: (data: unknown) => {
        const d = data as Record<string, unknown>
        return { validatedName: d.name }
      },
    })
    expect(result.data).toEqual({ validatedName: "test" })
  })

  test("validator rejection causes retry", async () => {
    let calls = 0
    const failingProvider: LLMProvider = {
      async *streamChat(_opts: ProviderCallOptions): AsyncGenerator<StreamEvent> {
        calls++
        if (calls === 1) {
          yield { type: "text", data: JSON.stringify({ name: "bad" }) }
        } else {
          yield { type: "text", data: JSON.stringify({ name: "good" }) }
        }
        yield { type: "done" }
      },
    }

    const result = await callWithStructuredOutput({
      provider: failingProvider,
      model: "deepseek-v4-flash",
      system: "test",
      prompt: "return json",
      schemaName: "test",
      maxRetries: 1,
      validator: (data: unknown) => {
        const d = data as Record<string, unknown>
        if (d.name === "bad") throw new Error("bad name")
        return d as { name: string }
      },
    })
    expect(result.parsed).toBe(true)
    expect(result.data).toEqual({ name: "good" })
    expect(result.retries).toBe(1) // first attempt failed validation
  })

  test("markdown fenced JSON is extracted", async () => {
    const result = await callWithStructuredOutput({
      provider: textProvider('```json\n{"key": "value"}\n```'),
      model: "deepseek-v4-flash",
      system: "test",
      prompt: "return json",
      schemaName: "test",
      maxRetries: 0,
    })
    expect(result.parsed).toBe(true)
    expect(result.data).toEqual({ key: "value" })
  })

  test("regex extracts JSON from messy text", async () => {
    const result = await callWithStructuredOutput({
      provider: textProvider('Here is the answer: {"status": "ok"} and more text'),
      model: "deepseek-v4-flash",
      system: "test",
      prompt: "return json",
      schemaName: "test",
      maxRetries: 0,
    })
    expect(result.parsed).toBe(true)
    expect(result.data).toEqual({ status: "ok" })
    expect(result.source).toBe("regex_extract")
  })

  test("useApiFormat=false skips api-level format", async () => {
    const result = await callWithStructuredOutput({
      provider: jsonProvider({ test: true }),
      model: "deepseek-v4-flash",
      system: "test",
      prompt: "return json",
      schemaName: "test",
      maxRetries: 0,
      useApiFormat: false,
    })
    expect(result.parsed).toBe(true)
    expect(result.data).toEqual({ test: true })
    expect(result.source).toBe("prompt_json")
  })
})
