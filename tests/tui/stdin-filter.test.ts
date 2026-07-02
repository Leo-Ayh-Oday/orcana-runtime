/** Tests for stdin-filter — covers PR-7 bug fix for scroll wheel garbled text.
 *
 *  Points covered:
 *    1. containsMouseSequence: detects SGR,普通, urxvt mouse sequences
 *    2. stripMouseSequences: removes all mouse sequence types
 *    3. stripMouseSequences: preserves normal input
 *    4. stripMouseSequences: handles mixed mouse + normal input
 *    5. stripMouseSequences: handles empty string
 *    6. stripMouseSequences: handles consecutive mouse sequences
 *    7. installStdinFilter / uninstallStdinFilter: idempotent and restores original
 */

import { describe, expect, test } from "bun:test"
import {
  containsMouseSequence,
  stripMouseSequences,
  installStdinFilter,
  uninstallStdinFilter,
} from "../../src/tui/stdin-filter"

// ── containsMouseSequence ──

describe("containsMouseSequence", () => {
  test("detects SGR mouse sequence (DEC 1006 with M)", () => {
    expect(containsMouseSequence("\x1B[<0;40;10M")).toBe(true)
  })

  test("detects SGR mouse sequence (DEC 1006 with m)", () => {
    expect(containsMouseSequence("\x1B[<0;40;10m")).toBe(true)
  })

  test("detects SGR mouse release (button 2)", () => {
    expect(containsMouseSequence("\x1B[<2;40;10M")).toBe(true)
  })

  test("detects normal mouse sequence (DEC 1000)", () => {
    // \x1B[M followed by 3 bytes: button, col+32, row+32
    expect(containsMouseSequence("\x1B[M !\"")).toBe(true)
  })

  test("detects urxvt mouse sequence (1015)", () => {
    expect(containsMouseSequence("\x1B[0;40;10M")).toBe(true)
  })

  test("returns false for normal text", () => {
    expect(containsMouseSequence("hello world")).toBe(false)
  })

  test("returns false for empty string", () => {
    expect(containsMouseSequence("")).toBe(false)
  })

  test("returns false for plain escape sequences (arrow keys)", () => {
    expect(containsMouseSequence("\x1B[A")).toBe(false) // Up arrow
    expect(containsMouseSequence("\x1B[B")).toBe(false) // Down arrow
    expect(containsMouseSequence("\x1B[C")).toBe(false) // Right arrow
    expect(containsMouseSequence("\x1B[D")).toBe(false) // Left arrow
  })

  test("returns false for bracketed paste markers", () => {
    expect(containsMouseSequence("\x1B[200~")).toBe(false)
    expect(containsMouseSequence("\x1B[201~")).toBe(false)
  })
})

// ── stripMouseSequences ──

describe("stripMouseSequences", () => {
  test("removes SGR mouse sequence", () => {
    expect(stripMouseSequences("\x1B[<0;40;10M")).toBe("")
  })

  test("removes normal mouse sequence (DEC 1000)", () => {
    expect(stripMouseSequences("\x1B[M !\"")).toBe("")
  })

  test("removes urxvt mouse sequence", () => {
    expect(stripMouseSequences("\x1B[0;40;10M")).toBe("")
  })

  test("preserves normal text", () => {
    expect(stripMouseSequences("hello world")).toBe("hello world")
  })

  test("preserves empty string", () => {
    expect(stripMouseSequences("")).toBe("")
  })

  test("removes mouse sequence mixed with normal text (before)", () => {
    expect(stripMouseSequences("\x1B[<0;40;10Mhello")).toBe("hello")
  })

  test("removes mouse sequence mixed with normal text (after)", () => {
    expect(stripMouseSequences("hello\x1B[<0;40;10M")).toBe("hello")
  })

  test("removes mouse sequence mixed with normal text (middle)", () => {
    expect(stripMouseSequences("hel\x1B[<0;40;10Mlo")).toBe("hello")
  })

  test("removes multiple consecutive mouse sequences", () => {
    const result = stripMouseSequences("\x1B[<0;40;10M\x1B[<1;41;11M\x1B[<2;42;12M")
    expect(result).toBe("")
  })

  test("removes multiple mouse sequences interleaved with text", () => {
    const result = stripMouseSequences("a\x1B[<0;40;10Mb\x1B[<1;41;11Mc")
    expect(result).toBe("abc")
  })

  test("preserves arrow key escape sequences", () => {
    expect(stripMouseSequences("\x1B[A")).toBe("\x1B[A")
    expect(stripMouseSequences("\x1B[B")).toBe("\x1B[B")
  })

  test("preserves bracketed paste markers", () => {
    expect(stripMouseSequences("\x1B[200~pasted text\x1B[201~")).toBe("\x1B[200~pasted text\x1B[201~")
  })

  test("handles scroll wheel up (SGR button 64)", () => {
    expect(stripMouseSequences("\x1B[<64;40;10M")).toBe("")
  })

  test("handles scroll wheel down (SGR button 65)", () => {
    expect(stripMouseSequences("\x1B[<65;40;10M")).toBe("")
  })

  test("handles scroll wheel with modifier keys (SGR button 68)", () => {
    // Ctrl+scroll = button 64+4=68
    expect(stripMouseSequences("\x1B[<68;40;10M")).toBe("")
  })
})

// ── installStdinFilter / uninstallStdinFilter ──

describe("installStdinFilter / uninstallStdinFilter", () => {
  test("installStdinFilter is idempotent (multiple calls safe)", () => {
    // Should not throw on repeated calls
    expect(() => {
      installStdinFilter()
      installStdinFilter()
      installStdinFilter()
    }).not.toThrow()
    uninstallStdinFilter()
  })

  test("uninstallStdinFilter is idempotent (multiple calls safe)", () => {
    uninstallStdinFilter()
    expect(() => {
      uninstallStdinFilter()
      uninstallStdinFilter()
    }).not.toThrow()
  })

  test("install then uninstall restores original emit", () => {
    const originalEmit = process.stdin.emit
    installStdinFilter()
    uninstallStdinFilter()
    // After uninstall, emit should be the original function
    expect(process.stdin.emit).toBe(originalEmit)
  })

  test("filter is not active after uninstall", () => {
    uninstallStdinFilter()
    // Install, then immediately uninstall
    installStdinFilter()
    uninstallStdinFilter()
    // The emit should be back to original — no filtering should occur
    const originalEmit = process.stdin.emit
    installStdinFilter()
    uninstallStdinFilter()
    expect(process.stdin.emit).toBe(originalEmit)
  })
})
