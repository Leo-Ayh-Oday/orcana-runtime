/** Tests for Phase 2: input context resolution + keymap dispatch.
 *
 *  Covers:
 *    1. resolveActiveContext: Clarification active → Clarification, idle → Scrollback
 *    2. resolveKeyAction: Clarification keys (j/k/up/down/enter/esc)
 *    3. resolveKeyAction: Scrollback keys (PageUp/PageDown/Ctrl+Up/Ctrl+Down)
 *    4. Priority: Clarification context absorbs all tested keys, no fallthrough
 *    5. Unknown keys return null (pass-through to composer)
 */

import { describe, expect, test } from "bun:test"
import { resolveActiveContext } from "../../src/tui/input/types"
import { resolveKeyAction, type KeyResolveContext } from "../../src/tui/input/keymap"
import type { Key } from "ink"

// ── Helpers ──

/** Create a partial Key object for testing — cast to Key for type compatibility. */
function k(partial: Partial<Key> = {}): Key {
  return partial as Key
}

function scrollCtx(overrides: Partial<KeyResolveContext> = {}): KeyResolveContext {
  return { context: "Scrollback", bodyHeight: 30, scrollStep: 3, ...overrides }
}

function clarificationCtx(overrides: Partial<KeyResolveContext> = {}): KeyResolveContext {
  return { context: "Clarification", bodyHeight: 30, scrollStep: 3, ...overrides }
}

// ── resolveActiveContext ──

describe("resolveActiveContext", () => {
  test("returns Clarification when wizard is active", () => {
    expect(resolveActiveContext({ clarificationActive: true })).toBe("Clarification")
  })

  test("returns Scrollback when idle (no clarification)", () => {
    expect(resolveActiveContext({ clarificationActive: false })).toBe("Scrollback")
  })
})

describe("resolveKeyAction: Clarification context", () => {
  test("j → clarification.down", () => {
    expect(resolveKeyAction("j", k(), clarificationCtx())).toEqual({ type: "clarification.down" })
  })

  test("k → clarification.up", () => {
    expect(resolveKeyAction("k", k(), clarificationCtx())).toEqual({ type: "clarification.up" })
  })

  test("upArrow → clarification.up", () => {
    expect(resolveKeyAction("", k({ upArrow: true }), clarificationCtx())).toEqual({ type: "clarification.up" })
  })

  test("downArrow → clarification.down", () => {
    expect(resolveKeyAction("", k({ downArrow: true }), clarificationCtx())).toEqual({ type: "clarification.down" })
  })

  test("return → clarification.select", () => {
    expect(resolveKeyAction("", k({ return: true }), clarificationCtx())).toEqual({ type: "clarification.select" })
  })

  test("escape → clarification.cancel", () => {
    expect(resolveKeyAction("", k({ escape: true }), clarificationCtx())).toEqual({ type: "clarification.cancel" })
  })

  test("unknown key returns null (pass-through to composer)", () => {
    expect(resolveKeyAction("x", k(), clarificationCtx())).toBeNull()
    expect(resolveKeyAction("", k({ tab: true }), clarificationCtx())).toBeNull()
  })
})

describe("resolveKeyAction: Scrollback context", () => {
  test("PageUp → scroll.pageUp", () => {
    expect(resolveKeyAction("", k({ pageUp: true }), scrollCtx({ bodyHeight: 24 })))
      .toEqual({ type: "scroll.pageUp", amount: 20 })
  })

  test("PageDown → scroll.pageDown", () => {
    expect(resolveKeyAction("", k({ pageDown: true }), scrollCtx({ bodyHeight: 40 })))
      .toEqual({ type: "scroll.pageDown", amount: 36 })
  })

  test("Ctrl+Up → scroll.up", () => {
    expect(resolveKeyAction("", k({ ctrl: true, upArrow: true }), scrollCtx({ scrollStep: 5 })))
      .toEqual({ type: "scroll.up", amount: 5 })
  })

  test("Ctrl+Down → scroll.down", () => {
    expect(resolveKeyAction("", k({ ctrl: true, downArrow: true }), scrollCtx({ scrollStep: 3 })))
      .toEqual({ type: "scroll.down", amount: 3 })
  })

  test("Ctrl without arrow returns null (no action)", () => {
    expect(resolveKeyAction("", k({ ctrl: true }), scrollCtx())).toBeNull()
  })

  test("regular arrow (no ctrl) returns null", () => {
    expect(resolveKeyAction("", k({ upArrow: true }), scrollCtx())).toBeNull()
    expect(resolveKeyAction("", k({ downArrow: true }), scrollCtx())).toBeNull()
  })

  test("j/k do NOT navigate in scrollback (composer text, not scroll)", () => {
    expect(resolveKeyAction("j", k(), scrollCtx())).toBeNull()
    expect(resolveKeyAction("k", k(), scrollCtx())).toBeNull()
  })
})

describe("Context priority: Clarification > Scrollback", () => {
  test("PageUp is NOT handled in Clarification context (no scroll leak)", () => {
    expect(resolveKeyAction("", k({ pageUp: true }), clarificationCtx())).toBeNull()
  })

  test("Ctrl+Up in Clarification → clarification.up (Ctrl modifier consumed)", () => {
    expect(resolveKeyAction("", k({ ctrl: true, upArrow: true }), clarificationCtx()))
      .toEqual({ type: "clarification.up" })
  })

  test("Ctrl+Down in Clarification → clarification.down (Ctrl modifier consumed)", () => {
    expect(resolveKeyAction("", k({ ctrl: true, downArrow: true }), clarificationCtx()))
      .toEqual({ type: "clarification.down" })
  })

  test("escape IS handled in Clarification context (cancel)", () => {
    expect(resolveKeyAction("", k({ escape: true }), clarificationCtx()))
      .toEqual({ type: "clarification.cancel" })
  })

  test("escape is NOT handled in Scrollback context", () => {
    expect(resolveKeyAction("", k({ escape: true }), scrollCtx())).toBeNull()
  })
})

describe("CONTEXT_PRIORITY ordering", () => {
  test("Clarification has highest priority among Phase 2 contexts", () => {
    const { CONTEXT_PRIORITY } = require("../../src/tui/input/types")
    expect(CONTEXT_PRIORITY.Clarification).toBeGreaterThan(CONTEXT_PRIORITY.Scrollback)
    expect(CONTEXT_PRIORITY.Scrollback).toBeGreaterThan(CONTEXT_PRIORITY.Global)
  })
})
