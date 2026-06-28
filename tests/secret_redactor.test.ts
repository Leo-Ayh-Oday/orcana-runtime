/** Tests for SecretRedactor — PR-5.4 unified secret redaction.
 *
 *  ALL test values use obviously-fake placeholder strings (xxx/XXXX)
 *  to avoid triggering GitHub secret scanning false positives.
 *  The regex patterns still match these placeholders — the tests
 *  validate redaction logic, not real credential formats.
 */
import { describe, expect, test } from "bun:test"
import {
  redact,
  redactForTrace,
  redactForCheckpoint,
  redactForEvidence,
  redactForToolOutput,
  containsSecret,
} from "../src/agent/secret-redactor"

// ── Key-based redaction ──

describe("redact — key-based", () => {
  test("redacts api_key value", () => {
    const result = redact({ api_key: "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }) as Record<string, unknown>
    expect(result.api_key).toBe("[redacted]")
  })

  test("redacts token value", () => {
    const result = redact({ token: "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }) as Record<string, unknown>
    expect(result.token).toBe("[redacted]")
  })

  test("redacts Authorization header", () => {
    const result = redact({ Authorization: "Bearer sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxx" }) as Record<string, unknown>
    expect(result.Authorization).toBe("[redacted]")
  })

  test("redacts password field", () => {
    const result = redact({ password: "supers3cret!" }) as Record<string, unknown>
    expect(result.password).toBe("[redacted]")
  })

  test("redacts secret field", () => {
    const result = redact({ client_secret: "abc123" }) as Record<string, unknown>
    expect(result.client_secret).toBe("[redacted]")
  })

  test("redacts credentials field", () => {
    const result = redact({ credentials: { user: "admin", pass: "secret" } }) as Record<string, unknown>
    expect(result.credentials).toBe("[redacted]")
  })

  test("redacts private_key", () => {
    const result = redact({ private_key: "-----BEGIN PRIVATE KEY-----\nxxx-placeholder\n-----END PRIVATE KEY-----" }) as Record<string, unknown>
    expect(result.private_key).toBe("[redacted]")
  })

  test("redacts JWT/signing_key", () => {
    const result = redact({ signing_key: "hmac-placeholder-xxx" }) as Record<string, unknown>
    expect(result.signing_key).toBe("[redacted]")
  })

  test("normal keys pass through unchanged", () => {
    const result = redact({ name: "test", count: 42, enabled: true }) as Record<string, unknown>
    expect(result.name).toBe("test")
    expect(result.count).toBe(42)
    expect(result.enabled).toBe(true)
  })

  test("nested objects: secret keys at any depth are redacted", () => {
    const result = redact({
      config: { api_key: "sk-xxxxxxxxxxxxxxxxxxxxxxxx" },
      env: { DB_PASSWORD: "db-placeholder" },
    }) as Record<string, unknown>
    const config = result.config as Record<string, unknown>
    expect(config.api_key).toBe("[redacted]")
    const env = result.env as Record<string, unknown>
    expect(env.DB_PASSWORD).toBe("[redacted]")
  })
})

// ── Content-based redaction ──

describe("redact — content-based", () => {
  test("redacts OpenAI-style API key in string", () => {
    const result = redact({ value: "sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" })
    const obj = result as Record<string, unknown>
    expect(obj.value).toBe("[redacted]")
  })

  test("redacts Anthropic API key", () => {
    const result = redact({ value: "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" })
    const obj = result as Record<string, unknown>
    expect(obj.value).toBe("[redacted]")
  })

  test("redacts DeepSeek API key", () => {
    const result = redact({ value: "dsk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx" })
    const obj = result as Record<string, unknown>
    expect(obj.value).toBe("[redacted]")
  })

  test("redacts AWS access key", () => {
    const result = redact({ value: "AKIAXXXXXXXXXXXXXXXX" })
    const obj = result as Record<string, unknown>
    expect(obj.value).toBe("[redacted]")
  })

  test("redacts GitHub PAT", () => {
    const result = redact({ value: "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" })
    const obj = result as Record<string, unknown>
    expect(obj.value).toBe("[redacted]")
  })

  test("redacts private key block", () => {
    const result = redact({ value: "-----BEGIN PRIVATE KEY-----\nXXX-PLACEHOLDER-KEY-DATA-XXX\n-----END PRIVATE KEY-----" })
    const obj = result as Record<string, unknown>
    expect(obj.value).toBe("[redacted]")
  })

  test("redacts EC private key", () => {
    const result = redact({ value: "-----BEGIN EC PRIVATE KEY-----\nXXX-PLACEHOLDER-EC-KEY-XXX\n-----END EC PRIVATE KEY-----" })
    const obj = result as Record<string, unknown>
    expect(obj.value).toBe("[redacted]")
  })

  test("redacts JWT token", () => {
    const result = redact({ value: "eyJxxxxxxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxxxxxxxx" })
    const obj = result as Record<string, unknown>
    expect(obj.value).toBe("[redacted]")
  })

  test("redacts MongoDB connection string", () => {
    const result = redact({ value: "mongodb://xxxxxxxx:xxxxxxxx@xxxxxxxx.xxxxxxx.xxx/xx" })
    const obj = result as Record<string, unknown>
    expect(obj.value).toBe("[redacted]")
  })

  test("redacts PostgreSQL connection string", () => {
    const result = redact({ value: "postgresql://xxxxxxxx:xxxxxxxx@xxxxxxxxxxxx:xxxx/xx" })
    const obj = result as Record<string, unknown>
    expect(obj.value).toBe("[redacted]")
  })

  test("normal strings pass through", () => {
    const result = redact({ value: "just a normal string" })
    const obj = result as Record<string, unknown>
    expect(obj.value).toBe("just a normal string")
  })

  test("URLs without credentials pass through", () => {
    const result = redact({ value: "https://example.com/api/v1" })
    const obj = result as Record<string, unknown>
    expect(obj.value).toBe("https://example.com/api/v1")
  })
})

// ── Structural limits ──

describe("redact — structural limits", () => {
  test("truncates long strings", () => {
    const long = "a".repeat(3000)
    const result = redact({ text: long }, { maxStringLength: 100 })
    const obj = result as Record<string, unknown>
    expect(String(obj.text)).toContain("[truncated]")
    expect(String(obj.text).length).toBeLessThan(200)
  })

  test("truncates at depth limit", () => {
    const deep = { a: { b: { c: { d: { e: { f: "too deep" } } } } } }
    const result = redact(deep, { maxDepth: 2 })
    const obj = result as Record<string, unknown>
    const a = obj.a as Record<string, unknown>
    const b = a.b as Record<string, unknown>
    const c = b.c
    expect(c).toBe("...[truncated]")
  })

  test("truncates large arrays", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i)
    const result = redact(arr) as unknown[]
    expect(result.length).toBeLessThanOrEqual(50)
  })

  test("null and undefined pass through", () => {
    expect(redact(null)).toBe(null)
    expect(redact(undefined)).toBe(undefined)
  })

  test("numbers and booleans pass through", () => {
    expect(redact(42)).toBe(42)
    expect(redact(true)).toBe(true)
    expect(redact(false)).toBe(false)
  })
})

// ── Channel-specific redactors ──

describe("channel-specific redactors", () => {
  test("redactForTrace redacts secrets", () => {
    const result = redactForTrace({ api_key: "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }) as Record<string, unknown>
    expect(result.api_key).toBe("[redacted]")
  })

  test("redactForCheckpoint redacts secrets with shorter string limit", () => {
    const result = redactForCheckpoint({ api_key: "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", long: "a".repeat(2000) }) as Record<string, unknown>
    expect(result.api_key).toBe("[redacted]")
    expect(String(result.long)).toContain("[truncated]")
  })

  test("redactForEvidence redacts secrets", () => {
    const result = redactForEvidence({ token: "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxx" }) as Record<string, unknown>
    expect(result.token).toBe("[redacted]")
  })

  test("redactForToolOutput has larger string limit", () => {
    const result = redactForToolOutput({ api_key: "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", text: "a".repeat(2000) }) as Record<string, unknown>
    expect(result.api_key).toBe("[redacted]")
    // 2000 chars should NOT be truncated in tool output (5000 limit)
    expect(String(result.text)).not.toContain("[truncated]")
  })
})

// ── Extra patterns ──

describe("redact — extra patterns", () => {
  test("extra key patterns are applied", () => {
    const result = redact(
      { my_custom_field: "sensitive-data" },
      { extraKeyPatterns: [/my_custom_field/i] },
    ) as Record<string, unknown>
    expect(result.my_custom_field).toBe("[redacted]")
  })

  test("extra content patterns are applied", () => {
    const result = redact(
      { value: "company-secret-XXXX-YYYY" },
      { extraContentPatterns: [/company-secret-\w+-\w+/i] },
    ) as Record<string, unknown>
    expect(result.value).toBe("[redacted]")
  })
})

// ── containsSecret ──

describe("containsSecret", () => {
  test("detects API key", () => {
    expect(containsSecret("sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxx")).toBe(true)
  })

  test("detects private key", () => {
    expect(containsSecret("-----BEGIN PRIVATE KEY-----\nXXX-PLACEHOLDER")).toBe(true)
  })

  test("detects GitHub token", () => {
    expect(containsSecret("ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toBe(true)
  })

  test("normal text returns false", () => {
    expect(containsSecret("just a normal string")).toBe(false)
  })

  test("empty string returns false", () => {
    expect(containsSecret("")).toBe(false)
  })
})
