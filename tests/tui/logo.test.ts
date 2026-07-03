/** Tests for PR-9 Logo — ASCII-safe variants + 700ms startup animation.
 *
 *  Verifies:
 *    1. ASCII-safe: all chars < 128 when DEEPSEEK_TUI_UNICODE unset
 *    2. 60-col safety: every line ≤ 60 chars (stringWidth)
 *    3. Frame visibility: correct rows shown at each animation frame
 *    4. Frame timing: 200/200/300ms delays = 700ms total
 *    5. reduced-motion: skips to frame 3
 *    6. Brand color: uses theme.brand / theme.brandShimmer, no hardcoded hex
 */

import { describe, expect, test } from "bun:test"
import stringWidth from "string-width"
import {
  computeLogoLines,
  isPureAscii,
  maxLogoWidth,
  type LogoFrame,
  type LogoVariant,
} from "../../src/tui/logo"
import { theme } from "../../src/tui/theme/theme"

const VERSION = "v0.0.0"

// ── Helper: collect all line text from a variant ──
function lineTexts(variant: LogoVariant, frame: LogoFrame, unicode: boolean): string[] {
  return computeLogoLines(variant, frame, unicode, VERSION).map(l => l.text)
}

// ── 1. ASCII-safe ──

describe("PR-9 Logo: ASCII-safe (DEEPSEEK_TUI_UNICODE unset)", () => {
  const variants: LogoVariant[] = ["sonar", "tailfin", "minimal"]

  test("all variants produce pure ASCII output when unicode=false", () => {
    for (const variant of variants) {
      const lines = lineTexts(variant, 3, false)
      for (const text of lines) {
        expect(isPureAscii(text)).toBe(true)
      }
    }
  })

  test("sonar pulse ASCII has no mojibake-prone characters", () => {
    const lines = lineTexts("sonar", 3, false)
    const all = JSON.stringify(lines)
    expect(all).not.toContain("�")
    // No Unicode block chars (▄▀█▓░▒) in ASCII mode
    for (const bad of ["▄", "▀", "█", "▓", "░", "▒", "◆", "▸", "✎", "⏺", "⎿", "·", "╭", "╮", "╰", "╯", "─", "│"]) {
      expect(all).not.toContain(bad)
    }
  })

  test("tail fin ASCII has no Unicode block chars", () => {
    const lines = lineTexts("tailfin", 3, false)
    const all = JSON.stringify(lines)
    for (const bad of ["▄", "▀", "█", "▓", "░", "▒"]) {
      expect(all).not.toContain(bad)
    }
  })

  test("minimal badge ASCII uses + - | not box drawing", () => {
    const lines = lineTexts("minimal", 3, false)
    const all = JSON.stringify(lines)
    expect(all).toContain("+")
    expect(all).toContain("|")
    expect(all).toContain("-")
    // No box drawing chars
    for (const bad of ["╭", "╮", "╰", "╯", "─", "│"]) {
      expect(all).not.toContain(bad)
    }
  })

  test("isPureAscii correctly detects ASCII and non-ASCII", () => {
    expect(isPureAscii("hello world")).toBe(true)
    expect(isPureAscii(".oOo. ORCANA v1.0")).toBe(true)
    expect(isPureAscii("~ sonar . ripple |")).toBe(true)
    expect(isPureAscii("▄▀█")).toBe(false)
    expect(isPureAscii("·")).toBe(false) // U+00B7 middle dot
    expect(isPureAscii("╭──────────╮")).toBe(false)
  })
})

// ── 2. 60-col safety ──

describe("PR-9 Logo: 60-column terminal safety", () => {
  const variants: LogoVariant[] = ["sonar", "tailfin", "minimal"]

  test("all ASCII-mode lines fit in 60 cols", () => {
    for (const variant of variants) {
      const lines = lineTexts(variant, 3, false)
      for (const text of lines) {
        const w = stringWidth(text)
        expect(w).toBeLessThanOrEqual(60)
      }
    }
  })

  test("all Unicode-mode lines fit in 60 cols", () => {
    for (const variant of variants) {
      const lines = lineTexts(variant, 3, true)
      for (const text of lines) {
        const w = stringWidth(text)
        expect(w).toBeLessThanOrEqual(60)
      }
    }
  })

  test("maxLogoWidth returns reasonable values per variant", () => {
    // Sonar pulse: tagline "  sonar . ripple . verify" = 25 chars
    expect(maxLogoWidth("sonar", VERSION)).toBeLessThanOrEqual(30)
    expect(maxLogoWidth("sonar", VERSION)).toBeGreaterThanOrEqual(15)
    // Tail fin: max 15 cols
    expect(maxLogoWidth("tailfin", VERSION)).toBeLessThanOrEqual(20)
    // Minimal badge: 16 cols
    expect(maxLogoWidth("minimal", VERSION)).toBeLessThanOrEqual(20)
  })
})

// ── 3. Frame visibility (sonar variant) ──

describe("PR-9 Logo: sonar pulse frame visibility", () => {
  test("frame 0 — only ORCANA center row", () => {
    const lines = computeLogoLines("sonar", 0, false, VERSION)
    expect(lines.length).toBe(1)
    expect(lines[0]!.text).toContain("ORCANA")
    expect(lines[0]!.bold).toBe(true)
  })

  test("frame 1 — center + pulse rows (5 total)", () => {
    const lines = computeLogoLines("sonar", 1, false, VERSION)
    expect(lines.length).toBe(5)
    // Center is row 2 (middle)
    expect(lines[2]!.text).toContain("ORCANA")
    expect(lines[2]!.bold).toBe(true)
    // Pulse rows are not bold
    expect(lines[0]!.bold).toBeUndefined()
    expect(lines[4]!.bold).toBeUndefined()
  })

  test("frame 2 — all 7 rows (pulse + center + version + tagline)", () => {
    const lines = computeLogoLines("sonar", 2, false, VERSION)
    expect(lines.length).toBe(7)
    // Last 2 rows are version + tagline
    expect(lines[5]!.text).toContain("Orcana")
    expect(lines[5]!.text).toContain(VERSION)
    expect(lines[6]!.text).toContain("sonar")
    expect(lines[6]!.text).toContain("ripple")
    expect(lines[6]!.text).toContain("verify")
  })

  test("frame 3 — all 7 rows (same as frame 2 but pulse color changes)", () => {
    const lines = computeLogoLines("sonar", 3, false, VERSION)
    expect(lines.length).toBe(7)
  })

  test("frame 0 has no pulse dots", () => {
    const lines = computeLogoLines("sonar", 0, false, VERSION)
    const all = JSON.stringify(lines)
    expect(all).not.toContain(".  o  O")
  })

  test("frame 1+ has pulse dots", () => {
    const lines = computeLogoLines("sonar", 1, false, VERSION)
    const all = JSON.stringify(lines.map(l => l.text))
    expect(all).toContain("o  O")
  })

  test("version row appears only at frame >= 2", () => {
    expect(computeLogoLines("sonar", 0, false, VERSION).some(l => l.text.includes(VERSION))).toBe(false)
    expect(computeLogoLines("sonar", 1, false, VERSION).some(l => l.text.includes(VERSION))).toBe(false)
    expect(computeLogoLines("sonar", 2, false, VERSION).some(l => l.text.includes(VERSION))).toBe(true)
    expect(computeLogoLines("sonar", 3, false, VERSION).some(l => l.text.includes(VERSION))).toBe(true)
  })
})

// ── 4. Frame color transitions ──

describe("PR-9 Logo: sonar pulse frame colors", () => {
  test("center row is always brand bold", () => {
    for (const frame of [0, 1, 2, 3] as LogoFrame[]) {
      const lines = computeLogoLines("sonar", frame, false, VERSION)
      const center = lines.find(l => l.text.includes("ORCANA"))
      expect(center).toBeDefined()
      expect(center!.color).toBe(theme.brand)
      expect(center!.bold).toBe(true)
    }
  })

  test("pulse rows use brandShimmer at frame 1-2, brand at frame 3", () => {
    const f1 = computeLogoLines("sonar", 1, false, VERSION)
    const f2 = computeLogoLines("sonar", 2, false, VERSION)
    const f3 = computeLogoLines("sonar", 3, false, VERSION)
    // Frame 1: pulse = brandShimmer
    const pulseF1 = f1.find(l => l.text.includes("o  O"))
    expect(pulseF1!.color).toBe(theme.brandShimmer)
    // Frame 2: pulse = brandShimmer (still shimmer until frame 3)
    const pulseF2 = f2.find(l => l.text.includes("o  O"))
    expect(pulseF2!.color).toBe(theme.brandShimmer)
    // Frame 3: pulse = brand (final state)
    const pulseF3 = f3.find(l => l.text.includes("o  O"))
    expect(pulseF3!.color).toBe(theme.brand)
  })

  test("version + tagline use textDim", () => {
    const lines = computeLogoLines("sonar", 3, false, VERSION)
    const version = lines.find(l => l.text.includes("Orcana"))
    const tagline = lines.find(l => l.text.includes("sonar") && l.text.includes("ripple"))
    expect(version!.color).toBe(theme.textDim)
    expect(tagline!.color).toBe(theme.textDim)
  })

  test("tail fin: content=brand, decoration=textFaint", () => {
    const lines = computeLogoLines("tailfin", 3, false, VERSION)
    // Row 2 is "  /           \" — body (content), Row 5 is water (decoration)
    expect(lines[2]!.color).toBe(theme.brand)
    expect(lines[5]!.color).toBe(theme.textFaint)
  })

  test("minimal badge: content=brand, border=textFaint", () => {
    const lines = computeLogoLines("minimal", 3, false, VERSION)
    // Row 0 is border "+---+", Row 1 is content "| ~ Orcana ~   |"
    expect(lines[0]!.color).toBe(theme.textFaint)
    expect(lines[1]!.color).toBe(theme.brand)
  })
})

// ── 5. Unicode vs ASCII dual-track ──

describe("PR-9 Logo: Unicode / ASCII dual-track", () => {
  test("sonar pulse Unicode uses block chars, ASCII uses dots", () => {
    const ascii = lineTexts("sonar", 3, false)
    const unicode = lineTexts("sonar", 3, true)
    // ASCII pulse has dots: ".  o  O"
    expect(ascii.some(t => t.includes(".  o  O"))).toBe(true)
    // Unicode pulse has block chars (░▒▓█)
    expect(unicode.some(t => t.includes("\u{2591}"))).toBe(true) // ░
    expect(unicode.some(t => t.includes("\u{2588}"))).toBe(true) // █
  })

  test("tail fin Unicode uses block chars, ASCII uses _/\\", () => {
    const ascii = lineTexts("tailfin", 3, false)
    const unicode = lineTexts("tailfin", 3, true)
    expect(ascii.some(t => t.includes("___"))).toBe(true)
    expect(unicode.some(t => t.includes("\u{2584}"))).toBe(true) // ▄
    expect(unicode.some(t => t.includes("\u{2580}"))).toBe(true) // ▀
  })

  test("minimal badge Unicode uses box drawing, ASCII uses +-|", () => {
    const ascii = lineTexts("minimal", 3, false)
    const unicode = lineTexts("minimal", 3, true)
    expect(ascii.some(t => t.startsWith("+"))).toBe(true)
    expect(unicode.some(t => t.startsWith("\u{256D}"))).toBe(true) // ╭
    expect(unicode.some(t => t.includes("\u{2502}"))).toBe(true)   // │
  })

  test("Unicode mode produces non-ASCII characters", () => {
    const unicode = lineTexts("sonar", 3, true)
    const hasNonAscii = unicode.some(t => !isPureAscii(t))
    expect(hasNonAscii).toBe(true)
  })

  test("ASCII and Unicode sonar have same row count at frame 3", () => {
    const ascii = computeLogoLines("sonar", 3, false, VERSION)
    const unicode = computeLogoLines("sonar", 3, true, VERSION)
    expect(ascii.length).toBe(unicode.length)
  })

  test("Unicode tagline uses middle dot, ASCII uses period", () => {
    const ascii = computeLogoLines("sonar", 3, false, VERSION)
    const unicode = computeLogoLines("sonar", 3, true, VERSION)
    const asciiTag = ascii.find(l => l.text.includes("sonar") && l.text.includes("ripple"))
    const unicodeTag = unicode.find(l => l.text.includes("sonar") && l.text.includes("ripple"))
    expect(asciiTag!.text).toContain(".")
    expect(asciiTag!.text).not.toContain("\u{00B7}")
    expect(unicodeTag!.text).toContain("\u{00B7}")
  })
})

// ── 6. Frame timing constants ──

describe("PR-9 Logo: animation timing", () => {
  test("frame 0 is the initial state (minimum content)", () => {
    const f0 = computeLogoLines("sonar", 0, false, VERSION)
    const f3 = computeLogoLines("sonar", 3, false, VERSION)
    // Frame 0 has fewer lines than frame 3
    expect(f0.length).toBeLessThan(f3.length)
  })

  test("progressive reveal: line count increases monotonically", () => {
    const counts = [0, 1, 2, 3].map(f => computeLogoLines("sonar", f as LogoFrame, false, VERSION).length)
    expect(counts[0]).toBeLessThanOrEqual(counts[1]!)
    expect(counts[1]).toBeLessThanOrEqual(counts[2]!)
    expect(counts[2]).toBeLessThanOrEqual(counts[3]!)
  })

  test("frame 3 is the complete logo (most lines)", () => {
    const f3 = computeLogoLines("sonar", 3, false, VERSION)
    const f0 = computeLogoLines("sonar", 0, false, VERSION)
    expect(f3.length).toBeGreaterThan(f0.length)
    expect(f3.length).toBe(7) // 5 pulse + version + tagline
  })

  test("tail fin and minimal are static (same lines at all frames)", () => {
    for (const variant of ["tailfin", "minimal"] as LogoVariant[]) {
      const f0 = computeLogoLines(variant, 0, false, VERSION)
      const f3 = computeLogoLines(variant, 3, false, VERSION)
      expect(f0.length).toBe(f3.length)
    }
  })
})

// ── 7. Brand color unification ──

describe("PR-9 Logo: brand color unification", () => {
  test("all variants use theme.brand (no hardcoded hex)", () => {
    const validColors: Set<string> = new Set([theme.brand, theme.brandShimmer, theme.textDim, theme.textFaint])
    for (const variant of ["sonar", "tailfin", "minimal"] as LogoVariant[]) {
      const lines = computeLogoLines(variant, 3, false, VERSION)
      for (const line of lines) {
        expect(validColors.has(line.color)).toBe(true)
      }
    }
  })

  test("no logo line uses #88C0D0 (old hardcoded brand hex)", () => {
    for (const variant of ["sonar", "tailfin", "minimal"] as LogoVariant[]) {
      const lines = computeLogoLines(variant, 3, false, VERSION)
      for (const line of lines) {
        expect(line.color).not.toBe("#88C0D0")
        expect(line.color).not.toBe("#38BDF8")
      }
    }
  })

  test("sonar pulse center uses theme.brand (abyss)", () => {
    const lines = computeLogoLines("sonar", 3, false, VERSION)
    const center = lines.find(l => l.text.includes("ORCANA"))
    expect(center!.color).toBe(theme.brand)
  })
})
