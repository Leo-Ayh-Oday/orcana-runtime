/** Tests for pending animation (Phase 5 + PR-1.5).
 *
 *  PR-1.5 变更:
 *    - applyPendingAnimation 简化为只处理 tail 光标动画
 *    - 删除 spinner 分支：空 pending message 不再渲染占位行
 *    - 删除 stalled 在 applyPendingAnimation 中的逻辑（isStalled 函数保留供 ThinkingDock 未来使用）
 *
 *  Verifies:
 *    1. Static lines pass through unchanged
 *    2. pendingAnim="tail" → tail dots appended to text
 *    3. No pending → identity
 *    4. Per-activity distinct glyphs (Phase 5, activityGlyph 函数)
 *    5. Reduced motion: tail dots empty (Phase 5)
 *    6. Stalled detection: 3s no token/tool → "stalled" (Phase 5, isStalled 函数)
 *    7. classifyPendingActivity 关键词映射 (Phase 5)
 *    8. FormattedLineCache 缓存行为 (Phase 6)
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

describe("applyPendingAnimation (PR-1.5: tail only)", () => {
  test("static lines pass through unchanged", () => {
    const lines = [line({ text: "hello" }), line({ text: "world" })]
    expect(applyPendingAnimation(lines, 0, false)).toEqual(lines)
  })

  test("empty lines array returns empty", () => {
    expect(applyPendingAnimation([], 5, false)).toEqual([])
  })

  test("tail dots appended to text", () => {
    const lines = [line({ text: "streaming", pendingAnim: "tail" })]
    expect(applyPendingAnimation(lines, 0, false)[0]!.text).toBe("streaming")
    expect(applyPendingAnimation(lines, 1, false)[0]!.text).toBe("streaming.")
    expect(applyPendingAnimation(lines, 2, false)[0]!.text).toBe("streaming..")
    expect(applyPendingAnimation(lines, 3, false)[0]!.text).toBe("streaming...")
    expect(applyPendingAnimation(lines, 4, false)[0]!.text).toBe("streaming")
  })

  test("no pending → identity (same reference)", () => {
    const lines = [line({ text: "hello" })]
    expect(applyPendingAnimation(lines, 5, false)).toBe(lines)
  })

  test("mixed tail and static lines: only tail lines get dots", () => {
    const lines = [
      line({ text: "first" }),
      line({ text: "streaming", pendingAnim: "tail" }),
      line({ text: "third" }),
    ]
    const r = applyPendingAnimation(lines, 3, false)
    expect(r[0]!.text).toBe("first")
    expect(r[1]!.text).toBe("streaming...")
    expect(r[2]!.text).toBe("third")
  })
})

// ── Phase 5: per-activity distinct glyphs ──
// activityGlyph 函数仍保留，供 ThinkingDock 内部使用

describe("per-activity glyphs (Phase 5)", () => {
  test("routing uses routingGlyphs, not spinnerChars", () => {
    const g0 = activityGlyph("routing", 0)
    expect(g0).toBe("~")
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
    expect(routingGlyphs.join("")).not.toBe(readingGlyphs.join(""))
  })

  test("streaming and working can share spinner (same glyph source)", () => {
    const s0 = activityGlyph("streaming", 0)
    const w0 = activityGlyph("working", 0)
    expect(s0).toBe(w0)
  })
})

// ── Phase 5: reduced motion ──

describe("reduced motion (Phase 5)", () => {
  test("reducedMotion: tail dots always empty", () => {
    const lines = [line({ text: "streaming", pendingAnim: "tail" })]
    expect(applyPendingAnimation(lines, 0, true)[0]!.text).toBe("streaming")
    expect(applyPendingAnimation(lines, 1, true)[0]!.text).toBe("streaming")
    expect(applyPendingAnimation(lines, 2, true)[0]!.text).toBe("streaming")
  })
})

// ── Phase 5: stalled detection (isStalled 函数) ──
// applyPendingAnimation 不再使用 stalled，但 isStalled 函数保留供 ThinkingDock 未来使用

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
    markTokenActivity()
    const futureTimestamp = Date.now() + 4000
    expect(isStalled(futureTimestamp)).toBe(true)
  })

  test("isStalled returns false when only token is active (but within 3s)", () => {
    resetStalledDetection()
    markTokenActivity()
    expect(isStalled(Date.now())).toBe(false)
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
    expect(lines.length).toBeGreaterThan(0)
    expect(lines[0]!.text).toBe("hello")
  })

  test("getOrCompute caches — second call returns same reference", () => {
    const cache = new FormattedLineCache()
    const m = makeMsg("m1", "hello", false)
    const first = cache.getOrCompute(m, 80, "idle")
    const second = cache.getOrCompute(m, 80, "idle")
    expect(first).toBe(second)
  })

  test("getOrCompute cache miss when text changes", () => {
    const cache = new FormattedLineCache()
    const m1 = makeMsg("m1", "hello", false)
    const m2 = makeMsg("m1", "hello world", false)
    const first = cache.getOrCompute(m1, 80, "idle")
    const second = cache.getOrCompute(m2, 80, "idle")
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
    const allText = allLines.filter(l => l.marker === "|").map(l => l.text).join(" ")
    expect(allText).toContain("hello")
    expect(allText).toContain("world")
  })

  test("buildAllLines evicts removed messages from cache", () => {
    const cache = new FormattedLineCache()
    const msgs1 = [makeMsg("m1", "hello"), makeMsg("m2", "world")]
    cache.buildAllLines(msgs1, 80, "idle")
    expect(cache.stats().size).toBeGreaterThanOrEqual(2)

    const msgs2 = [makeMsg("m1", "hello")]
    cache.buildAllLines(msgs2, 80, "idle")
    expect(cache.stats().size).toBeLessThan(3)
  })

  test("buildAllLines: resize invalidates cache", () => {
    const cache = new FormattedLineCache()
    const msgs = [makeMsg("m1", "hello world")]
    cache.buildAllLines(msgs, 80, "idle")
    const sizeAt80 = cache.stats().size
    expect(sizeAt80).toBeGreaterThan(0)

    cache.buildAllLines(msgs, 120, "idle")
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

// ── PR-1.5: 空 pending message 不再渲染占位行 ──
// 直接测试 renderMessageLines，避免 cache 追加 spacer 干扰断言

import { renderMessageLines } from "../../src/tui/components/MessageItem"

describe("PR-1.5: empty pending message renders no placeholder", () => {
  test("pending assistant with empty text returns no lines", () => {
    const m = makeMsg("m1", "", true)
    const lines = renderMessageLines(m, 80, "working")
    expect(lines).toEqual([])
  })

  test("pending assistant with text still renders content + tail marker", () => {
    const m = makeMsg("m1", "hello world", true)
    const lines = renderMessageLines(m, 80, "streaming")
    expect(lines.length).toBeGreaterThan(0)
    const last = lines[lines.length - 1]!
    expect(last.pendingAnim).toBe("tail")
    expect(last.text).toBe("hello world")
  })

  test("final assistant with text has no tail marker", () => {
    const m = makeMsg("m1", "hello world", false)
    const lines = renderMessageLines(m, 80, "done")
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) {
      expect(l.pendingAnim).toBeUndefined()
    }
  })

  test("FormattedLineCache: empty pending message yields empty allLines (no spacer leak)", () => {
    // 集成测试：空 pending 不应向 buildAllLines 注入 spacer 行
    const cache = new FormattedLineCache()
    const msgs = [makeMsg("m1", "", true)]
    const { allLines } = cache.buildAllLines(msgs, 80, "working")
    expect(allLines).toEqual([])
  })
})
