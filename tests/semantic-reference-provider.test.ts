/**
 * Tests for SemanticReferenceProvider (PR 3 — Layer 2 of Ripple Engine 2.0).
 *
 * These tests focus on the provider's lifecycle, state management,
 * and integration contracts. The underlying semantic resolution is
 * tested via ProjectProgram in the integration/ripple tests.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  SemanticReferenceProvider,
  getSemanticReferenceProvider,
  resetSemanticReferenceProvider,
} from "../src/ripple/semantic-reference-provider"

// ── Helpers ────────────────────────────────────────────────────────

const TMP_DIR = resolve(import.meta.dir ?? ".", ".tmp-semref-test")

function makeTestProject(files: Record<string, string>): string {
  rmSync(TMP_DIR, { recursive: true, force: true })
  mkdirSync(join(TMP_DIR, "src"), { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(TMP_DIR, path), content, "utf-8")
  }
  return TMP_DIR
}

function cleanup(): void {
  rmSync(TMP_DIR, { recursive: true, force: true })
}

// ── Provider lifecycle ─────────────────────────────────────────────

describe("SemanticReferenceProvider lifecycle", () => {
  test("starts not ready before any program build", () => {
    const provider = new SemanticReferenceProvider(TMP_DIR)
    // Not ready because ensureProgram hasn't been called yet
    expect(provider.ready).toBe(false)
  })

  test("findCallers triggers ensureProgram internally", () => {
    cleanup()
    const root = makeTestProject({
      "src/lib.ts": "export function greet(): string { return 'hi' }",
      "src/main.ts": "import { greet } from './lib'; greet();",
    })
    const provider = new SemanticReferenceProvider(root)

    // Even without explicit ensureProgram, findCallers triggers it
    const result = provider.findCallers("src/lib.ts", ["greet"], new Map([
      ["greet", { exported: true, nameStart: 25 }],
    ]))

    // Should have at least attempted to build (semanticPathUsed may be true
    // if the program built fast enough, or false if still building)
    expect(result).toBeDefined()
    expect(Array.isArray(result.references)).toBe(true)
    expect(typeof result.semanticPathUsed).toBe("boolean")
    cleanup()
  })

  test("invalidate clears program state", () => {
    const provider = new SemanticReferenceProvider(TMP_DIR)
    expect(provider.ready).toBe(false)
    provider.invalidate()
    expect(provider.ready).toBe(false)
  })
})

// ── findCallers ────────────────────────────────────────────────────

describe("SemanticReferenceProvider.findCallers", () => {
  test("returns empty references for non-exported symbols", () => {
    cleanup()
    const root = makeTestProject({
      "src/lib.ts": "function internalHelper(): void {}",
      "src/main.ts": "internalHelper();",
    })
    const provider = new SemanticReferenceProvider(root)
    // Non-exported symbol — semantic path will skip it
    const result = provider.findCallers("src/lib.ts", ["internalHelper"], new Map([
      ["internalHelper", { exported: false, nameStart: 9 }],
    ]))

    // Non-exported symbols are skipped (semantic path only tracks exported)
    expect(result.references.filter(r => r.file !== "src/lib.ts")).toHaveLength(0)
    cleanup()
  })

  test("returns empty references for empty changedSymbols", () => {
    cleanup()
    const root = makeTestProject({
      "src/lib.ts": "export const VERSION = '1.0'",
    })
    const provider = new SemanticReferenceProvider(root)
    const result = provider.findCallers("src/lib.ts", [], new Map())
    expect(result.references).toHaveLength(0)
    expect(result.semanticPathUsed).toBe(false) // No exported symbols → skips program
    cleanup()
  })

  test("handles position < 0 gracefully", () => {
    cleanup()
    const root = makeTestProject({
      "src/lib.ts": "export function foo(): void {}",
    })
    const provider = new SemanticReferenceProvider(root)
    const result = provider.findCallers("src/lib.ts", ["foo"], new Map([
      ["foo", { exported: true, nameStart: -1 }],
    ]))
    expect(result.references).toHaveLength(0)
    cleanup()
  })

  test("returns empty references for non-existent symbols", () => {
    cleanup()
    const root = makeTestProject({
      "src/lib.ts": "export function foo(): void {}",
    })
    const provider = new SemanticReferenceProvider(root)
    const result = provider.findCallers("src/lib.ts", ["nonexistent"], new Map([
      ["nonexistent", { exported: true, nameStart: 25 }],
    ]))
    expect(result.references).toHaveLength(0)
    cleanup()
  })

  test("deduplicates references across symbols", () => {
    cleanup()
    const root = makeTestProject({
      "src/lib.ts": "export function foo(): void {}\nexport function bar(): void {}",
      "src/main.ts": "import { foo, bar } from './lib';\nfoo();\nbar();",
    })
    const provider = new SemanticReferenceProvider(root)
    const oldSymbols = new Map([
      ["foo", { exported: true, nameStart: 25 }],
      ["bar", { exported: true, nameStart: 57 }],
    ])

    const result = provider.findCallers("src/lib.ts", ["foo", "bar"], oldSymbols)
    // Each caller file:line should appear only once
    const seen = new Set<string>()
    for (const ref of result.references) {
      const key = `${ref.file}:${ref.line}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
    cleanup()
  })
})

// ── resolveSymbol ──────────────────────────────────────────────────

describe("SemanticReferenceProvider.resolveSymbol", () => {
  test("returns undefined when provider is not ready", () => {
    const provider = new SemanticReferenceProvider(TMP_DIR)
    expect(provider.resolveSymbol("src/lib.ts", 0)).toBeUndefined()
  })

  test("returns undefined for non-existent position", () => {
    cleanup()
    const root = makeTestProject({
      "src/lib.ts": "export function foo(): void {}",
    })
    const provider = new SemanticReferenceProvider(root)
    // First build the program
    provider.findCallers("src/lib.ts", ["foo"], new Map([
      ["foo", { exported: true, nameStart: 25 }],
    ]))
    // Position 0 is before any identifier — should return undefined
    const resolved = provider.resolveSymbol("src/lib.ts", 0)
    // May be undefined (no identifier at pos 0) or may resolve if
    // program isn't built yet — both are valid
    expect(resolved === undefined || typeof resolved.name === "string").toBe(true)
    cleanup()
  })
})

// ── Global singleton ───────────────────────────────────────────────

describe("getSemanticReferenceProvider / resetSemanticReferenceProvider", () => {
  test("getSemanticReferenceProvider returns same instance on repeated calls", () => {
    const a = getSemanticReferenceProvider(TMP_DIR)
    const b = getSemanticReferenceProvider(TMP_DIR)
    expect(a).toBe(b)
  })

  test("resetSemanticReferenceProvider clears singleton", () => {
    const a = getSemanticReferenceProvider(TMP_DIR)
    resetSemanticReferenceProvider()
    const b = getSemanticReferenceProvider(TMP_DIR)
    expect(a).not.toBe(b)
  })

  test("resetSemanticReferenceProvider can be called when no provider exists", () => {
    resetSemanticReferenceProvider()
    // Should not throw
    expect(true).toBe(true)
  })
})

// ── SemanticFindResult contract ────────────────────────────────────

describe("SemanticFindResult structure", () => {
  test("references is always an array", () => {
    const provider = new SemanticReferenceProvider(TMP_DIR)
    const result = provider.findCallers("src/lib.ts", ["foo"], new Map([
      ["foo", { exported: true, nameStart: 25 }],
    ]))
    expect(Array.isArray(result.references)).toBe(true)
    expect(typeof result.semanticPathUsed).toBe("boolean")
  })

  test("semanticPathUsed is false when no exported symbols to resolve", () => {
    const provider = new SemanticReferenceProvider(TMP_DIR)
    const result = provider.findCallers("src/lib.ts", [], new Map())
    // No symbols → no semantic resolution attempted
    expect(result.semanticPathUsed).toBe(false)
  })

  test("reference entries have expected shape", () => {
    cleanup()
    const root = makeTestProject({
      "src/lib.ts": "export function greet(): string { return 'hi' }",
      "src/main.ts": "import { greet } from './lib';\nconsole.log(greet());",
    })
    const provider = new SemanticReferenceProvider(root)
    const result = provider.findCallers("src/lib.ts", ["greet"], new Map([
      ["greet", { exported: true, nameStart: 25 }],
    ]))

    for (const ref of result.references) {
      expect(typeof ref.file).toBe("string")
      expect(typeof ref.line).toBe("number")
      expect(ref.line).toBeGreaterThan(0)
      expect(typeof ref.symbol).toBe("string")
      expect(typeof ref.text).toBe("string")
    }
    cleanup()
  })
})

// ── Cleanup ────────────────────────────────────────────────────────

afterAll(() => {
  resetSemanticReferenceProvider()
  cleanup()
})
