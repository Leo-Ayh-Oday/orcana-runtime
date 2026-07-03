/** Tests for glyph theme tokens (Phase 3).
 *
 *  Verifies:
 *    1. ASCII theme contains only ASCII-safe characters
 *    2. ASCII theme has no mojibake-prone characters
 *    3. Unicode theme has expected Unicode characters
 *    4. Theme switching via env var
 */

import { describe, expect, test } from "bun:test"
import { getGlyphTheme, tuiTokens } from "../../src/tui/tokens"

// ── ASCII theme ──

describe("glyph theme: ASCII (default)", () => {
  const origEnv = process.env.DEEPSEEK_TUI_UNICODE

  // Ensure we're testing the ASCII theme
  test("default theme is ASCII (not unicode)", () => {
    if (process.env.DEEPSEEK_TUI_UNICODE === "1") {
      // Skip if env is set to unicode
      return
    }
    const g = getGlyphTheme()
    // spinnerChars should be ASCII
    for (const ch of g.spinnerChars) {
      expect(ch.charCodeAt(0)).toBeLessThan(128)
    }
  })

  test("ASCII theme uses only ASCII characters", () => {
    if (process.env.DEEPSEEK_TUI_UNICODE === "1") return
    const g = getGlyphTheme()
    const allChars = [
      ...g.spinnerChars,
      ...g.verifyWave,
      ...g.editingGlow,
      ...g.routingGlyphs,
      ...g.readingGlyphs,
      ...g.streamingGlyphs,
      g.stalledGlyph,
      g.progressFill,
      g.progressEmpty,
      g.checkMark,
      g.crossMark,
      g.readonlyIcon,
      g.sineWave,
      g.rewindIcon,
      g.warningIcon,
      g.circleFill,
      g.circleEmpty,
      g.circleHalf,
      g.diamondIcon,
      g.arrowUp,
      g.arrowDown,
      g.dot,
      g.separator,
    ].join("")
    for (const ch of allChars) {
      expect(ch.charCodeAt(0)).toBeLessThan(128)
    }
  })

  test("ASCII theme has no mojibake-prone characters", () => {
    if (process.env.DEEPSEEK_TUI_UNICODE === "1") return
    const g = getGlyphTheme()
    const allGlyphs = JSON.stringify(g)
    // No replacement character
    expect(allGlyphs).not.toContain("�")
    // No common CJK mojibake from misinterpreted UTF-8 bytes
    for (const bad of ["鈫", "鉅", "路", "�"]) {
      expect(allGlyphs).not.toContain(bad)
    }
  })

  test("ASCII spinner chars are valid ASCII printable", () => {
    if (process.env.DEEPSEEK_TUI_UNICODE === "1") return
    const g = getGlyphTheme()
    for (let i = 0; i < g.spinnerLen; i++) {
      const ch = g.spinnerChars[i]
      const code = ch?.charCodeAt(0)
      expect(code).toBeGreaterThanOrEqual(32) // printable
      expect(code).toBeLessThan(128) // ASCII
    }
  })
})

// ── Unicode theme ──

describe("glyph theme: Unicode", () => {
  test("unicode theme has braille spinner", () => {
    const prevEnv = process.env.DEEPSEEK_TUI_UNICODE
    process.env.DEEPSEEK_TUI_UNICODE = "1"
    try {
      const g = getGlyphTheme()
      // Should contain braille characters (U+2800-U+28FF)
      const hasBraille = [...g.spinnerChars].some(ch => {
        const code = ch.codePointAt(0) ?? 0
        return code >= 0x2800 && code <= 0x28FF
      })
      expect(hasBraille).toBe(true)
    } finally {
      process.env.DEEPSEEK_TUI_UNICODE = prevEnv
    }
  })

  test("unicode theme has block character progress", () => {
    const prevEnv = process.env.DEEPSEEK_TUI_UNICODE
    process.env.DEEPSEEK_TUI_UNICODE = "1"
    try {
      const g = getGlyphTheme()
      expect(g.progressFill).toBe("▓")
      expect(g.progressEmpty).toBe("░")
    } finally {
      process.env.DEEPSEEK_TUI_UNICODE = prevEnv
    }
  })

  test("unicode theme has check marks", () => {
    const prevEnv = process.env.DEEPSEEK_TUI_UNICODE
    process.env.DEEPSEEK_TUI_UNICODE = "1"
    try {
      const g = getGlyphTheme()
      expect(g.checkMark).toBe("✓")
      expect(g.crossMark).toBe("✗")
    } finally {
      process.env.DEEPSEEK_TUI_UNICODE = prevEnv
    }
  })
})

// ── Theme switching ──

describe("glyph theme: switching", () => {
  test("ASCII and Unicode themes produce different glyphs", () => {
    const prevEnv = process.env.DEEPSEEK_TUI_UNICODE

    process.env.DEEPSEEK_TUI_UNICODE = undefined
    delete process.env.DEEPSEEK_TUI_UNICODE
    const ascii = getGlyphTheme()

    process.env.DEEPSEEK_TUI_UNICODE = "1"
    const unicode = getGlyphTheme()

    try {
      // Spinner chars should differ
      expect(ascii.spinnerChars).not.toBe(unicode.spinnerChars)
      // ASCII check mark is 'v', unicode is '✓'
      expect(ascii.checkMark).not.toBe(unicode.checkMark)
    } finally {
      process.env.DEEPSEEK_TUI_UNICODE = prevEnv
    }
  })
})

// ── tuiTokens layout ──

describe("tuiTokens layout", () => {
  test("breakpoints are reasonable", () => {
    expect(tuiTokens.layout.breakpointCompact).toBeGreaterThan(0)
    expect(tuiTokens.layout.breakpointComfortable).toBeGreaterThan(tuiTokens.layout.breakpointCompact)
  })

  test("rail dimensions are reasonable", () => {
    expect(tuiTokens.layout.rail.min).toBeLessThanOrEqual(tuiTokens.layout.rail.ideal)
    expect(tuiTokens.layout.rail.ideal).toBeLessThanOrEqual(tuiTokens.layout.rail.max)
  })

  test("scroll step is positive", () => {
    expect(tuiTokens.layout.scrollStep).toBeGreaterThan(0)
  })
})
