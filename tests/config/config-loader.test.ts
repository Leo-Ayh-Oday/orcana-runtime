/** Tests for config-loader — JSONC parsing, deep merge, role resolution, and config loading. */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  stripJsoncComments,
  parseJsonc,
  deepMerge,
  loadConfig,
  listProviderIds,
  resolveModelForRole,
  findProviderForModel,
} from "../../src/config/config-loader"
import { defaultConfig, type OrcanaConfig } from "../../src/config/config-schema"

// ── Temp dir for file-based tests ──

let tempDir: string

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "config-loader-test-"))
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

// ── stripJsoncComments ──

describe("stripJsoncComments", () => {
  test("removes single-line comments", () => {
    const input = '{"a": 1 // this is a comment\n}'
    const out = stripJsoncComments(input)
    expect(out).not.toContain("this is a comment")
    expect(out).not.toContain("//")
    expect(JSON.parse(out)).toEqual({ a: 1 })
  })

  test("removes block comments", () => {
    const input = '{"a": /* block comment */ 1}'
    const out = stripJsoncComments(input)
    expect(out).not.toContain("block comment")
    expect(out).not.toContain("/*")
    expect(out).not.toContain("*/")
    expect(JSON.parse(out)).toEqual({ a: 1 })
  })

  test("preserves comment-like syntax inside strings", () => {
    const input = '{"url": "http://example.com // not a comment"}'
    const out = stripJsoncComments(input)
    expect(out).toBe(input)
    expect(out).toContain("//")
    expect(JSON.parse(out)).toEqual({ url: "http://example.com // not a comment" })
  })

  test("handles empty string", () => {
    expect(stripJsoncComments("")).toBe("")
  })
})

// ── parseJsonc ──

describe("parseJsonc", () => {
  test("parses valid JSONC with comments", () => {
    const input = `{
      // a number
      "a": 1,
      /* a string */
      "b": "hi"
    }`
    const result = parseJsonc<{ a: number; b: string }>(input)
    expect(result).toEqual({ a: 1, b: "hi" })
  })

  test("returns null for invalid JSON", () => {
    expect(parseJsonc("{not valid")).toBeNull()
  })

  test("returns null for empty string", () => {
    expect(parseJsonc("")).toBeNull()
  })
})

// ── deepMerge ──

describe("deepMerge", () => {
  test("merges nested objects", () => {
    type Nested = { a: { x?: number; y?: number } }
    const base: Nested = { a: { x: 1, y: 2 } }
    const override: Partial<Nested> = { a: { y: 3 } }
    const result = deepMerge(base, override)
    expect(result).toEqual({ a: { x: 1, y: 3 } })
  })

  test("arrays are replaced, not merged", () => {
    const base = { a: [1, 2, 3] }
    const override: Partial<typeof base> = { a: [4] }
    const result = deepMerge(base, override)
    expect(result).toEqual({ a: [4] })
  })

  test("undefined override returns base", () => {
    const base = { a: 1 }
    const result = deepMerge(base, undefined)
    expect(result).toBe(base)
    expect(result).toEqual({ a: 1 })
  })

  test("primitive override replaces base value", () => {
    const base = { a: 1, b: 2 }
    const override: Partial<typeof base> = { a: 2 }
    const result = deepMerge(base, override)
    expect(result).toEqual({ a: 2, b: 2 })
  })
})

// ── resolveModelForRole ──

describe("resolveModelForRole", () => {
  test("returns role-specific model when defined", () => {
    expect(resolveModelForRole("planner", defaultConfig)).toBe("deepseek-reasoner")
  })

  test("falls back to default when role is undefined", () => {
    const config: OrcanaConfig = { models: { default: "my-default-model" } }
    expect(resolveModelForRole("fim", config)).toBe("my-default-model")
  })

  test("falls back to deepseek-chat when neither role nor default is defined", () => {
    const config: OrcanaConfig = {}
    expect(resolveModelForRole("planner", config)).toBe("deepseek-chat")
  })
})

// ── loadConfig ──

describe("loadConfig", () => {
  test("returns defaultConfig when no config files exist", () => {
    const config = loadConfig({
      cwd: tempDir,
      globalPath: join(tempDir, "nonexistent-global.jsonc"),
      applyEnv: false,
    })
    expect(config).toEqual(defaultConfig)
  })

  test("uses globalPath pointing to a custom config file", () => {
    const globalPath = join(tempDir, "custom-global.jsonc")
    writeFileSync(
      globalPath,
      `{
        // override default provider
        "defaultProvider": "openrouter",
        "models": {
          "default": "custom-model"
        }
      }`,
      "utf-8",
    )

    const config = loadConfig({ cwd: tempDir, globalPath, applyEnv: false })

    expect(config.defaultProvider).toBe("openrouter")
    expect(config.models?.default).toBe("custom-model")
    // Roles not overridden should be preserved from defaultConfig
    expect(config.models?.planner).toBe("deepseek-reasoner")
    // Providers unchanged (no providers key in global config)
    expect(config.providers?.deepseek).toBeDefined()
  })
})

// ── listProviderIds ──

describe("listProviderIds", () => {
  test("returns provider IDs from config", () => {
    const ids = listProviderIds(defaultConfig)
    expect(ids.sort()).toEqual(["deepseek", "lmstudio", "ollama", "openrouter"])
  })
})

// ── findProviderForModel ──

describe("findProviderForModel", () => {
  test("returns provider ID for a known model", () => {
    expect(findProviderForModel(defaultConfig, "deepseek-chat")).toBe("deepseek")
    expect(findProviderForModel(defaultConfig, "deepseek-reasoner")).toBe("deepseek")
  })

  test("returns undefined for an unknown model", () => {
    expect(findProviderForModel(defaultConfig, "nonexistent-model")).toBeUndefined()
  })
})
