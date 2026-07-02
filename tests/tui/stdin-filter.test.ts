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
  mouseEvents,
  enableMouseMode,
  disableMouseMode,
  _getPendingBuffer,
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

// ── 滚轮事件提取 (mouseEvents) ──

describe("mouseEvents scroll extraction", () => {
  test("scroll wheel up emits scroll event with direction -1", () => {
    const events: Array<{ direction: number; isCtrl: boolean }> = []
    const handler = (direction: number, isCtrl: boolean) => events.push({ direction, isCtrl })
    mouseEvents.on("scroll", handler)
    try {
      installStdinFilter()
      // Simulate stdin receiving SGR scroll wheel up (button 64)
      process.stdin.emit("data", "\x1B[<64;40;10M")
      expect(events).toHaveLength(1)
      expect(events[0]?.direction).toBe(-1)
      expect(events[0]?.isCtrl).toBe(false)
    } finally {
      uninstallStdinFilter()
      mouseEvents.off("scroll", handler)
    }
  })

  test("scroll wheel down emits scroll event with direction +1", () => {
    const events: Array<{ direction: number; isCtrl: boolean }> = []
    const handler = (direction: number, isCtrl: boolean) => events.push({ direction, isCtrl })
    mouseEvents.on("scroll", handler)
    try {
      installStdinFilter()
      // Simulate stdin receiving SGR scroll wheel down (button 65)
      process.stdin.emit("data", "\x1B[<65;40;10M")
      expect(events).toHaveLength(1)
      expect(events[0]?.direction).toBe(1)
      expect(events[0]?.isCtrl).toBe(false)
    } finally {
      uninstallStdinFilter()
      mouseEvents.off("scroll", handler)
    }
  })

  test("Ctrl+scroll wheel up (button 68) emits with isCtrl=true", () => {
    const events: Array<{ direction: number; isCtrl: boolean }> = []
    const handler = (direction: number, isCtrl: boolean) => events.push({ direction, isCtrl })
    mouseEvents.on("scroll", handler)
    try {
      installStdinFilter()
      process.stdin.emit("data", "\x1B[<68;40;10M")
      expect(events).toHaveLength(1)
      expect(events[0]?.direction).toBe(-1)
      expect(events[0]?.isCtrl).toBe(true)
    } finally {
      uninstallStdinFilter()
      mouseEvents.off("scroll", handler)
    }
  })

  test("Ctrl+scroll wheel down (button 69) emits with isCtrl=true", () => {
    const events: Array<{ direction: number; isCtrl: boolean }> = []
    const handler = (direction: number, isCtrl: boolean) => events.push({ direction, isCtrl })
    mouseEvents.on("scroll", handler)
    try {
      installStdinFilter()
      process.stdin.emit("data", "\x1B[<69;40;10M")
      expect(events).toHaveLength(1)
      expect(events[0]?.direction).toBe(1)
      expect(events[0]?.isCtrl).toBe(true)
    } finally {
      uninstallStdinFilter()
      mouseEvents.off("scroll", handler)
    }
  })

  test("mouse click (button 0) does not emit scroll event", () => {
    const events: unknown[] = []
    const handler = (...args: unknown[]) => events.push(args)
    mouseEvents.on("scroll", handler)
    try {
      installStdinFilter()
      process.stdin.emit("data", "\x1B[<0;40;10M")
      expect(events).toHaveLength(0)
    } finally {
      uninstallStdinFilter()
      mouseEvents.off("scroll", handler)
    }
  })

  test("multiple scroll events in one chunk all extracted", () => {
    const events: number[] = []
    const handler = (direction: number) => events.push(direction)
    mouseEvents.on("scroll", handler)
    try {
      installStdinFilter()
      // Two scroll ups + one scroll down in a single chunk
      process.stdin.emit("data", "\x1B[<64;40;10M\x1B[<64;41;11M\x1B[<65;42;12M")
      expect(events).toHaveLength(3)
      expect(events[0]).toBe(-1)
      expect(events[1]).toBe(-1)
      expect(events[2]).toBe(1)
    } finally {
      uninstallStdinFilter()
      mouseEvents.off("scroll", handler)
    }
  })
})

// ── enableMouseMode / disableMouseMode ──

describe("enableMouseMode / disableMouseMode", () => {
  test("enableMouseMode writes SGR + normal mouse mode escape sequences", () => {
    const written: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((data: unknown) => {
      if (typeof data === "string") written.push(data)
      return true
    }) as typeof process.stdout.write
    try {
      enableMouseMode()
      expect(written.join("")).toBe("\x1B[?1006h\x1B[?1000h")
    } finally {
      process.stdout.write = originalWrite
    }
  })

  test("disableMouseMode writes disable escape sequences", () => {
    const written: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((data: unknown) => {
      if (typeof data === "string") written.push(data)
      return true
    }) as typeof process.stdout.write
    try {
      disableMouseMode()
      expect(written.join("")).toBe("\x1B[?1000l\x1B[?1006l")
    } finally {
      process.stdout.write = originalWrite
    }
  })
})

// ── 跨 chunk 边界处理 (pendingBuffer) ──

describe("cross-chunk mouse sequence handling", () => {
  test("incomplete SGR prefix at chunk end is buffered, not emitted", () => {
    const received: string[] = []
    const origEmit = process.stdin.emit
    try {
      installStdinFilter()
      // Capture what gets through to the real emit
      const filteredEmit = process.stdin.emit
      process.stdin.emit = ((event: string | symbol, ...args: unknown[]) => {
        if (event === "data" && typeof args[0] === "string") received.push(args[0])
        return filteredEmit.call(process.stdin, event, ...args)
      }) as typeof process.stdin.emit

      // Send incomplete prefix: \x1B[<64;40; (missing row and terminator)
      process.stdin.emit("data", "hello\x1B[<64;40;")
      // "hello" should be emitted, but \x1B[<64;40; should be buffered
      expect(received).toEqual(["hello"])
      expect(_getPendingBuffer()).toBe("\x1B[<64;40;")
    } finally {
      process.stdin.emit = origEmit
      uninstallStdinFilter()
    }
  })

  test("buffered prefix completes with next chunk, scroll event extracted", () => {
    const events: number[] = []
    const handler = (direction: number) => events.push(direction)
    const received: string[] = []
    const origEmit = process.stdin.emit
    mouseEvents.on("scroll", handler)
    try {
      installStdinFilter()
      const filteredEmit = process.stdin.emit
      process.stdin.emit = ((event: string | symbol, ...args: unknown[]) => {
        if (event === "data" && typeof args[0] === "string") received.push(args[0])
        return filteredEmit.call(process.stdin, event, ...args)
      }) as typeof process.stdin.emit

      // Chunk 1: incomplete prefix
      process.stdin.emit("data", "\x1B[<64;40;")
      expect(received).toHaveLength(0)
      expect(_getPendingBuffer()).toBe("\x1B[<64;40;")

      // Chunk 2: completion (10M = row 10, terminator M)
      process.stdin.emit("data", "10M")
      // No data should be emitted (complete mouse sequence stripped)
      expect(received).toHaveLength(0)
      // Scroll event should be extracted (button 64 = scroll up)
      expect(events).toHaveLength(1)
      expect(events[0]).toBe(-1)
      // pendingBuffer should be empty
      expect(_getPendingBuffer()).toBe("")
    } finally {
      process.stdin.emit = origEmit
      uninstallStdinFilter()
      mouseEvents.off("scroll", handler)
    }
  })

  test("multiple mouse sequences split across chunks all stripped", () => {
    const events: number[] = []
    const handler = (direction: number) => events.push(direction)
    const received: string[] = []
    const origEmit = process.stdin.emit
    mouseEvents.on("scroll", handler)
    try {
      installStdinFilter()
      const filteredEmit = process.stdin.emit
      process.stdin.emit = ((event: string | symbol, ...args: unknown[]) => {
        if (event === "data" && typeof args[0] === "string") received.push(args[0])
        return filteredEmit.call(process.stdin, event, ...args)
      }) as typeof process.stdin.emit

      // Chunk 1: two complete sequences + incomplete prefix
      process.stdin.emit("data", "\x1B[<64;40;10M\x1B[<65;41;11M\x1B[<64;")
      // No data emitted (all mouse sequences or incomplete prefix)
      expect(received).toHaveLength(0)
      // Two scroll events extracted
      expect(events).toHaveLength(2)
      expect(events[0]).toBe(-1) // button 64 = up
      expect(events[1]).toBe(1)  // button 65 = down

      // Chunk 2: completion of third sequence
      process.stdin.emit("data", "42;12M")
      expect(received).toHaveLength(0)
      expect(events).toHaveLength(3)
      expect(events[2]).toBe(-1) // button 64 = up
    } finally {
      process.stdin.emit = origEmit
      uninstallStdinFilter()
      mouseEvents.off("scroll", handler)
    }
  })

  test("ESC key alone is NOT buffered (preserves Esc functionality)", () => {
    const received: string[] = []
    const origEmit = process.stdin.emit
    try {
      installStdinFilter()
      const filteredEmit = process.stdin.emit
      process.stdin.emit = ((event: string | symbol, ...args: unknown[]) => {
        if (event === "data" && typeof args[0] === "string") received.push(args[0])
        return filteredEmit.call(process.stdin, event, ...args)
      }) as typeof process.stdin.emit

      // Single ESC character should pass through immediately
      process.stdin.emit("data", "\x1B")
      expect(received).toEqual(["\x1B"])
      expect(_getPendingBuffer()).toBe("")
    } finally {
      process.stdin.emit = origEmit
      uninstallStdinFilter()
    }
  })

  test("non-mouse text after buffered prefix is emitted correctly", () => {
    const received: string[] = []
    const origEmit = process.stdin.emit
    try {
      installStdinFilter()
      const filteredEmit = process.stdin.emit
      process.stdin.emit = ((event: string | symbol, ...args: unknown[]) => {
        if (event === "data" && typeof args[0] === "string") received.push(args[0])
        return filteredEmit.call(process.stdin, event, ...args)
      }) as typeof process.stdin.emit

      // Chunk 1: incomplete prefix
      process.stdin.emit("data", "\x1B[<64;40;")
      expect(received).toHaveLength(0)

      // Chunk 2: completion + normal text
      process.stdin.emit("data", "10Mhello")
      // "hello" should be emitted (mouse sequence stripped)
      expect(received).toEqual(["hello"])
      expect(_getPendingBuffer()).toBe("")
    } finally {
      process.stdin.emit = origEmit
      uninstallStdinFilter()
    }
  })

  test("uninstallStdinFilter clears pendingBuffer", () => {
    const origEmit = process.stdin.emit
    try {
      installStdinFilter()
      // Put something in the buffer
      process.stdin.emit("data", "\x1B[<64;40;")
      expect(_getPendingBuffer()).toBe("\x1B[<64;40;")

      uninstallStdinFilter()
      expect(_getPendingBuffer()).toBe("")
    } finally {
      process.stdin.emit = origEmit
      uninstallStdinFilter()
    }
  })
})
