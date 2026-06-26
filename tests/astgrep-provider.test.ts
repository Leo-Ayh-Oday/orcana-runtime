/**
 * Tests for AstGrep Provider (PR 7 — Layer 7 of Ripple Engine 2.0).
 *
 * Uses _execFn dependency injection instead of mock.module to avoid
 * cross-file mock leakage that affects ripple.test.ts.
 */

import { describe, expect, test } from "bun:test"
import {
  AstGrepProvider,
  getAstGrepProvider,
  resetAstGrepProvider,
} from "../src/ripple/astgrep-provider"

// ── Helpers ────────────────────────────────────────────────────────

function fakeSgOutput(matches: Array<{ file: string; line: number; text: string }>): string {
  return JSON.stringify(matches.map(m => ({
    file: m.file,
    range: { start: { line: m.line - 1, column: 0 }, end: { line: m.line - 1, column: m.text.length } },
    text: m.text,
  })))
}

/** Create provider with _execFn that throws (simulating missing sg). */
function providerWithoutSg(root = process.cwd()): AstGrepProvider {
  const p = new AstGrepProvider(root)
  p._execFn = () => { throw new Error("sg: command not found") }
  return p
}

/** Create provider with _execFn that returns fake sg version. */
function providerWithSg(root: string, fn: (cmd: string) => string): AstGrepProvider {
  const p = new AstGrepProvider(root)
  p._execFn = fn
  return p
}

// ── Global cleanup ─────────────────────────────────────────────────

function cleanup() {
  resetAstGrepProvider()
}

// ── Availability (no sg) ──────────────────────────────────────────

describe("AstGrepProvider — availability (no sg)", () => {
  test("isAvailable returns false when sg is not installed", () => {
    cleanup()
    const p = providerWithoutSg()
    expect(p.isAvailable()).toBe(false)
  })

  test("version returns empty string when sg not installed", () => {
    cleanup()
    const p = providerWithoutSg()
    p.isAvailable()
    expect(p.version).toBe("")
  })

  test("caches availability result", () => {
    cleanup()
    const p = providerWithoutSg()
    const first = p.isAvailable()
    const second = p.isAvailable()
    expect(first).toBe(second)
  })

  test("stats returns structured object with available=false", () => {
    cleanup()
    const p = providerWithoutSg()
    p.isAvailable()
    const s = p.stats
    expect(s.available).toBe(false)
    expect(s.version).toBe("")
    expect(s.lastMatchCount).toBe(0)
    expect(s.matchedPatterns).toEqual([])
  })
})

// ── Availability (sg present) ─────────────────────────────────────

describe("AstGrepProvider — availability (sg present)", () => {
  test("isAvailable returns true when sg responds with version", () => {
    cleanup()
    const p = providerWithSg("/project", (cmd) => {
      if (cmd.includes("--version")) return "sg 0.19.0\n"
      return "[]"
    })
    expect(p.isAvailable()).toBe(true)
    expect(p.version).toBe("0.19.0")
  })

  test("captures version from sg --version", () => {
    cleanup()
    const p = providerWithSg("/project", (cmd) => {
      if (cmd.includes("--version")) return "sg 0.19.0\n"
      return "[]"
    })
    p.isAvailable()
    expect(p.stats.version).toBe("0.19.0")
  })

  test("falls back to raw output when version format is unexpected", () => {
    cleanup()
    const p = providerWithSg("/project", (cmd) => {
      if (cmd.includes("--version")) return "ast-grep CLI version 1.0"
      return "[]"
    })
    p.isAvailable()
    expect(p.stats.available).toBe(true)
    expect(p.stats.version).toBe("ast-grep CLI version")
  })
})

// ── discoverCallers (sg missing) ──────────────────────────────────

describe("AstGrepProvider — discoverCallers (sg missing)", () => {
  test("returns empty for empty symbols", () => {
    cleanup()
    const p = providerWithoutSg()
    expect(p.discoverCallers("src/foo.ts", [])).toEqual([])
  })

  test("returns empty for any symbols when sg unavailable", () => {
    cleanup()
    const p = providerWithoutSg()
    p.isAvailable()
    const result = p.discoverCallers("src/foo.ts", ["bar", "baz"])
    expect(result).toEqual([])
  })
})

// ── Singleton lifecycle ───────────────────────────────────────────

describe("AstGrepProvider — singleton lifecycle", () => {
  test("getAstGrepProvider returns instance", () => {
    cleanup()
    const p = getAstGrepProvider()
    expect(p).toBeDefined()
    expect(p instanceof AstGrepProvider).toBe(true)
  })

  test("getAstGrepProvider returns same instance", () => {
    cleanup()
    const a = getAstGrepProvider()
    const b = getAstGrepProvider()
    expect(a).toBe(b)
  })

  test("resetAstGrepProvider creates new instance", () => {
    cleanup()
    const a = getAstGrepProvider()
    resetAstGrepProvider()
    const b = getAstGrepProvider()
    expect(a).not.toBe(b)
  })
})

// ── discoverCallers (sg present) ──────────────────────────────────

describe("AstGrepProvider — discoverCallers (sg present)", () => {
  test("discovers callers from sg JSON output", () => {
    cleanup()
    const matches = [
      { file: "/project/src/consumer.ts", line: 10, text: "foo(args)" },
      { file: "/project/src/other.ts", line: 42, text: "const x = foo()" },
    ]
    const p = providerWithSg("/project", (cmd) => {
      if (cmd.includes("--version")) return "sg 0.19.0\n"
      return fakeSgOutput(matches)
    })
    p.isAvailable()
    const result = p.discoverCallers("src/changed.ts", ["foo"])
    expect(result.length).toBeGreaterThanOrEqual(1)
    expect(result.some(c => c.symbol === "foo")).toBe(true)
  })

  test("deduplicates by file:line", () => {
    cleanup()
    const matches = [
      { file: "/project/src/a.ts", line: 10, text: "foo()" },
      { file: "/project/src/a.ts", line: 10, text: "foo()" },
    ]
    const p = providerWithSg("/project", (cmd) => {
      if (cmd.includes("--version")) return "sg 0.19.0\n"
      return fakeSgOutput(matches)
    })
    p.isAvailable()
    const result = p.discoverCallers("src/changed.ts", ["foo"])
    const unique = new Set(result.map(c => `${c.file}:${c.line}`))
    expect(unique.size).toBe(result.length)
  })

  test("returns empty for unreferenced symbol", () => {
    cleanup()
    const p = providerWithSg(process.cwd(), (cmd) => {
      if (cmd.includes("--version")) return "sg 0.19.0\n"
      return "[]"
    })
    p.isAvailable()
    expect(p.discoverCallers("src/foo.ts", ["nonexistent"])).toEqual([])
  })

  test("handles non-JSON output gracefully", () => {
    cleanup()
    const p = providerWithSg(process.cwd(), (cmd) => {
      if (cmd.includes("--version")) return "sg 0.19.0\n"
      return "not json"
    })
    p.isAvailable()
    expect(p.discoverCallers("src/foo.ts", ["bar"])).toEqual([])
  })

  test("handles sg exit code 1 (no matches per sg convention)", () => {
    cleanup()
    const p = providerWithSg(process.cwd(), (cmd) => {
      if (cmd.includes("--version")) return "sg 0.19.0\n"
      const err = new Error("no matches") as Error & { status: number }
      err.status = 1
      throw err
    })
    p.isAvailable()
    expect(p.discoverCallers("src/foo.ts", ["bar"])).toEqual([])
  })
})

// ── Pattern quality ───────────────────────────────────────────────

describe("AstGrepProvider — pattern quality", () => {
  test("runs multiple patterns per symbol", () => {
    cleanup()
    let captured: string[] = []
    const p = providerWithSg(process.cwd(), (cmd) => {
      captured.push(cmd)
      if (cmd.includes("--version")) return "sg 0.19.0\n"
      return "[]"
    })
    p.isAvailable()
    p.discoverCallers("src/changed.ts", ["myFunc"])

    expect(captured.length).toBeGreaterThanOrEqual(5)
    const all = captured.join(" ")
    expect(all).toContain("myFunc")
    expect(all).toContain("sg scan")
    expect(all).toContain("--json")
  })

  test("symbols with regex-special chars are escaped", () => {
    cleanup()
    let captured: string[] = []
    const p = providerWithSg(process.cwd(), (cmd) => {
      captured.push(cmd)
      if (cmd.includes("--version")) return "sg 0.19.0\n"
      return "[]"
    })
    p.isAvailable()
    p.discoverCallers("src/changed.ts", ["foo.bar"])
    const all = captured.join(" ")
    expect(all).toContain("foo\\.bar")
  })

  test("tracks matchedPatterns when matches found", () => {
    cleanup()
    const p = providerWithSg("/p", (cmd) => {
      if (cmd.includes("--version")) return "sg 0.19.0\n"
      return fakeSgOutput([{ file: "/p/src/a.ts", line: 10, text: "foo()" }])
    })
    p.isAvailable()
    p.discoverCallers("src/changed.ts", ["foo"])
    const s = p.stats
    expect(s.lastMatchCount).toBeGreaterThan(0)
    expect(s.matchedPatterns.length).toBeGreaterThan(0)
  })

  test("continues when one pattern fails with status 2", () => {
    cleanup()
    let call = 0
    const p = providerWithSg("/p", (_cmd) => {
      call++
      if (call === 1) return "sg 0.19.0\n"
      if (call === 2) throw Object.assign(new Error("bad"), { status: 2 })
      return fakeSgOutput([{ file: "/p/src/a.ts", line: 1, text: "foo" }])
    })
    p.isAvailable()
    const result = p.discoverCallers("src/changed.ts", ["foo"])
    expect(Array.isArray(result)).toBe(true)
  })
})

// ── RippleCaller shape ────────────────────────────────────────────

describe("AstGrepProvider — RippleCaller compatibility", () => {
  test("returned callers satisfy RippleCaller contract", () => {
    cleanup()
    const p = providerWithSg("/project", (cmd) => {
      if (cmd.includes("--version")) return "sg 0.19.0\n"
      return fakeSgOutput([{ file: "/project/src/consumer.ts", line: 15, text: "loadUser(id)" }])
    })
    p.isAvailable()
    const result = p.discoverCallers("src/changed.ts", ["loadUser"])

    for (const c of result) {
      expect(typeof c.file).toBe("string")
      expect(typeof c.line).toBe("number")
      expect(c.line).toBeGreaterThan(0)
      expect(typeof c.symbol).toBe("string")
      expect(typeof c.text).toBe("string")
    }
  })
})
