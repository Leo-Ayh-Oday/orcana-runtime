/** Unified structured output — fail-closed JSON extraction with retry + fallback.
 *
 *  PR-6.4: Provides a single API for requesting structured JSON output from
 *  any LLM provider. Handles:
 *    - API-level response_format (where supported by the provider)
 *    - Prompt-level JSON instruction (universal fallback)
 *    - JSON parsing with regex extraction
 *    - Retry on parse failure (up to maxRetries)
 *    - Fallback to text-mode extraction
 *    - Zod schema validation
 *
 *  Design invariants:
 *    - Fail closed: invalid JSON never silently passes
 *    - Fallback chain: API format → prompt JSON → regex extraction → text fallback
 *    - Typed: generic <T> ensures callers get typed results
 */

import type { LLMProvider, ProviderCallOptions, ProviderCallPurpose, StructuredOutputRequest } from "../provider/types"

// ── Types ──

export interface StructuredOutputResult<T> {
  /** Parsed and validated data, or null if extraction failed. */
  data: T | null
  /** Raw response text from the model. */
  rawText: string
  /** Whether the output was successfully parsed as valid JSON. */
  parsed: boolean
  /** Number of retries attempted. */
  retries: number
  /** Error message if parsing failed. */
  error?: string
  /** Which extraction method succeeded. */
  source: "api_json" | "prompt_json" | "regex_extract" | "text_fallback" | "none"
}

export interface StructuredCallOptions<T> {
  provider: LLMProvider
  model: string
  purpose?: ProviderCallPurpose
  system: string
  prompt: string
  /** JSON Schema for the expected output shape. */
  schema?: Record<string, unknown>
  /** Schema name (required for some providers). */
  schemaName: string
  /** Max tokens for the response. */
  maxTokens?: number
  /** Max retries on parse failure. */
  maxRetries?: number
  /** Abort signal. */
  abortSignal?: AbortSignal
  /** Optional Zod validator — runs after JSON parse. */
  validator?: (data: unknown) => T
  /** Optional text fallback parser. */
  textFallback?: (text: string) => T
  /** Whether to use API-level structured output (default: true). */
  useApiFormat?: boolean
}

// ── Constants ──

const DEFAULT_MAX_RETRIES = 1
const DEFAULT_MAX_TOKENS = 1024

// ── Public API ──

/**
 * Call an LLM with structured JSON output. Handles retry + fallback automatically.
 *
 * Flow:
 *   1. Try API-level response_format (json_schema or json_object)
 *   2. On parse failure → retry with prompt-level JSON instruction
 *   3. On 2nd failure → regex extract JSON from response
 *   4. On 3rd failure → text fallback parser (if provided)
 *   5. If Zod validator provided → validate parsed data
 *
 * Returns StructuredOutputResult<T> — caller checks .data for null.
 */
export async function callWithStructuredOutput<T>(
  options: StructuredCallOptions<T>,
): Promise<StructuredOutputResult<T>> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS

  let lastText = ""
  let lastError: string | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const useApiFormat = options.useApiFormat !== false && attempt === 0

    const callOpts: ProviderCallOptions = {
      model: options.model,
      purpose: options.purpose,
      system: options.system,
      messages: [{ role: "user", content: options.prompt }],
      maxTokens,
      abortSignal: options.abortSignal,
    }

    // First attempt: use API-level structured output if supported
    if (useApiFormat && options.schema) {
      callOpts.responseFormat = {
        type: "json_schema",
        schema: options.schema,
        name: options.schemaName,
        strict: true,
      }
    } else if (useApiFormat) {
      callOpts.responseFormat = {
        type: "json_object",
        name: options.schemaName,
      }
    }

    // Retry: inject explicit JSON instruction into prompt
    if (attempt > 0) {
      callOpts.messages = [
        { role: "user", content: `${options.prompt}\n\n严格输出 JSON，不要其他文字。` },
      ]
    }

    // Collect response
    const events: string[] = []
    try {
      for await (const event of options.provider.streamChat(callOpts)) {
        if (event.type === "text" && typeof event.data === "string") {
          events.push(event.data as string)
          lastText += event.data as string
        }
        if (event.type === "error") break
        if (event.type === "done") break
      }
    } catch (e) {
      lastError = `Provider error: ${e instanceof Error ? e.message : String(e)}`
      continue
    }

    const rawText = events.join("").trim()
    if (!rawText) {
      lastError = "Empty response"
      continue
    }

    // Try to parse as JSON
    const parsed = tryParseStructuredResponse(rawText)
    if (parsed !== null) {
      // Optional Zod validation
      if (options.validator) {
        try {
          const validated = options.validator(parsed)
          return {
            data: validated,
            rawText,
            parsed: true,
            retries: attempt,
            source: useApiFormat ? "api_json" : "prompt_json",
          }
        } catch (e) {
          lastError = `Validation error: ${e instanceof Error ? e.message : String(e)}`
          continue
        }
      }

      return {
        data: parsed as T,
        rawText,
        parsed: true,
        retries: attempt,
        source: useApiFormat ? "api_json" : "prompt_json",
      }
    }

    // Regex extraction attempt
    const regexExtracted = regexExtractJson(rawText)
    if (regexExtracted !== null) {
      if (options.validator) {
        try {
          const validated = options.validator(regexExtracted)
          return {
            data: validated,
            rawText,
            parsed: true,
            retries: attempt,
            source: "regex_extract",
          }
        } catch {
          // Fall through
        }
      } else {
        return {
          data: regexExtracted as T,
          rawText,
          parsed: true,
          retries: attempt,
          source: "regex_extract",
        }
      }
    }

    lastError = `JSON parse failed after ${attempt + 1} attempt(s)`
  }

  // Final fallback: text-based extraction
  if (options.textFallback) {
    try {
      const fallbackData = options.textFallback(lastText)
      return {
        data: fallbackData,
        rawText: lastText,
        parsed: false,
        retries: maxRetries,
        source: "text_fallback",
      }
    } catch {
      // Fall through to final failure
    }
  }

  return {
    data: null,
    rawText: lastText,
    parsed: false,
    retries: maxRetries,
    error: lastError ?? "Unknown error",
    source: "none",
  }
}

// ── JSON extraction ──

/**
 * Try to parse a response as JSON. Strips markdown fences first.
 */
function tryParseStructuredResponse(text: string): unknown | null {
  // Strip markdown fences
  let cleaned = text
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?\s*```$/i, "")
    .trim()

  try {
    return JSON.parse(cleaned)
  } catch {
    // Try extracting from markdown block
    const fence = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i.exec(text)
    if (fence?.[1]) {
      try {
        return JSON.parse(fence[1].trim())
      } catch {
        // Continue to regex extraction
      }
    }
    return null
  }
}

/**
 * Regex-based JSON extraction — finds the first `{...}` or `[...]` block.
 */
function regexExtractJson(text: string): unknown | null {
  // Try object first
  const objMatch = /\{[\s\S]*\}/.exec(text)
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0])
    } catch {
      // Try array
    }
  }

  // Try array
  const arrMatch = /\[[\s\S]*\]/.exec(text)
  if (arrMatch) {
    try {
      return JSON.parse(arrMatch[0])
    } catch {
      // Give up
    }
  }

  return null
}

// ── Zod → JSON Schema converter (PR-6.4) ──

/**
 * Convert a subset of Zod schemas to JSON Schema.
 *
 * Covers the most common cases: object, string, number, boolean, enum,
 * array, optional, nullable. For complex schemas (union, discriminated
 * union, transform, refine), returns a minimal schema with additional
 * validation deferred to the Zod validator callback.
 */
export function zodToJsonSchema(schema: unknown): Record<string, unknown> {
  // We use duck-typing on the Zod schema internals since Zod types
  // are complex and we want to avoid a zod dependency here.
  const s = schema as Record<string, unknown>
  if (!s || typeof s !== "object") {
    return { type: "object" }
  }

  const def = s._def as Record<string, unknown> | undefined
  if (!def) return { type: "object" }

  const typeName = def.typeName as string

  switch (typeName) {
    case "ZodString":
      return { type: "string" }
    case "ZodNumber":
      return { type: "number" }
    case "ZodBoolean":
      return { type: "boolean" }
    case "ZodEnum": {
      const values = def.values as unknown[]
      return { type: "string", enum: values }
    }
    case "ZodArray": {
      const innerType = def.type as unknown
      return { type: "array", items: zodToJsonSchema(innerType) }
    }
    case "ZodObject": {
      const shape = def.shape as Record<string, unknown> | undefined
      if (!shape) return { type: "object" }
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const [key, value] of Object.entries(shape)) {
        const fieldDef = (value as Record<string, unknown>)?._def as Record<string, unknown> | undefined
        // Check if optional
        if (fieldDef?.typeName === "ZodOptional") {
          properties[key] = zodToJsonSchema((fieldDef as Record<string, unknown>).innerType)
        } else if (fieldDef?.typeName === "ZodNullable") {
          const inner = zodToJsonSchema((fieldDef as Record<string, unknown>).innerType)
          properties[key] = { ...inner, nullable: true }
        } else {
          properties[key] = zodToJsonSchema(value)
          required.push(key)
        }
      }
      const result: Record<string, unknown> = { type: "object", properties }
      if (required.length > 0) {
        result.required = required
      }
      return result
    }
    case "ZodOptional": {
      return zodToJsonSchema(def.innerType)
    }
    case "ZodNullable": {
      const inner = zodToJsonSchema(def.innerType)
      return { ...inner, nullable: true }
    }
    case "ZodEffects":
    case "ZodTransformer":
      // Transform/refine — return inner schema, defer validation to Zod
      return zodToJsonSchema(def.schema ?? def.innerType)
    case "ZodDefault":
      return zodToJsonSchema(def.innerType)
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
    case "ZodIntersection":
    case "ZodTuple":
    case "ZodRecord":
    case "ZodLiteral":
    default:
      // Complex types — return minimal schema
      return { type: "object" }
  }
}

/**
 * Create a simple JSON Schema from a plain object shape description.
 * For use when Zod is not available.
 */
export function objectSchema(fields: Record<string, string | { type: string; enum?: unknown[] }>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, type] of Object.entries(fields)) {
    if (typeof type === "string") {
      properties[key] = { type }
    } else {
      properties[key] = { ...type }
    }
    required.push(key)
  }
  return { type: "object", properties, required }
}
