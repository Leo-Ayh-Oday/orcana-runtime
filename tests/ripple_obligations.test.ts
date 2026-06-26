/** Tests for Ripple Obligations with Waiver mechanism (PR 7). */

import { describe, it, expect } from "bun:test"
import {
  obligationsFromReport,
  resolveObligations,
  mergeObligations,
  formatRippleExitGate,
  waiveObligation,
  isObligationBlocking,
  getBlockingObligations,
  formatWaivedObligations,
  type RippleObligation,
} from "../src/ripple/obligations"
import type { RippleReport, RippleCaller } from "../src/ripple/types"

// ── Helpers ──

function makeCaller(overrides: Partial<RippleCaller> = {}): RippleCaller {
  return {
    file: "src/consumer.ts",
    line: 42,
    symbol: "oldFunc",
    text: "oldFunc(args)",
    ...overrides,
  }
}

function makeObligation(overrides: Partial<RippleObligation> = {}): RippleObligation {
  return {
    targetFile: "src/lib.ts",
    symbol: "oldFunc",
    caller: makeCaller(),
    reason: "src/consumer.ts:42 still references changed symbol 'oldFunc'.",
    ...overrides,
  }
}

function makeReport(overrides: Partial<RippleReport> = {}): RippleReport {
  return {
    targetFile: "src/lib.ts",
    changedSymbols: ["oldFunc"],
    apiChanges: [],
    usageImpacts: [],
    callers: [makeCaller()],
    findings: [],
    decision: "block",
    memoryHits: [],
    ...overrides,
  }
}

// ── waiveObligation ──

describe("waiveObligation", () => {
  it("attaches a waiver with reason and timestamp", () => {
    const obl = makeObligation()
    const waived = waiveObligation(obl, "caller is dead code, removing separately")
    expect(waived.waiver).toBeDefined()
    expect(waived.waiver!.reason).toBe("caller is dead code, removing separately")
    expect(waived.waiver!.timestamp).toBeGreaterThan(0)
    expect(typeof waived.waiver!.timestamp).toBe("number")
  })

  it("returns unchanged obligation when reason is empty string", () => {
    const obl = makeObligation()
    const result = waiveObligation(obl, "")
    expect(result.waiver).toBeUndefined()
  })

  it("returns unchanged obligation when reason is whitespace only", () => {
    const obl = makeObligation()
    const result = waiveObligation(obl, "   ")
    expect(result.waiver).toBeUndefined()
  })

  it("trims whitespace from reason", () => {
    const obl = makeObligation()
    const waived = waiveObligation(obl, "  temp bypass  ")
    expect(waived.waiver!.reason).toBe("temp bypass")
  })

  it("does not mutate the original obligation", () => {
    const obl = makeObligation()
    const waived = waiveObligation(obl, "reason")
    expect(obl.waiver).toBeUndefined()
    expect(waived.waiver).toBeDefined()
    expect(waived).not.toBe(obl)
  })
})

// ── isObligationBlocking ──

describe("isObligationBlocking", () => {
  it("returns true for obligation without waiver", () => {
    const obl = makeObligation()
    expect(isObligationBlocking(obl)).toBe(true)
  })

  it("returns false for waived obligation", () => {
    const obl = waiveObligation(makeObligation(), "dead code")
    expect(isObligationBlocking(obl)).toBe(false)
  })
})

// ── getBlockingObligations ──

describe("getBlockingObligations", () => {
  it("returns empty array for empty input", () => {
    expect(getBlockingObligations([])).toEqual([])
  })

  it("returns all obligations when none are waived", () => {
    const obls = [makeObligation(), makeObligation({ symbol: "otherFunc" })]
    expect(getBlockingObligations(obls)).toHaveLength(2)
  })

  it("filters out waived obligations", () => {
    const obls = [
      makeObligation(),
      waiveObligation(makeObligation({ symbol: "otherFunc" }), "irrelevant"),
      makeObligation({ symbol: "thirdFunc" }),
    ]
    const blocking = getBlockingObligations(obls)
    expect(blocking).toHaveLength(2)
    expect(blocking.every(o => !o.waiver)).toBe(true)
  })

  it("returns empty when all are waived", () => {
    const obls = [
      waiveObligation(makeObligation(), "r1"),
      waiveObligation(makeObligation({ symbol: "b" }), "r2"),
    ]
    expect(getBlockingObligations(obls)).toHaveLength(0)
  })
})

// ── formatWaivedObligations ──

describe("formatWaivedObligations", () => {
  it("returns empty string when no obligations", () => {
    expect(formatWaivedObligations([])).toBe("")
  })

  it("returns empty string when no waived obligations", () => {
    expect(formatWaivedObligations([makeObligation()])).toBe("")
  })

  it("formats waived obligations with caller info and reason", () => {
    const waived = waiveObligation(makeObligation(), "caller deprecated")
    const result = formatWaivedObligations([waived])
    expect(result).toContain("Waived Ripple Obligations")
    expect(result).toContain("src/consumer.ts:42")
    expect(result).toContain("oldFunc")
    expect(result).toContain("caller deprecated")
  })
})

// ── obligationsFromReport (existing, verify no regression) ──

describe("obligationsFromReport", () => {
  it("returns empty array for empty report", () => {
    const report = makeReport({ changedSymbols: [], apiChanges: [], callers: [] })
    expect(obligationsFromReport(report, new Set())).toEqual([])
  })

  it("creates obligation for each caller not in modifiedFiles", () => {
    const report = makeReport({
      callers: [
        makeCaller({ file: "src/a.ts", line: 10 }),
        makeCaller({ file: "src/b.ts", line: 20 }),
      ],
    })
    const modified = new Set<string>()
    const obls = obligationsFromReport(report, modified)
    expect(obls).toHaveLength(2)
  })

  it("skips callers already in modifiedFiles", () => {
    const report = makeReport({
      callers: [makeCaller({ file: "src/a.ts", line: 10 })],
    })
    const modified = new Set(["src/a.ts"])
    const obls = obligationsFromReport(report, modified)
    expect(obls).toHaveLength(0)
  })

  it("normalizes caller file paths", () => {
    const report = makeReport({
      callers: [makeCaller({ file: "src\\a.ts", line: 10 })],
    })
    const obls = obligationsFromReport(report, new Set())
    expect(obls[0]!.caller.file).toBe("src/a.ts")
  })

  it("includes reason with file, line, and symbol", () => {
    const report = makeReport({
      callers: [makeCaller({ file: "src/a.ts", line: 15, symbol: "exportedFn" })],
    })
    const obls = obligationsFromReport(report, new Set())
    expect(obls[0]!.reason).toContain("src/a.ts:15")
    expect(obls[0]!.reason).toContain("exportedFn")
  })
})

// ── resolveObligations (existing, verify waiver preservation) ──

describe("resolveObligations", () => {
  it("removes obligations whose caller files were modified", () => {
    const obls = [
      makeObligation({ caller: makeCaller({ file: "src/a.ts" }) }),
      makeObligation({ caller: makeCaller({ file: "src/b.ts" }) }),
    ]
    const resolved = resolveObligations(obls, new Set(["src/a.ts"]))
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.caller.file).toBe("src/b.ts")
  })

  it("preserves waiver on unresolved obligations", () => {
    const waived = waiveObligation(
      makeObligation({ caller: makeCaller({ file: "src/a.ts" }) }),
      "dead code",
    )
    const obls = [
      waived,
      makeObligation({ caller: makeCaller({ file: "src/b.ts" }) }),
    ]
    const resolved = resolveObligations(obls, new Set(["src/b.ts"]))
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.waiver).toBeDefined()
    expect(resolved[0]!.waiver!.reason).toBe("dead code")
  })

  it("normalizes paths in modifiedFiles", () => {
    // resolveObligations normalizes the obligation path before checking the Set.
    // Production code uses forward-slashed paths, so the Set should match.
    const obls = [makeObligation({ caller: makeCaller({ file: "src/a.ts" }) })]
    const resolved = resolveObligations(obls, new Set(["src/a.ts"]))
    expect(resolved).toHaveLength(0)
  })
})

// ── mergeObligations (existing, verify waiver behavior) ──

describe("mergeObligations", () => {
  it("merges two lists deduplicating by key", () => {
    const a = makeObligation({ caller: makeCaller({ file: "src/a.ts", line: 10 }) })
    const b = makeObligation({ caller: makeCaller({ file: "src/b.ts", line: 20 }) })
    expect(mergeObligations([a], [b])).toHaveLength(2)
  })

  it("overwrites existing obligation with new one for same key", () => {
    const existing = waiveObligation(makeObligation(), "old reason")
    const next = makeObligation() // no waiver — same key
    const merged = mergeObligations([existing], [next])
    expect(merged).toHaveLength(1)
    // New report overwrites → waiver lost (stale waiver, fresh ripple finding)
    expect(merged[0]!.waiver).toBeUndefined()
  })

  it("preserves waiver when obligation key is only in existing", () => {
    const waived = waiveObligation(
      makeObligation({ caller: makeCaller({ file: "src/a.ts" }) }),
      "preserved",
    )
    const other = makeObligation({ caller: makeCaller({ file: "src/b.ts" }) })
    const merged = mergeObligations([waived], [other])
    expect(merged).toHaveLength(2)
    const preserved = merged.find(o => o.caller.file === "src/a.ts")!
    expect(preserved.waiver).toBeDefined()
    expect(preserved.waiver!.reason).toBe("preserved")
  })

  it("deduplicates within a single list", () => {
    const a = makeObligation()
    const aDup = makeObligation()
    const merged = mergeObligations([a, aDup], [])
    expect(merged).toHaveLength(1)
  })
})

// ── formatRippleExitGate (existing, verify no regression) ──

describe("formatRippleExitGate", () => {
  it("includes caller file and symbol in output", () => {
    const obl = makeObligation()
    const result = formatRippleExitGate([obl])
    expect(result).toContain("Ripple Exit Gate")
    expect(result).toContain("src/consumer.ts:42")
    expect(result).toContain("oldFunc")
  })

  it("handles empty obligations", () => {
    const result = formatRippleExitGate([])
    expect(result).toContain("Ripple Exit Gate")
    expect(result).toContain("Pending callers:")
  })
})

// ── Integration: waiver lifecycle ──

describe("waiver lifecycle", () => {
  it("obligation → waive → not blocking → gate passes", () => {
    const obl = makeObligation()
    expect(isObligationBlocking(obl)).toBe(true)

    const waived = waiveObligation(obl, "false positive — different package")
    expect(isObligationBlocking(waived)).toBe(false)
    expect(getBlockingObligations([waived])).toHaveLength(0)
  })

  it("waived obligation still appears in formatWaivedObligations for audit", () => {
    const waived = waiveObligation(makeObligation(), "audit trail test")
    const formatted = formatWaivedObligations([waived])
    expect(formatted).toContain("audit trail test")
  })

  it("waived obligations do not appear in blocking count for completion gate", () => {
    const obls = [
      makeObligation({ symbol: "a" }),
      waiveObligation(makeObligation({ symbol: "b" }), "reason"),
      makeObligation({ symbol: "c" }),
    ]
    const blocking = getBlockingObligations(obls)
    expect(blocking).toHaveLength(2)
    expect(blocking.map(o => o.symbol)).toEqual(["a", "c"])
  })

  it("resolveObligations removes both waived and non-waived if caller modified", () => {
    const obls = [
      waiveObligation(makeObligation({ caller: makeCaller({ file: "src/a.ts" }) }), "r"),
      makeObligation({ caller: makeCaller({ file: "src/b.ts" }) }),
    ]
    const resolved = resolveObligations(obls, new Set(["src/a.ts", "src/b.ts"]))
    expect(resolved).toHaveLength(0)
  })
})
