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

function confirmCtx(overrides: Partial<KeyResolveContext> = {}): KeyResolveContext {
  return { context: "Confirm", bodyHeight: 30, scrollStep: 3, ...overrides }
}

function rewindListCtx(overrides: Partial<KeyResolveContext> = {}): KeyResolveContext {
  return { context: "RewindList", bodyHeight: 30, scrollStep: 3, ...overrides }
}

function rewindConfirmCtx(overrides: Partial<KeyResolveContext> = {}): KeyResolveContext {
  return { context: "RewindConfirm", bodyHeight: 30, scrollStep: 3, ...overrides }
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
    expect(resolveKeyAction("j", k(), clarificationCtx())).toBe("clarification.down")
  })

  test("k → clarification.up", () => {
    expect(resolveKeyAction("k", k(), clarificationCtx())).toBe("clarification.up")
  })

  test("upArrow → clarification.up", () => {
    expect(resolveKeyAction("", k({ upArrow: true }), clarificationCtx())).toBe("clarification.up")
  })

  test("downArrow → clarification.down", () => {
    expect(resolveKeyAction("", k({ downArrow: true }), clarificationCtx())).toBe("clarification.down")
  })

  test("return → clarification.select", () => {
    expect(resolveKeyAction("", k({ return: true }), clarificationCtx())).toBe("clarification.select")
  })

  test("escape → clarification.cancel", () => {
    expect(resolveKeyAction("", k({ escape: true }), clarificationCtx())).toBe("clarification.cancel")
  })

  test("unknown key returns null (pass-through to composer)", () => {
    expect(resolveKeyAction("x", k(), clarificationCtx())).toBeNull()
    expect(resolveKeyAction("", k({ tab: true }), clarificationCtx())).toBeNull()
  })
})

describe("resolveKeyAction: Scrollback context", () => {
  test("PageUp → scroll.pageUp (amount 由 dispatcher 计算)", () => {
    expect(resolveKeyAction("", k({ pageUp: true }), scrollCtx({ bodyHeight: 24 })))
      .toBe("scroll.pageUp")
  })

  test("PageDown → scroll.pageDown (amount 由 dispatcher 计算)", () => {
    expect(resolveKeyAction("", k({ pageDown: true }), scrollCtx({ bodyHeight: 40 })))
      .toBe("scroll.pageDown")
  })

  test("Ctrl+Up → scroll.up", () => {
    expect(resolveKeyAction("", k({ ctrl: true, upArrow: true }), scrollCtx({ scrollStep: 5 })))
      .toBe("scroll.up")
  })

  test("Ctrl+Down → scroll.down", () => {
    expect(resolveKeyAction("", k({ ctrl: true, downArrow: true }), scrollCtx({ scrollStep: 3 })))
      .toBe("scroll.down")
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

  test("Ctrl+Up in Clarification → null（修饰键精确匹配，↑ 不带 Ctrl）", () => {
    expect(resolveKeyAction("", k({ ctrl: true, upArrow: true }), clarificationCtx())).toBeNull()
  })

  test("Ctrl+Down in Clarification → null", () => {
    expect(resolveKeyAction("", k({ ctrl: true, downArrow: true }), clarificationCtx())).toBeNull()
  })

  test("escape IS handled in Clarification context (cancel)", () => {
    expect(resolveKeyAction("", k({ escape: true }), clarificationCtx()))
      .toBe("clarification.cancel")
  })

  test("escape → run.stop in Scrollback context（dispatcher 空闲时 no-op）", () => {
    expect(resolveKeyAction("", k({ escape: true }), scrollCtx())).toBe("run.stop")
  })
})

describe("resolveKeyAction: Confirm context", () => {
  test("y/Y → confirm.approve", () => {
    expect(resolveKeyAction("y", k(), confirmCtx())).toBe("confirm.approve")
    expect(resolveKeyAction("Y", k(), confirmCtx())).toBe("confirm.approve")
  })

  test("n/N → confirm.deny", () => {
    expect(resolveKeyAction("n", k(), confirmCtx())).toBe("confirm.deny")
    expect(resolveKeyAction("N", k(), confirmCtx())).toBe("confirm.deny")
  })

  test("a/A → confirm.denyAll", () => {
    expect(resolveKeyAction("a", k(), confirmCtx())).toBe("confirm.denyAll")
    expect(resolveKeyAction("A", k(), confirmCtx())).toBe("confirm.denyAll")
  })

  test("escape → confirm.dismiss", () => {
    expect(resolveKeyAction("", k({ escape: true }), confirmCtx())).toBe("confirm.dismiss")
  })

  test("unknown keys return null (no accidental confirm/deny)", () => {
    expect(resolveKeyAction("x", k(), confirmCtx())).toBeNull()
    expect(resolveKeyAction("", k({ return: true }), confirmCtx())).toBeNull()
  })
})

describe("resolveKeyAction: RewindList context", () => {
  test("j/down → rewind.down", () => {
    expect(resolveKeyAction("j", k(), rewindListCtx())).toBe("rewind.down")
    expect(resolveKeyAction("", k({ downArrow: true }), rewindListCtx())).toBe("rewind.down")
  })

  test("k/up → rewind.up", () => {
    expect(resolveKeyAction("k", k(), rewindListCtx())).toBe("rewind.up")
    expect(resolveKeyAction("", k({ upArrow: true }), rewindListCtx())).toBe("rewind.up")
  })

  test("return → rewind.select", () => {
    expect(resolveKeyAction("", k({ return: true }), rewindListCtx())).toBe("rewind.select")
  })

  test("escape → rewind.cancel", () => {
    expect(resolveKeyAction("", k({ escape: true }), rewindListCtx())).toBe("rewind.cancel")
  })
})

describe("resolveKeyAction: RewindConfirm context", () => {
  test("y/Y → rewind.select (confirm)", () => {
    expect(resolveKeyAction("y", k(), rewindConfirmCtx())).toBe("rewind.select")
    expect(resolveKeyAction("Y", k(), rewindConfirmCtx())).toBe("rewind.select")
  })

  test("n/N → rewind.cancel", () => {
    expect(resolveKeyAction("n", k(), rewindConfirmCtx())).toBe("rewind.cancel")
    expect(resolveKeyAction("N", k(), rewindConfirmCtx())).toBe("rewind.cancel")
  })

  test("escape → rewind.cancel", () => {
    expect(resolveKeyAction("", k({ escape: true }), rewindConfirmCtx())).toBe("rewind.cancel")
  })
})

describe("CONTEXT_PRIORITY ordering (Phase 5)", () => {
  test("Confirm has highest priority", () => {
    const { CONTEXT_PRIORITY } = require("../../src/tui/input/types")
    expect(CONTEXT_PRIORITY.Confirm).toBeGreaterThan(CONTEXT_PRIORITY.RewindConfirm)
    expect(CONTEXT_PRIORITY.Confirm).toBeGreaterThan(CONTEXT_PRIORITY.Clarification)
  })

  test("RewindConfirm > RewindList", () => {
    const { CONTEXT_PRIORITY } = require("../../src/tui/input/types")
    expect(CONTEXT_PRIORITY.RewindConfirm).toBeGreaterThan(CONTEXT_PRIORITY.RewindList)
  })

  test("Modal contexts > Clarification > Scrollback > Global", () => {
    const { CONTEXT_PRIORITY } = require("../../src/tui/input/types")
    expect(CONTEXT_PRIORITY.Confirm).toBeGreaterThan(CONTEXT_PRIORITY.Clarification)
    expect(CONTEXT_PRIORITY.Clarification).toBeGreaterThan(CONTEXT_PRIORITY.Scrollback)
    expect(CONTEXT_PRIORITY.Scrollback).toBeGreaterThan(CONTEXT_PRIORITY.Global)
  })
})
