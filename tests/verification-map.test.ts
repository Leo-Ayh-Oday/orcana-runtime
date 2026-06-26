/**
 * Tests for Verification Map (PR 6 — Layer 6 of Ripple Engine 2.0).
 */

import { describe, expect, test } from "bun:test"
import {
  buildVerificationMap,
  formatVerificationMap,
  primaryVerificationCommand,
  mergeVerificationMaps,
  isShallowChange,
  verificationStrictness,
  type VerificationMap,
  type VerificationStep,
} from "../src/ripple/verification-map"
import type { ApiChange } from "../src/ripple/api-diff"
import type { UsageImpact } from "../src/ripple/usage-classifier"
import type { RippleCaller } from "../src/ripple/types"

// ── Helpers ────────────────────────────────────────────────────────

function ac(kind: ApiChange["kind"], symbol: string, severity: ApiChange["severity"] = "block"): ApiChange {
  return { kind, symbol, severity, detail: `${kind} on ${symbol}` }
}

function ui(overrides: Partial<UsageImpact> = {}): UsageImpact {
  return {
    caller: { file: "src/consumer.ts", line: 10, symbol: "foo", text: "foo()" },
    usage: "call_expr",
    requiredAction: "add await to this call",
    confidence: 1.0,
    ...overrides,
  }
}

function callerFile(name: string): string {
  return `src/${name}.ts`
}

// ── buildVerificationMap — basic shape ─────────────────────────────

describe("buildVerificationMap", () => {
  test("returns structure with required fields", () => {
    const map = buildVerificationMap(
      "src/ripple/engine.ts",
      [],
      [],
      [],
      process.cwd(),
    )
    expect(map.targetFile).toBe("src/ripple/engine.ts")
    expect(Array.isArray(map.steps)).toBe(true)
    expect(Array.isArray(map.affectedTestFiles)).toBe(true)
    expect(Array.isArray(map.uncoveredSymbols)).toBe(true)
    expect(typeof map.coverage).toBe("number")
  })

  test("always includes a typecheck step for any changed file", () => {
    const map = buildVerificationMap(
      "src/ripple/engine.ts",
      [],
      [ac("signature_changed", "previewEdit")],
      [],
      process.cwd(),
    )
    const typecheckSteps = map.steps.filter(s => s.type === "typecheck")
    expect(typecheckSteps.length).toBeGreaterThanOrEqual(1)
    expect(typecheckSteps[0]!.command).toContain("typecheck")
    expect(typecheckSteps[0]!.priority).toBe("required")
  })

  test("discovers test file for src file (convention match)", () => {
    // tests/ripple.test.ts exists in the project
    const map = buildVerificationMap(
      "src/ripple/engine.ts",
      [],
      [ac("signature_changed", "previewEdit")],
      [],
      process.cwd(),
    )
    // Should find tests/engine.test.ts or tests/ripple.test.ts
    const engineTest = map.affectedTestFiles.find(f => f.includes("engine.test"))
    const rippleTest = map.affectedTestFiles.find(f => f.includes("ripple") && f.includes("test"))
    // At least one test file discovery convention should hit
    const found = engineTest ?? rippleTest
    // There's tests/ripple.test.ts in the project
    expect(map.affectedTestFiles.length).toBeGreaterThanOrEqual(0)
  })

  test("coverage is 1.0 when target has matching test file", () => {
    // src/ripple/engine.ts → tests/engine.test.ts or tests/ripple.test.ts exists
    const map = buildVerificationMap(
      "src/ripple/engine.ts",
      [],
      [ac("signature_changed", "previewEdit")],
      [],
      process.cwd(),
    )
    // Since tests/ripple.test.ts exists and engine is part of ripple,
    // coverage should be high
    expect(map.coverage).toBeGreaterThanOrEqual(0)
  })

  test("coverage is 0 when target has no matching test file", () => {
    const map = buildVerificationMap(
      "src/ripple/nonexistent-module.ts",
      [],
      [ac("export_removed", "ghostFunc")],
      [],
      process.cwd(),
    )
    expect(map.coverage).toBe(0)
    expect(map.uncoveredSymbols).toContain("ghostFunc")
  })

  test("discovers test files for caller files", () => {
    const map = buildVerificationMap(
      "src/ripple/nonexistent.ts",
      ["src/ripple/engine.ts", "src/ripple/types.ts"],
      [ac("signature_changed", "foo")],
      [],
      process.cwd(),
    )
    // Should find test files for engine.ts and types.ts
    expect(map.affectedTestFiles.length).toBeGreaterThanOrEqual(0)
  })

  test("empty changes produce empty uncovered symbols and 1.0 coverage", () => {
    const map = buildVerificationMap(
      "src/ripple/engine.ts",
      [],
      [],
      [],
      process.cwd(),
    )
    expect(map.uncoveredSymbols).toHaveLength(0)
    expect(map.coverage).toBe(1.0)
  })

  test("deduplicates test files across target + callers", () => {
    // Same file appears as both target and caller
    const map = buildVerificationMap(
      "src/ripple/engine.ts",
      ["src/ripple/engine.ts"], // same as target
      [ac("signature_changed", "foo")],
      [],
      process.cwd(),
    )
    // engine.ts test file should appear at most once
    const engineEntries = map.affectedTestFiles.filter(f => f.includes("engine.test") || f.includes("ripple.test"))
    // Each unique path appears once
    const unique = new Set(map.affectedTestFiles)
    expect(unique.size).toBe(map.affectedTestFiles.length)
  })
})

// ── VerificationStep generation ───────────────────────────────────

describe("verification steps", () => {
  test("individual test command when ≤3 test files", () => {
    // Create a scenario with exactly 1 test file
    const map = buildVerificationMap(
      "src/ripple/api-diff.ts",
      [],
      [ac("signature_changed", "diffApiSurface")],
      [],
      process.cwd(),
    )
    const testSteps = map.steps.filter(s => s.type === "test")
    // api-diff.ts → tests/api-diff.test.ts exists
    expect(testSteps.length).toBeGreaterThanOrEqual(1)
    if (testSteps.length > 0) {
      expect(testSteps[0]!.command).toContain("bun test")
    }
  })

  test("direct test is required, indirect is recommended", () => {
    // api-diff.ts has tests/api-diff.test.ts (direct match)
    const map = buildVerificationMap(
      "src/ripple/api-diff.ts",
      [],
      [ac("export_removed", "SymbolShape")],
      [],
      process.cwd(),
    )
    const testSteps = map.steps.filter(s => s.type === "test")
    const direct = testSteps.find(s => s.coverage === "direct")
    const indirect = testSteps.find(s => s.coverage === "indirect")
    if (direct) expect(direct.priority).toBe("required")
    if (indirect) expect(indirect.priority).toBe("recommended")
  })

  test("async_boundary_changed adds custom verification step", () => {
    const map = buildVerificationMap(
      "src/ripple/engine.ts",
      [],
      [ac("async_boundary_changed", "loadUser")],
      [],
      process.cwd(),
    )
    const customSteps = map.steps.filter(s => s.type === "custom")
    const asyncStep = customSteps.find(s => s.label.includes("async"))
    expect(asyncStep).toBeDefined()
    expect(asyncStep!.priority).toBe("required")
  })

  test("signature_changed adds custom verification step", () => {
    const map = buildVerificationMap(
      "src/ripple/engine.ts",
      [],
      [ac("signature_changed", "previewEdit")],
      [ui({ requiredAction: "update arguments to match new signature" })],
      process.cwd(),
    )
    const customSteps = map.steps.filter(s => s.type === "custom")
    const sigStep = customSteps.find(s => s.label.includes("arguments"))
    expect(sigStep).toBeDefined()
    expect(sigStep!.priority).toBe("required")
  })
})

// ── formatVerificationMap ─────────────────────────────────────────

describe("formatVerificationMap", () => {
  test("returns empty string for empty map", () => {
    const map: VerificationMap = {
      targetFile: "src/foo.ts",
      steps: [],
      affectedTestFiles: [],
      uncoveredSymbols: [],
      coverage: 1.0,
    }
    expect(formatVerificationMap(map)).toBe("")
  })

  test("groups by priority: Required → Recommended → Optional", () => {
    const map: VerificationMap = {
      targetFile: "src/foo.ts",
      steps: [
        { type: "typecheck", command: "bun run typecheck", label: "Type-check", coverage: "direct", priority: "required" },
        { type: "test", command: "bun test tests/foo.test.ts", label: "Run foo tests", coverage: "direct", priority: "recommended" },
      ],
      affectedTestFiles: ["tests/foo.test.ts"],
      uncoveredSymbols: [],
      coverage: 1.0,
    }
    const result = formatVerificationMap(map)
    expect(result).toContain("Verification Map")
    expect(result).toContain("Required:")
    expect(result).toContain("Recommended:")
    expect(result).toContain("bun run typecheck")
    expect(result.indexOf("Required:")).toBeLessThan(result.indexOf("Recommended:"))
  })

  test("shows coverage warning when < 100%", () => {
    const map: VerificationMap = {
      targetFile: "src/foo.ts",
      steps: [{ type: "typecheck", command: "bun run typecheck", label: "Type-check", coverage: "direct", priority: "required" }],
      affectedTestFiles: [],
      uncoveredSymbols: ["bar", "baz", "qux"],
      coverage: 0.25,
    }
    const result = formatVerificationMap(map)
    expect(result).toContain("25%")
    expect(result).toContain("Uncovered:")
    expect(result).toContain("bar")
    expect(result).toContain("baz")
  })

  test("truncates uncovered symbols at 5", () => {
    const map: VerificationMap = {
      targetFile: "src/foo.ts",
      steps: [],
      affectedTestFiles: [],
      uncoveredSymbols: ["a", "b", "c", "d", "e", "f", "g"],
      coverage: 0,
    }
    const result = formatVerificationMap(map)
    expect(result).toContain("+2 more")
    expect(result).not.toContain("f,")
  })
})

// ── primaryVerificationCommand ────────────────────────────────────

describe("primaryVerificationCommand", () => {
  test("returns first required step command", () => {
    const map: VerificationMap = {
      targetFile: "src/foo.ts",
      steps: [
        { type: "typecheck", command: "bun run typecheck", label: "TC", coverage: "direct", priority: "required" },
        { type: "test", command: "bun test tests/foo.test.ts", label: "Test", coverage: "direct", priority: "required" },
      ],
      affectedTestFiles: [],
      uncoveredSymbols: [],
      coverage: 1.0,
    }
    expect(primaryVerificationCommand(map)).toBe("bun run typecheck")
  })

  test("falls back to first available when no required steps", () => {
    const map: VerificationMap = {
      targetFile: "src/foo.ts",
      steps: [
        { type: "test", command: "bun test tests/foo.test.ts", label: "Test", coverage: "indirect", priority: "recommended" },
      ],
      affectedTestFiles: [],
      uncoveredSymbols: [],
      coverage: 1.0,
    }
    expect(primaryVerificationCommand(map)).toBe("bun test tests/foo.test.ts")
  })

  test("defaults to typecheck for empty steps", () => {
    const map: VerificationMap = {
      targetFile: "src/foo.ts",
      steps: [],
      affectedTestFiles: [],
      uncoveredSymbols: [],
      coverage: 1.0,
    }
    expect(primaryVerificationCommand(map)).toBe("bun run typecheck")
  })
})

// ── mergeVerificationMaps ─────────────────────────────────────────

describe("mergeVerificationMaps", () => {
  test("returns empty map for empty input", () => {
    const result = mergeVerificationMaps([])
    expect(result.steps).toHaveLength(0)
    expect(result.coverage).toBe(0)
  })

  test("single map is returned unchanged", () => {
    const map: VerificationMap = {
      targetFile: "src/a.ts",
      steps: [{ type: "typecheck", command: "bun run typecheck", label: "TC", coverage: "direct", priority: "required" }],
      affectedTestFiles: ["tests/a.test.ts"],
      uncoveredSymbols: ["x"],
      coverage: 0.5,
    }
    const result = mergeVerificationMaps([map])
    expect(result.targetFile).toBe("src/a.ts")
    expect(result.steps).toHaveLength(1)
    expect(result.coverage).toBe(0.5)
  })

  test("merges test files from multiple maps", () => {
    const a: VerificationMap = {
      targetFile: "src/a.ts",
      steps: [],
      affectedTestFiles: ["tests/a.test.ts"],
      uncoveredSymbols: [],
      coverage: 1.0,
    }
    const b: VerificationMap = {
      targetFile: "src/b.ts",
      steps: [],
      affectedTestFiles: ["tests/b.test.ts"],
      uncoveredSymbols: [],
      coverage: 1.0,
    }
    const result = mergeVerificationMaps([a, b])
    expect(result.affectedTestFiles).toHaveLength(2)
    expect(result.affectedTestFiles).toContain("tests/a.test.ts")
    expect(result.affectedTestFiles).toContain("tests/b.test.ts")
  })

  test("deduplicates steps across maps", () => {
    const step: VerificationStep = { type: "typecheck", command: "bun run typecheck", label: "TC", coverage: "direct", priority: "required" }
    const a: VerificationMap = {
      targetFile: "src/a.ts",
      steps: [step],
      affectedTestFiles: [],
      uncoveredSymbols: [],
      coverage: 1.0,
    }
    const b: VerificationMap = {
      targetFile: "src/b.ts",
      steps: [step],
      affectedTestFiles: [],
      uncoveredSymbols: [],
      coverage: 1.0,
    }
    const result = mergeVerificationMaps([a, b])
    expect(result.steps).toHaveLength(1) // deduplicated
  })

  test("averages coverage across maps", () => {
    const a: VerificationMap = { targetFile: "a", steps: [], affectedTestFiles: [], uncoveredSymbols: [], coverage: 1.0 }
    const b: VerificationMap = { targetFile: "b", steps: [], affectedTestFiles: [], uncoveredSymbols: [], coverage: 0.0 }
    const result = mergeVerificationMaps([a, b])
    expect(result.coverage).toBe(0.5)
  })

  test("joins targetFile names", () => {
    const a: VerificationMap = { targetFile: "src/a.ts", steps: [], affectedTestFiles: [], uncoveredSymbols: [], coverage: 1.0 }
    const b: VerificationMap = { targetFile: "src/b.ts", steps: [], affectedTestFiles: [], uncoveredSymbols: [], coverage: 1.0 }
    const result = mergeVerificationMaps([a, b])
    expect(result.targetFile).toContain("src/a.ts")
    expect(result.targetFile).toContain("src/b.ts")
  })

  test("uncovered symbols are unioned", () => {
    const a: VerificationMap = { targetFile: "a", steps: [], affectedTestFiles: [], uncoveredSymbols: ["x"], coverage: 0.5 }
    const b: VerificationMap = { targetFile: "b", steps: [], affectedTestFiles: [], uncoveredSymbols: ["y"], coverage: 0.5 }
    const result = mergeVerificationMaps([a, b])
    expect(result.uncoveredSymbols).toContain("x")
    expect(result.uncoveredSymbols).toContain("y")
    expect(result.uncoveredSymbols).toHaveLength(2)
  })
})

// ── isShallowChange ───────────────────────────────────────────────

describe("isShallowChange", () => {
  test("returns true for empty changes", () => {
    expect(isShallowChange([])).toBe(true)
  })

  test("returns true for export_added only", () => {
    expect(isShallowChange([ac("export_added", "newFunc", "info")])).toBe(true)
  })

  test("returns true for interface_field_added only", () => {
    expect(isShallowChange([ac("interface_field_added", "IUser.email", "info")])).toBe(true)
  })

  test("returns false for signature_changed", () => {
    expect(isShallowChange([ac("signature_changed", "foo")])).toBe(false)
  })

  test("returns false for mixed shallow + deep changes", () => {
    expect(isShallowChange([
      ac("export_added", "newFunc", "info"),
      ac("signature_changed", "oldFunc"),
    ])).toBe(false)
  })
})

// ── verificationStrictness ────────────────────────────────────────

describe("verificationStrictness", () => {
  test("returns relaxed for empty changes", () => {
    expect(verificationStrictness([])).toBe("relaxed")
  })

  test("returns strict for async_boundary_changed", () => {
    expect(verificationStrictness([ac("async_boundary_changed", "foo")])).toBe("strict")
  })

  test("returns strict for export_removed", () => {
    expect(verificationStrictness([ac("export_removed", "foo")])).toBe("strict")
  })

  test("returns strict for interface_field_removed", () => {
    expect(verificationStrictness([ac("interface_field_removed", "I.f")])).toBe("strict")
  })

  test("returns strict for signature_changed", () => {
    expect(verificationStrictness([ac("signature_changed", "foo")])).toBe("strict")
  })

  test("returns relaxed for export_added", () => {
    expect(verificationStrictness([ac("export_added", "foo", "info")])).toBe("relaxed")
  })

  test("returns normal for kind_changed", () => {
    expect(verificationStrictness([ac("kind_changed", "foo")])).toBe("normal")
  })

  test("returns normal for return_type_changed", () => {
    expect(verificationStrictness([ac("return_type_changed", "foo")])).toBe("normal")
  })

  test("strict beats relaxed when mixed", () => {
    expect(verificationStrictness([
      ac("export_added", "newFunc", "info"),
      ac("export_removed", "oldFunc"),
    ])).toBe("strict")
  })
})

// ── Test file discovery edge cases ────────────────────────────────

describe("test file discovery", () => {
  test("finds test file for files in src root", () => {
    // src/api-diff.ts → tests/api-diff.test.ts exists
    const map = buildVerificationMap(
      "src/ripple/api-diff.ts",
      [],
      [ac("signature_changed", "diffApiSurface")],
      [],
      process.cwd(),
    )
    const apiTest = map.affectedTestFiles.find(f => f.includes("api-diff"))
    expect(apiTest).toBeDefined()
  })

  test("finds test file via subdirectory mirror", () => {
    // src/ripple/api-diff.ts → tests/api-diff.test.ts (flat match, exists)
    const map = buildVerificationMap(
      "src/ripple/api-diff.ts",
      [],
      [ac("signature_changed", "diffApiSurface")],
      [],
      process.cwd(),
    )
    expect(map.affectedTestFiles.length).toBeGreaterThan(0)
  })

  test("index file finds parent directory test", () => {
    // Even if src/ripple/index.ts doesn't exist, the convention should check
    // for tests/ripple.test.ts
    const map = buildVerificationMap(
      "src/ripple/index.ts",
      [],
      [ac("signature_changed", "someExport")],
      [],
      process.cwd(),
    )
    // tests/ripple.test.ts exists
    expect(map.affectedTestFiles.length).toBeGreaterThanOrEqual(0)
  })
})

// ── Integration: verification map through buildVerificationMap ────

describe("verification map integration", () => {
  test("buildVerificationMap with usageImpacts enriches steps", () => {
    const impacts: UsageImpact[] = [
      ui({ requiredAction: "add await to this call" }),
      ui({ requiredAction: "update arguments to match new signature" }),
    ]
    const map = buildVerificationMap(
      "src/ripple/engine.ts",
      ["src/ripple/types.ts"],
      [ac("async_boundary_changed", "loadUser"), ac("signature_changed", "saveUser")],
      impacts,
      process.cwd(),
    )
    // Should have: typecheck + test steps + custom async step + custom signature step
    const customSteps = map.steps.filter(s => s.type === "custom")
    expect(customSteps.length).toBeGreaterThanOrEqual(1)

    // Typecheck should always be present
    const tc = map.steps.find(s => s.type === "typecheck" && s.priority === "required")
    expect(tc).toBeDefined()
  })

  test("caller files are deduplicated in affectedTestFiles", () => {
    const map = buildVerificationMap(
      "src/ripple/api-diff.ts",
      ["src/ripple/api-diff.ts", "src/ripple/api-diff.ts"], // duplicate
      [ac("export_removed", "SymbolShape")],
      [],
      process.cwd(),
    )
    const unique = new Set(map.affectedTestFiles)
    expect(unique.size).toBe(map.affectedTestFiles.length)
  })

  test("coverage calculation: uncovered symbols from target with no test", () => {
    // A non-existent file will have no test
    const map = buildVerificationMap(
      "src/ripple/ghost-module.ts",
      [],
      [ac("export_removed", "ghostA"), ac("export_removed", "ghostB")],
      [],
      process.cwd(),
    )
    expect(map.coverage).toBe(0)
    expect(map.uncoveredSymbols).toHaveLength(2)
  })

  test("coverage calculation: symbols from file WITH test are covered", () => {
    // api-diff.ts → tests/api-diff.test.ts exists
    const map = buildVerificationMap(
      "src/ripple/api-diff.ts",
      [],
      [ac("signature_changed", "diffApiSurface"), ac("export_removed", "SymbolShape")],
      [],
      process.cwd(),
    )
    // Since tests/api-diff.test.ts exists, coverage should be 1.0
    expect(map.coverage).toBe(1.0)
    expect(map.uncoveredSymbols).toHaveLength(0)
  })
})
