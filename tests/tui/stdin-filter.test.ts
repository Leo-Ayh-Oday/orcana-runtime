/** Tests for stdin-filter — covers read()-based mouse sequence filtering.
 *
 *  The filter now patches stdin.read() (Ink's input path) instead of
 *  process.stdin.emit('data', ...) (which Ink never uses in paused mode).
 *
 *  Points covered:
 *    1. containsMouseSequence: detects SGR, DEC1000, urxvt mouse sequences
 *    2. stripMouseSequences: removes all mouse sequence types
 *    3. stripMouseSequences: preserves normal input, arrow keys, bracketed paste
 *    4. filterChunk: cross-chunk buffering via pendingBuffer
 *    5. installStdinFilter: patches read(), idempotent
 *    6. uninstallStdinFilter: restores original read(), clears buffer
 *    7. enableMouseMode: full disable then enable
 *    8. disableMouseMode: closes all 6 mouse modes
 *    9. cleanupTerminal: combined cursor + title + mouse + stdin cleanup
 *   10. read() returns null for pure-mouse chunks
 *   11. read() preserves text chunks unchanged
 *   12. read() strips mouse sequences from mixed chunks
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import {
  containsMouseSequence,
  stripMouseSequences,
  installStdinFilter,
  uninstallStdinFilter,
  mouseEvents,
  enableMouseMode,
  disableMouseMode,
  cleanupTerminal,
  _getPendingBuffer,
} from "../../src/tui/stdin-filter"

function dec1000(button: number, col = 40, row = 10): string {
  return String.fromCharCode(button + 32, col + 32, row + 32)
}

// Helper: simulate stdin.read() returning a chunk, then pass it through the patched read().
// Returns what the patched read() would return (string or null).
function simulateRead(chunk: string | null): string | null {
  // We can't directly call the patched read() since it delegates to the real stdin,
  // so we test the filterChunk logic indirectly via the public API.
  // For read() tests, we mock stdin.read and install the filter.
  return chunk
}

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
    expect(containsMouseSequence("\x1B[A")).toBe(false)
    expect(containsMouseSequence("\x1B[B")).toBe(false)
    expect(containsMouseSequence("\x1B[C")).toBe(false)
    expect(containsMouseSequence("\x1B[D")).toBe(false)
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
    expect(stripMouseSequences("\x1B[<68;40;10M")).toBe("")
  })
})

// ── installStdinFilter / uninstallStdinFilter ──

describe("installStdinFilter / uninstallStdinFilter", () => {
  test("installStdinFilter is idempotent (multiple calls safe)", () => {
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

  test("install then uninstall restores original read", () => {
    const originalRead = process.stdin.read
    installStdinFilter()
    uninstallStdinFilter()
    expect(process.stdin.read).toBe(originalRead)
  })

  test("filter is not active after uninstall", () => {
    uninstallStdinFilter()
    const originalRead = process.stdin.read
    installStdinFilter()
    uninstallStdinFilter()
    expect(process.stdin.read).toBe(originalRead)
  })
})

// ── read()-based mouse filtering ──

describe("read()-based mouse filtering", () => {
  let readQueue: (string | null)[] = []
  let originalRead: typeof process.stdin.read

  function pushReadChunk(chunk: string | null) {
    readQueue.push(chunk)
  }

  beforeEach(() => {
    readQueue = []
    originalRead = process.stdin.read.bind(process.stdin)
    // Mock stdin.read to return from our queue
    process.stdin.read = ((size?: number) => {
      if (readQueue.length === 0) return null
      const chunk = readQueue.shift()!
      return chunk === null ? null : chunk
    }) as typeof process.stdin.read
  })

  afterEach(() => {
    uninstallStdinFilter()
    process.stdin.read = originalRead
  })

  test("patched read() returns null for pure SGR mouse chunk", () => {
    installStdinFilter()
    pushReadChunk("\x1B[<0;40;10M")
    const result = process.stdin.read()
    expect(result).toBeNull()
  })

  test("patched read() returns null for pure DEC1000 click chunk", () => {
    installStdinFilter()
    pushReadChunk(`\x1B[M${dec1000(0)}`)
    const result = process.stdin.read()
    expect(result).toBeNull()
  })

  test("patched read() returns text unchanged when no mouse sequences", () => {
    installStdinFilter()
    pushReadChunk("hello world")
    const result = process.stdin.read()
    expect(result).toBe("hello world")
  })

  test("patched read() strips mouse sequence, returns only text", () => {
    installStdinFilter()
    pushReadChunk("\x1B[<0;40;10Mhello")
    const result = process.stdin.read()
    expect(result).toBe("hello")
  })

  test("patched read() returns null when input is empty string", () => {
    installStdinFilter()
    pushReadChunk("")
    const result = process.stdin.read()
    // Empty input after filtering → null (no data)
    expect(result).toBeNull()
  })

  test("patched read() returns only text part from mouse+text mix", () => {
    installStdinFilter()
    pushReadChunk("prefix\x1B[<0;40;10Msuffix")
    const result = process.stdin.read()
    expect(result).toBe("prefixsuffix")
  })

  test("patched read() handles multiple mouse sequences, returns only text", () => {
    installStdinFilter()
    pushReadChunk("a\x1B[<0;40;10Mb\x1B[<1;41;11Mc")
    const result = process.stdin.read()
    expect(result).toBe("abc")
  })

  test("patched read() preserves arrow keys", () => {
    installStdinFilter()
    pushReadChunk("\x1B[A")
    const result = process.stdin.read()
    expect(result).toBe("\x1B[A")
  })

  test("patched read() handles SGR scroll wheel up — stripped, scroll event emitted", () => {
    const events: number[] = []
    const handler = (direction: number) => events.push(direction)
    mouseEvents.on("scroll", handler)
    try {
      installStdinFilter()
      pushReadChunk("\x1B[<64;40;10M")
      const result = process.stdin.read()
      expect(result).toBeNull()
      expect(events).toEqual([-1])
    } finally {
      mouseEvents.off("scroll", handler)
    }
  })

  test("patched read() handles SGR scroll wheel down — stripped, scroll event emitted", () => {
    const events: number[] = []
    const handler = (direction: number) => events.push(direction)
    mouseEvents.on("scroll", handler)
    try {
      installStdinFilter()
      pushReadChunk("\x1B[<65;40;10M")
      const result = process.stdin.read()
      expect(result).toBeNull()
      expect(events).toEqual([1])
    } finally {
      mouseEvents.off("scroll", handler)
    }
  })

  test("mouse click (button 0) does not emit scroll event", () => {
    const events: unknown[] = []
    const handler = (...args: unknown[]) => events.push(args)
    mouseEvents.on("scroll", handler)
    try {
      installStdinFilter()
      pushReadChunk("\x1B[<0;40;10M")
      const result = process.stdin.read()
      expect(result).toBeNull()
      expect(events).toHaveLength(0)
    } finally {
      mouseEvents.off("scroll", handler)
    }
  })

  test("Ctrl+scroll (button 68/69) emits with isCtrl flag extracted", () => {
    const events: Array<{ direction: number; isCtrl: boolean }> = []
    const handler = (direction: number, isCtrl: boolean) => events.push({ direction, isCtrl })
    mouseEvents.on("scroll", handler)
    try {
      installStdinFilter()
      pushReadChunk("\x1B[<68;40;10M\x1B[<69;40;10M")
      const result = process.stdin.read()
      expect(result).toBeNull()
      expect(events).toHaveLength(2)
      expect(events[0]).toEqual({ direction: -1, isCtrl: true })
      expect(events[1]).toEqual({ direction: 1, isCtrl: true })
    } finally {
      mouseEvents.off("scroll", handler)
    }
  })
})

// ── Cross-chunk buffering (read()-based) ──

describe("cross-chunk mouse sequence handling (read-based)", () => {
  let readQueue: (string | null)[] = []
  let originalRead: typeof process.stdin.read

  function pushReadChunk(chunk: string | null) {
    readQueue.push(chunk)
  }

  beforeEach(() => {
    readQueue = []
    originalRead = process.stdin.read
    process.stdin.read = ((size?: number) => {
      if (readQueue.length === 0) return null
      const chunk = readQueue.shift()!
      return chunk === null ? null : chunk
    }) as typeof process.stdin.read
  })

  afterEach(() => {
    uninstallStdinFilter()
    process.stdin.read = originalRead
  })

  test("incomplete SGR prefix at chunk end is buffered, read returns null", () => {
    installStdinFilter()
    // Chunk: "hello" + incomplete prefix
    pushReadChunk("hello\x1B[<64;40;")
    const result = process.stdin.read()
    // "hello" returned, incomplete prefix buffered
    expect(result).toBe("hello")
    expect(_getPendingBuffer()).toBe("\x1B[<64;40;")
  })

  test("buffered prefix completes with next read, scroll event extracted", () => {
    const events: number[] = []
    const handler = (direction: number) => events.push(direction)
    mouseEvents.on("scroll", handler)
    try {
      installStdinFilter()
      // Chunk 1: incomplete prefix
      pushReadChunk("\x1B[<64;40;")
      const r1 = process.stdin.read()
      expect(r1).toBeNull()
      expect(_getPendingBuffer()).toBe("\x1B[<64;40;")

      // Chunk 2: completion
      pushReadChunk("10M")
      const r2 = process.stdin.read()
      expect(r2).toBeNull()
      expect(events).toEqual([-1])
      expect(_getPendingBuffer()).toBe("")
    } finally {
      mouseEvents.off("scroll", handler)
    }
  })

  test("multiple mouse sequences split across reads all stripped", () => {
    const events: number[] = []
    const handler = (direction: number) => events.push(direction)
    mouseEvents.on("scroll", handler)
    try {
      installStdinFilter()
      // Chunk 1: two complete + one incomplete
      pushReadChunk("\x1B[<64;40;10M\x1B[<65;41;11M\x1B[<64;")
      const r1 = process.stdin.read()
      expect(r1).toBeNull()
      expect(events).toHaveLength(2)

      // Chunk 2: completion
      pushReadChunk("42;12M")
      const r2 = process.stdin.read()
      expect(r2).toBeNull()
      expect(events).toHaveLength(3)
    } finally {
      mouseEvents.off("scroll", handler)
    }
  })

  test("orphan SGR mouse bodies (no ESC) are stripped", () => {
    installStdinFilter()
    pushReadChunk("[<65;27;29M[<65;26;29M")
    const result = process.stdin.read()
    expect(result).toBeNull()
    expect(_getPendingBuffer()).toBe("")
  })

  test("orphan SGR body split across reads is buffered", () => {
    const events: number[] = []
    const handler = (direction: number) => events.push(direction)
    mouseEvents.on("scroll", handler)
    try {
      installStdinFilter()
      pushReadChunk("[<65;27;")
      const r1 = process.stdin.read()
      expect(r1).toBeNull()
      expect(_getPendingBuffer()).toBe("[<65;27;")

      pushReadChunk("29M")
      const r2 = process.stdin.read()
      expect(r2).toBeNull()
      expect(events).toEqual([1])
    } finally {
      mouseEvents.off("scroll", handler)
    }
  })

  test("DEC1000 click and release sequences are stripped", () => {
    installStdinFilter()
    pushReadChunk(`\x1B[M${dec1000(0)}\x1B[M${dec1000(2)}\x1B[M${dec1000(3)}`)
    const result = process.stdin.read()
    expect(result).toBeNull()
  })

  test("ordinary text that looks like orphan DEC1000 prefix is preserved", () => {
    installStdinFilter()
    pushReadChunk("[Maybe] keep this text")
    const result = process.stdin.read()
    expect(result).toBe("[Maybe] keep this text")
  })

  test("ESC key alone is NOT buffered (preserves Esc functionality)", () => {
    installStdinFilter()
    pushReadChunk("\x1B")
    const result = process.stdin.read()
    // \x1B matches INCOMPLETE_MOUSE_PREFIX_REGEX (/^\x1B\[?...$/), but \x1B by itself:
    // It matches if the regex allows just \x1B. Since we use INCOMPLETE_MOUSE_PREFIX_REGEX,
    // which matches \x1B\[(?:...)?$, and the raw chunk is just "\x1B" —
    // it does match because the regex is /\x1B\[(?:...)?$/ and the `\[` requires a literal `[`.
    // "\x1B" alone does NOT match because there's no `[` after it.
    // So it passes through fine.
    expect(result).toBe("\x1B")
    expect(_getPendingBuffer()).toBe("")
  })

  test("non-mouse text after buffered prefix is emitted correctly", () => {
    installStdinFilter()
    // Chunk 1: incomplete prefix
    pushReadChunk("\x1B[<64;40;")
    const r1 = process.stdin.read()
    expect(r1).toBeNull()

    // Chunk 2: completion + normal text
    pushReadChunk("10Mhello")
    const r2 = process.stdin.read()
    expect(r2).toBe("hello")
    expect(_getPendingBuffer()).toBe("")
  })

  test("uninstallStdinFilter clears pendingBuffer", () => {
    installStdinFilter()
    pushReadChunk("\x1B[<64;40;")
    process.stdin.read() // should buffer the incomplete prefix
    expect(_getPendingBuffer()).toBe("\x1B[<64;40;")
    uninstallStdinFilter()
    expect(_getPendingBuffer()).toBe("")
  })
})

// ── enableMouseMode / disableMouseMode ──

describe("enableMouseMode / disableMouseMode", () => {
  test("enableMouseMode writes full disable first then enable escape sequences", () => {
    const written: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((data: unknown) => {
      if (typeof data === "string") written.push(data)
      return true
    }) as typeof process.stdout.write
    try {
      enableMouseMode()
      // Should write: disable all 6 modes + enable 1006 + 1000
      const joined = written.join("")
      expect(joined).toContain("?1000l")
      expect(joined).toContain("?1002l")
      expect(joined).toContain("?1003l")
      expect(joined).toContain("?1005l")
      expect(joined).toContain("?1006l")
      expect(joined).toContain("?1015l")
      expect(joined).toContain("?1006h")
      expect(joined).toContain("?1000h")
    } finally {
      process.stdout.write = originalWrite
    }
  })

  test("disableMouseMode writes all 6 mouse mode disable sequences", () => {
    const written: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((data: unknown) => {
      if (typeof data === "string") written.push(data)
      return true
    }) as typeof process.stdout.write
    try {
      disableMouseMode()
      const joined = written.join("")
      expect(joined).toContain("?1000l")
      expect(joined).toContain("?1002l")
      expect(joined).toContain("?1003l")
      expect(joined).toContain("?1005l")
      expect(joined).toContain("?1006l")
      expect(joined).toContain("?1015l")
    } finally {
      process.stdout.write = originalWrite
    }
  })
})

// ── cleanupTerminal ──

describe("cleanupTerminal", () => {
  test("cleanupTerminal writes cursor show + title reset + mouse disable", () => {
    const written: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((data: unknown) => {
      if (typeof data === "string") written.push(data)
      return true
    }) as typeof process.stdout.write
    const originalRead = process.stdin.read
    try {
      installStdinFilter()
      cleanupTerminal()
      const joined = written.join("")
      expect(joined).toContain("\x1B[?25h") // show cursor
      expect(joined).toContain("\x1B]0;\x07") // reset title
      expect(joined).toContain("?1000l")
      expect(joined).toContain("?1006l")
      // After cleanup, filter should be uninstalled
      expect(process.stdin.read).toBe(originalRead)
    } finally {
      process.stdout.write = originalWrite
      process.stdin.read = originalRead
      uninstallStdinFilter()
    }
  })
})
