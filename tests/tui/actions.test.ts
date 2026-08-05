/** Tests for ActionRegistry seam（Depthline P2）。
 *
 *  覆盖：
 *    - Ctrl+T → runtime.open（Scrollback context）
 *    - 上下文过滤：非 Scrollback context 不匹配
 *    - 修饰键过滤：无 ctrl 的 t 不匹配 Ctrl+T
 *    - 方向键归一化（pageUp 等）
 */

import { describe, expect, test } from "bun:test"
import type { Key } from "ink"
import { matchAction, findAction } from "../../src/tui/presentation/actions"

function key(overrides: Partial<Key> = {}): Key {
  return overrides as Key
}

describe("matchAction", () => {
  test("Ctrl+T 在 Scrollback context 命中 runtime.open", () => {
    const matched = matchAction("t", key({ ctrl: true }), "Scrollback")
    expect(matched?.id).toBe("runtime.open")
  })

  test("非 Ctrl 的 t 不命中", () => {
    expect(matchAction("t", key(), "Scrollback")).toBeNull()
  })

  test("Ctrl+T 在 Clarification context 不命中（contexts 过滤）", () => {
    expect(matchAction("t", key({ ctrl: true }), "Clarification")).toBeNull()
  })

  test("pageUp 命中 scroll.pageUp", () => {
    const matched = matchAction("", key({ pageUp: true }), "Scrollback")
    expect(matched?.id).toBe("scroll.pageUp")
  })

  test("Ctrl+Up 命中 scroll.up", () => {
    const matched = matchAction("", key({ ctrl: true, upArrow: true }), "Scrollback")
    expect(matched?.id).toBe("scroll.up")
  })

  test("Ctrl+T 在 Confirm context 不命中（不抢 modal 键）", () => {
    expect(matchAction("t", key({ ctrl: true }), "Confirm")).toBeNull()
  })

  test("findAction 按 id 查找", () => {
    expect(findAction("runtime.open")?.label).toBe("activity")
    expect(findAction("runtime.open")?.description).toBe("Toggle runtime inspector")
  })
})
