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
import { resolveActiveContext, type InputContext } from "../../src/tui/input/types"
import { resolveKeyAction, type KeyResolveContext } from "../../src/tui/input/keymap"

// ── Helpers ──

function scrollCtx(overrides: Partial<KeyResolveContext> = {}): KeyResolveContext {
  return {
    context: "Scrollback",
    bodyHeight: 30,
    scrollStep: 3,
    ...overrides,
  }
}

function clarificationCtx(overrides: Partial<KeyResolveContext> = {}): KeyResolveContext {
  return {
    context: "Clarification",
    bodyHeight: 30,
    scrollStep: 3,
    ...overrides,
  }
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
    const action = resolveKeyAction("j", {}, clarificationCtx())
    expect(action).toEqual({ type: "clarification.down" })
  })

  test("k → clarification.up", () => {
    const action = resolveKeyAction("k", {}, clarificationCtx())
    expect(action).toEqual({ type: "clarification.up" })
  })

  test("upArrow → clarification.up", () => {
    const action = resolveKeyAction("", { upArrow: true }, clarificationCtx())
    expect(action).toEqual({ type: "clarification.up" })
  })

  test("downArrow → clarification.down", () => {
    const action = resolveKeyAction("", { downArrow: true }, clarificationCtx())
    expect(action).toEqual({ type: "clarification.down" })
  })

  test("return → clarification.select", () => {
    const action = resolveKeyAction("", { return: true }, clarificationCtx())
    expect(action).toEqual({ type: "clarification.select" })
  })

  test("escape → clarification.cancel", () => {
    const action = resolveKeyAction("", { escape: true }, clarificationCtx())
    expect(action).toEqual({ type: "clarification.cancel" })
  })

  test("unknown key returns null (pass-through to composer)", () => {
    expect(resolveKeyAction("x", {}, clarificationCtx())).toBeNull()
    expect(resolveKeyAction("", { tab: true }, clarificationCtx())).toBeNull()
  })
})

describe("resolveKeyAction: Scrollback context", () => {
  test("PageUp → scroll.pageUp", () => {
    const action = resolveKeyAction("", { pageUp: true }, scrollCtx({ bodyHeight: 24 }))
    expect(action).toEqual({ type: "scroll.pageUp", amount: 20 })
  })

  test("PageDown → scroll.pageDown", () => {
    const action = resolveKeyAction("", { pageDown: true }, scrollCtx({ bodyHeight: 40 }))
    expect(action).toEqual({ type: "scroll.pageDown", amount: 36 })
  })

  test("Ctrl+Up → scroll.up", () => {
    const action = resolveKeyAction("", { ctrl: true, upArrow: true }, scrollCtx({ scrollStep: 5 }))
    expect(action).toEqual({ type: "scroll.up", amount: 5 })
  })

  test("Ctrl+Down → scroll.down", () => {
    const action = resolveKeyAction("", { ctrl: true, downArrow: true }, scrollCtx({ scrollStep: 3 }))
    expect(action).toEqual({ type: "scroll.down", amount: 3 })
  })

  test("Ctrl without arrow returns null (no action)", () => {
    expect(resolveKeyAction("", { ctrl: true }, scrollCtx())).toBeNull()
  })

  test("regular arrow (no ctrl) returns null", () => {
    expect(resolveKeyAction("", { upArrow: true }, scrollCtx())).toBeNull()
    expect(resolveKeyAction("", { downArrow: true }, scrollCtx())).toBeNull()
  })

  test("j/k do NOT navigate in scrollback (composer text, not scroll)", () => {
    expect(resolveKeyAction("j", {}, scrollCtx())).toBeNull()
    expect(resolveKeyAction("k", {}, scrollCtx())).toBeNull()
  })
})

describe("Context priority: Clarification > Scrollback", () => {
  test("PageUp is NOT handled in Clarification context (no scroll leak)", () => {
    // When clarification is active, page keys must NOT trigger scroll
    const action = resolveKeyAction("", { pageUp: true }, clarificationCtx())
    expect(action).toBeNull()
  })

  test("Ctrl+Up in Clarification → clarification.up (Ctrl modifier consumed)", () => {
    // Ctrl+Up maps to clarification.up, NOT scroll.up — context isolation works
    const action = resolveKeyAction("", { ctrl: true, upArrow: true }, clarificationCtx())
    expect(action).toEqual({ type: "clarification.up" })
  })

  test("Ctrl+Down in Clarification → clarification.down (Ctrl modifier consumed)", () => {
    const action = resolveKeyAction("", { ctrl: true, downArrow: true }, clarificationCtx())
    expect(action).toEqual({ type: "clarification.down" })
  })

  test("escape IS handled in Clarification context (cancel)", () => {
    const action = resolveKeyAction("", { escape: true }, clarificationCtx())
    expect(action).toEqual({ type: "clarification.cancel" })
  })

  test("escape is NOT handled in Scrollback context", () => {
    const action = resolveKeyAction("", { escape: true }, scrollCtx())
    expect(action).toBeNull()
  })
})

describe("CONTEXT_PRIORITY ordering", () => {
  test("Clarification has highest priority among Phase 2 contexts", () => {
    const { CONTEXT_PRIORITY } = require("../../src/tui/input/types")
    expect(CONTEXT_PRIORITY.Clarification).toBeGreaterThan(CONTEXT_PRIORITY.Scrollback)
    expect(CONTEXT_PRIORITY.Scrollback).toBeGreaterThan(CONTEXT_PRIORITY.Global)
  })
})
