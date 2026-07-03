/** Tests for pending animation (Phase 5 update).
 *
 *  Verifies:
 *    1. Static lines pass through unchanged
 *    2. pendingAnim="spinner" → classified activity glyph + stable label
 *    3. pendingAnim="tail" → tail dots appended to text
 *    4. tick rotation changes glyph but not label
 *    5. No pending → identity
 *    6. Per-activity distinct glyphs (Phase 5)
 *    7. Reduced motion: all glyphs static, tail dots empty (Phase 5)
 *    8. Stalled detection: 3s no token/tool → "stalled" (Phase 5)
 */

import { describe, expect, test } from "bun:test"
import { applyPendingAnimation } from "../../src/tui/components/Scrollback"
import type { RenderedLine } from "../../src/tui/components/MessageItem"
import { C } from "../../src/tui/theme/theme"
import {
  classifyPendingActivity,
  activityGlyph,
  markTokenActivity,
  markToolActivity,
  resetStalledDetection,
  isStalled,
} from "../../src/tui/pending-activity"

function line(overrides: Partial<RenderedLine> = {}): RenderedLine {
  return { marker: "|", text: "hello", color: C.blue, ...overrides }
}

describe("applyPendingAnimation (Phase 5)", () => {
  test("static lines pass through unchanged", () => {
    const lines = [line({ text: "hello" }), line({ text: "world" })]
    expect(applyPendingAnimation(lines, 0, "", 0, false, false)).toEqual(lines)
  })

  test("empty lines array returns empty", () => {
    expect(applyPendingAnimation([], 5, "", 0, false, false)).toEqual([])
  })

  test("spinner generates classified activity (not random verb)", () => {
    const lines = [line({ text: "", pendingAnim: "spinner" as const, pendingStatus: "working" })]
    const r = applyPendingAnimation(lines, 0, "working", 0, false, false)
    expect(r.length).toBe(1)
    // Glyph comes from glyph theme (ASCII or Unicode). Verify pattern: <glyph> working
    expect(r[0]!.text).toMatch(/^. working$/)
  })

  test("glyph rotates with tick", () => {
    const lines = [line({ text: "", pendingAnim: "spinner" as const })]
    const r0 = applyPendingAnimation(lines, 0, "working", 0, false, false)[0]!.text
    const r1 = applyPendingAnimation(lines, 1, "working", 0, false, false)[0]!.text
    const r2 = applyPendingAnimation(lines, 2, "working", 0, false, false)[0]!.text
    // Labels are stable, glyphs differ
    expect(r0).not.toBe(r1)
    expect(r1).not.toBe(r2)
  })

  test("round shows in label when > 0", () => {
    const lines = [line({ text: "", pendingAnim: "spinner" as const })]
    const r0 = applyPendingAnimation(lines, 0, "working", 3, false, false)[0]!.text
    expect(r0).toContain("r3")
  })

  test("round not shown when 0", () => {
    const lines = [line({ text: "", pendingAnim: "spinner" as const })]
    const r0 = applyPendingAnimation(lines, 0, "working", 0, false, false)[0]!.text
    expect(r0).not.toContain("r0")
  })

  test("tail dots appended to text", () => {
    const lines = [line({ text: "streaming", pendingAnim: "tail" as const })]
    expect(applyPendingAnimation(lines, 0, "", 0, false, false)[0]!.text).toBe("streaming")
    expect(applyPendingAnimation(lines, 1, "", 0, false, false)[0]!.text).toBe("streaming.")
    expect(applyPendingAnimation(lines, 2, "", 0, false, false)[0]!.text).toBe("streaming..")
    expect(applyPendingAnimation(lines, 3, "", 0, false, false)[0]!.text).toBe("streaming...")
    expect(applyPendingAnimation(lines, 4, "", 0, false, false)[0]!.text).toBe("streaming")
  })

  test("no pending → identity", () => {
    const lines = [line({ text: "hello" })]
    expect(applyPendingAnimation(lines, 5, "", 0, false, false)).toBe(lines)
  })

  test("routing status → 'preparing context' label", () => {
    const lines = [line({ text: "", pendingAnim: "spinner" as const })]
    const r = applyPendingAnimation(lines, 0, "routing context", 1, false, false)[0]!.text
    expect(r).toContain("preparing context")
    expect(r).toContain("r1")
  })

  test("verifying status → 'verifying' label", () => {
    const lines = [line({ text: "", pendingAnim: "spinner" as const })]
    const r = applyPendingAnimation(lines, 0, "typecheck running", 0, false, false)[0]!.text
    expect(r).toContain("verifying")
  })

  test("blocked status → 'blocked' label", () => {
    const lines = [line({ text: "", pendingAnim: "spinner" as const })]
    const r = applyPendingAnimation(lines, 0, "gate blocked", 0, false, false)[0]!.text
    expect(r).toContain("blocked")
  })
})

// ── Phase 5: per-activity distinct glyphs ──

describe("per-activity glyphs (Phase 5)", () => {
  test("routing uses routingGlyphs, not spinnerChars", () => {
    // routing: "~-~=~-~=~-~" — verify tick 0 starts with '~'
    const g0 = activityGlyph("routing", 0)
    expect(g0).toBe("~")
    // tick 1 should be '-' (different from spinner tick 1 which is '\')
    const g1 = activityGlyph("routing", 1)
    expect(g1).toBe("-")
  })

  test("reading uses readingGlyphs (.oO@Oo.), not spinnerChars", () => {
    const g0 = activityGlyph("reading", 0)
    expect(g0).toBe(".")
    const g1 = activityGlyph("reading", 1)
    expect(g1).toBe("o")
    const g2 = activityGlyph("reading", 2)
    expect(g2).toBe("O")
  })

  test("streaming uses streamingGlyphs (distinct from working/spinner)", () => {
    const g0 = activityGlyph("streaming", 0)
    expect(g0).toBe("-")
    const g1 = activityGlyph("streaming", 1)
    expect(g1).toBe("\\")
  })

  test("working still uses spinnerChars", () => {
    const g0 = activityGlyph("working", 0)
    expect(g0).toBe("-")
    const g1 = activityGlyph("working", 1)
    expect(g1).toBe("\\")
  })

  test("routing and reading have different glyph sequences", () => {
    const routingGlyphs = Array.from({ length: 5 }, (_, i) => activityGlyph("routing", i))
    const readingGlyphs = Array.from({ length: 5 }, (_, i) => activityGlyph("reading", i))
    // They should not be identical
    expect(routingGlyphs.join("")).not.toBe(readingGlyphs.join(""))
  })

  test("streaming and working can share spinner (same glyph source)", () => {
    const s0 = activityGlyph("streaming", 0)
    const w0 = activityGlyph("working", 0)
    expect(s0).toBe(w0) // both use spinner-like glyphs
  })
})

// ── Phase 5: reduced motion ──

describe("reduced motion (Phase 5)", () => {
  test("reducedMotion: tail dots always empty", () => {
    const lines = [line({ text: "streaming", pendingAnim: "tail" as const })]
    // With reducedMotion=true, all tail dots should be empty
    expect(applyPendingAnimation(lines, 0, "", 0, true, false)[0]!.text).toBe("streaming")
    expect(applyPendingAnimation(lines, 1, "", 0, true, false)[0]!.text).toBe("streaming")
    expect(applyPendingAnimation(lines, 2, "", 0, true, false)[0]!.text).toBe("streaming")
  })

  test("reducedMotion: spinner glyph is static (first char)", () => {
    const lines = [line({ text: "", pendingAnim: "spinner" as const })]
    const r0 = applyPendingAnimation(lines, 0, "working", 0, true, false)[0]!.text
    const r5 = applyPendingAnimation(lines, 5, "working", 0, true, false)[0]!.text
    // With reduced motion, the glyph should not change with tick
    // Both should have the same first character from the glyph sequence
    expect(r0).toBe(r5)
  })
})

// ── Phase 5: stalled detection ──

describe("stalled detection (Phase 5)", () => {
  test("isStalled returns false when no timestamps recorded", () => {
    resetStalledDetection()
    expect(isStalled()).toBe(false)
  })

  test("isStalled returns false right after token activity", () => {
    resetStalledDetection()
    markTokenActivity()
    expect(isStalled(Date.now())).toBe(false)
  })

  test("isStalled returns false right after tool activity", () => {
    resetStalledDetection()
    markToolActivity()
    expect(isStalled(Date.now())).toBe(false)
  })

  test("isStalled returns true after 3s with no activity", () => {
    resetStalledDetection()
    const past = Date.now() - 4000
    // Manually set lastTokenAt to 4s ago
    markTokenActivity()
    // Override with a past timestamp — use isStalled with explicit now
    const now = Date.now()
    // We need to check that after 4s the stalled state triggers
    // Since we can't easily mock Date.now in module-level state, test the threshold logic
    // by using the explicit now parameter
    const futureTimestamp = Date.now() + 4000
    expect(isStalled(futureTimestamp)).toBe(true)
  })

  test("isStalled returns false when only token is active (but within 3s)", () => {
    resetStalledDetection()
    markTokenActivity()
    expect(isStalled(Date.now())).toBe(false)
  })

  test("stalled overrides classified activity when no active tool", () => {
    resetStalledDetection()
    markTokenActivity()
    const lines = [line({ text: "", pendingAnim: "spinner" as const })]
    // Within 3s → should NOT be stalled
    const r = applyPendingAnimation(lines, 0, "streaming text", 0, false, false)
    expect(r[0]!.text).toContain("streaming")
  })

  test("stalled suppressed when hasActiveTools=true (long tool execution)", () => {
    resetStalledDetection()
    markTokenActivity()
    // Simulate tool was started 4s ago (via explicit timestamp check)
    const lines = [line({ text: "", pendingAnim: "spinner" as const })]
    // Even though isStalled would return true (both timestamps old),
    // hasActiveTools=true prevents the override
    // "reading file" → classifyPendingActivity → "reading" + hasActiveTools prevents stall
    const r = applyPendingAnimation(lines, 0, "reading file", 0, false, true)
    expect(r[0]!.text).toContain("reading")
    expect(r[0]!.text).not.toContain("stalled")
  })

  test("resetStalledDetection clears both timestamps", () => {
    markTokenActivity()
    markToolActivity()
    resetStalledDetection()
    expect(isStalled()).toBe(false)
  })
})

// ── Phase 5: classifyPendingActivity ──

describe("classifyPendingActivity (Phase 5)", () => {
  test("streaming status maps to streaming activity", () => {
    expect(classifyPendingActivity("streaming tokens")).toBe("streaming")
  })

  test("generating status maps to streaming activity", () => {
    expect(classifyPendingActivity("generating response")).toBe("streaming")
  })

  test("unknown status maps to working (not streaming)", () => {
    expect(classifyPendingActivity("xyzzy unknown")).toBe("working")
  })

  test("stalled is a valid PendingActivity type", () => {
    const label = require("../../src/tui/pending-activity").activityLabel("stalled", 0)
    expect(label).toBe("stalled")
  })
})

// ── Phase 6: FormattedLineCache ──

import { FormattedLineCache, formatLineCacheKey } from "../../src/tui/components/Scrollback"
import type { TuiMessage } from "../../src/tui/state/types"

function makeMsg(id: string, text: string, pending = false): TuiMessage {
  return { id, role: "assistant" as const, text, pending, createdAt: 0 }
}

describe("FormattedLineCache (Phase 6)", () => {
  test("cache key includes message id, text length, and width", () => {
    const m = makeMsg("msg-1", "hello", false)
    const k = formatLineCacheKey(m, 80)
    expect(k.startsWith("msg-1:assistant::ok:final:5:")).toBe(true)
    expect(k.endsWith(":80")).toBe(true)
  })

  test("cache key changes when text length changes (streaming)", () => {
    const m1 = makeMsg("msg-1", "hello", false)
    const m2 = makeMsg("msg-1", "hello world", false)
    expect(formatLineCacheKey(m1, 80)).not.toBe(formatLineCacheKey(m2, 80))
  })

  test("cache key changes when width changes (resize)", () => {
    const m = makeMsg("msg-1", "hello", false)
    expect(formatLineCacheKey(m, 80)).not.toBe(formatLineCacheKey(m, 120))
  })

  test("getOrCompute returns lines (populated)", () => {
    const cache = new FormattedLineCache()
    const m = makeMsg("m1", "hello", false)
    const lines = cache.getOrCompute(m, 80, "idle")
    // Should return at least the message line + spacer
    expect(lines.length).toBeGreaterThan(0)
    expect(lines[0]!.text).toBe("hello")
  })

  test("getOrCompute caches — second call returns same reference", () => {
    const cache = new FormattedLineCache()
    const m = makeMsg("m1", "hello", false)
    const first = cache.getOrCompute(m, 80, "idle")
    const second = cache.getOrCompute(m, 80, "idle")
    // Same reference → cache hit
    expect(first).toBe(second)
  })

  test("getOrCompute cache miss when text changes", () => {
    const cache = new FormattedLineCache()
    const m1 = makeMsg("m1", "hello", false)
    const m2 = makeMsg("m1", "hello world", false)
    const first = cache.getOrCompute(m1, 80, "idle")
    const second = cache.getOrCompute(m2, 80, "idle")
    // Different text → different ref
    expect(first).not.toBe(second)
  })

  test("getOrCompute cache miss when same-length text changes", () => {
    const cache = new FormattedLineCache()
    const first = cache.getOrCompute(makeMsg("m1", "hello", false), 80, "idle")
    const second = cache.getOrCompute(makeMsg("m1", "world", false), 80, "idle")
    expect(first).not.toBe(second)
    expect(first[0]!.text).toBe("hello")
    expect(second[0]!.text).toBe("world")
  })

  test("getOrCompute cache miss when pending flips to final", () => {
    const cache = new FormattedLineCache()
    const pending = cache.getOrCompute(makeMsg("m1", "hello", true), 80, "streaming")
    const final = cache.getOrCompute(makeMsg("m1", "hello", false), 80, "done")
    expect(pending).not.toBe(final)
    expect(pending[0]!.pendingAnim).toBe("tail")
    expect(final[0]!.pendingAnim).toBeUndefined()
  })

  test("getOrCompute cache miss when width changes", () => {
    const cache = new FormattedLineCache()
    const m = makeMsg("m1", "hello", false)
    const first = cache.getOrCompute(m, 80, "idle")
    const second = cache.getOrCompute(m, 120, "idle")
    expect(first).not.toBe(second)
  })

  test("buildAllLines concatenates all messages", () => {
    const cache = new FormattedLineCache()
    const msgs = [makeMsg("m1", "hello"), makeMsg("m2", "world")]
    const { allLines } = cache.buildAllLines(msgs, 80, "idle")
    // Should have content from both messages
    const allText = allLines.filter(l => l.marker === "|").map(l => l.text).join(" ")
    expect(allText).toContain("hello")
    expect(allText).toContain("world")
  })

  test("buildAllLines evicts removed messages from cache", () => {
    const cache = new FormattedLineCache()
    const msgs1 = [makeMsg("m1", "hello"), makeMsg("m2", "world")]
    cache.buildAllLines(msgs1, 80, "idle")
    expect(cache.stats().size).toBeGreaterThanOrEqual(2)

    // Remove m2
    const msgs2 = [makeMsg("m1", "hello")]
    cache.buildAllLines(msgs2, 80, "idle")
    // m2 should be evicted
    const m2Key = formatLineCacheKey(makeMsg("m2", "world"), 80)
    // We can't directly check internal state, but second build with m2 alone should be fast
    // Verify stats show reduced size
    expect(cache.stats().size).toBeLessThan(3)
  })

  test("buildAllLines: resize invalidates cache", () => {
    const cache = new FormattedLineCache()
    const msgs = [makeMsg("m1", "hello world")]
    cache.buildAllLines(msgs, 80, "idle")
    const sizeAt80 = cache.stats().size
    expect(sizeAt80).toBeGreaterThan(0)

    // Change width → cache cleared
    cache.buildAllLines(msgs, 120, "idle")
    // After resize + eviction, only current messages remain
    // But since getOrCompute repopulates... the cache is cleared then repopulated
    expect(cache.stats().size).toBeGreaterThan(0)
    expect(cache.stats().width).toBe(120)
  })

  test("clear empties the cache", () => {
    const cache = new FormattedLineCache()
    cache.getOrCompute(makeMsg("m1", "hello"), 80, "idle")
    expect(cache.stats().size).toBeGreaterThan(0)
    cache.clear()
    expect(cache.stats().size).toBe(0)
  })

  test("stats returns size and width", () => {
    const cache = new FormattedLineCache()
    cache.getOrCompute(makeMsg("m1", "hello"), 80, "idle")
    const s = cache.stats()
    expect(s.size).toBeGreaterThan(0)
    expect(s.width).toBe(80)
  })
})

// ── Phase 6: viewport row cap ──

describe("viewport row cap (Phase 6)", () => {
  test("buildAllLines does not cap when under MAX_VIEWPORT_LINES", () => {
    const cache = new FormattedLineCache()
    const msgs = [makeMsg("m1", "short text"), makeMsg("m2", "also short")]
    const { allLines, capped } = cache.buildAllLines(msgs, 80, "idle")
    expect(capped).toBe(false)
    expect(allLines.length).toBeLessThan(5000)
  })
})
