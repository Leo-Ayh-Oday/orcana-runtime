/** Tests for ActionRegistry 全量（Depthline P3）。
 *
 *  覆盖：
 *    - keymap 覆盖的所有动作都在注册表中（单一数据源）
 *    - matchAction 上下文/修饰键过滤
 *    - P4 reserved 动作 disabled 不参与匹配
 *    - metadata-only 动作不参与匹配（chat / command / settings 系列）
 *    - visibleActionsForContext 面板数据
 */

import { describe, expect, test } from "bun:test"
import type { Key } from "ink"
import { ACTIONS, findAction, matchAction, visibleActionsForContext, type ActionId } from "../../src/tui/presentation/actions"

function key(overrides: Partial<Key> = {}): Key {
  return overrides as Key
}

describe("registry: keymap 覆盖的每个动作都已注册", () => {
  const required: ActionId[] = [
    "scroll.up", "scroll.down", "scroll.pageUp", "scroll.pageDown",
    "clarification.up", "clarification.down", "clarification.select", "clarification.cancel",
    "confirm.approve", "confirm.deny", "confirm.denyAll", "confirm.dismiss",
    "rewind.up", "rewind.down", "rewind.select", "rewind.cancel",
    "runtime.open", "run.stop", "shortcuts.help",
  ]
  test("全部注册且含 label/description/shortcuts", () => {
    for (const id of required) {
      const action = findAction(id)
      expect(action, id).toBeDefined()
      expect(action!.label.length).toBeGreaterThan(0)
      expect(action!.description.length).toBeGreaterThan(0)
      expect(action!.shortcuts.length).toBeGreaterThan(0)
    }
  })

  test("没有重复的 action id", () => {
    const ids = ACTIONS.map(a => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("matchAction 精确匹配", () => {
  test("Ctrl+T → runtime.open（Scrollback）", () => {
    expect(matchAction("t", key({ ctrl: true }), "Scrollback")?.id).toBe("runtime.open")
  })

  test("Esc → run.stop（Scrollback）", () => {
    expect(matchAction("", key({ escape: true }), "Scrollback")?.id).toBe("run.stop")
  })

  test("y → confirm.approve（Confirm context）", () => {
    expect(matchAction("Y", key(), "Confirm")?.id).toBe("confirm.approve")
  })

  test("j → clarification.down（Clarification context）", () => {
    expect(matchAction("j", key(), "Clarification")?.id).toBe("clarification.down")
  })

  test("j 在 Scrollback context 不匹配（block 动作 P4 未启用，j 归 composer）", () => {
    expect(matchAction("j", key(), "Scrollback")).toBeNull()
  })

  test("Enter 在 Scrollback 不匹配（block.toggle P4 预留 disabled）", () => {
    expect(matchAction("", key({ return: true }), "Scrollback")).toBeNull()
  })

  test("metadata-only 动作不参与匹配", () => {
    expect(matchAction("", key({ return: true }), "RuntimeDialog")).toBeNull()
    expect(matchAction("", key({ return: true }), "Composer")).toBeNull()
    expect(matchAction("", key({ downArrow: true }), "CommandShelf")).toBeNull()
  })

  test("contexts 过滤：Ctrl+T 在 Confirm 不命中", () => {
    expect(matchAction("t", key({ ctrl: true }), "Confirm")).toBeNull()
  })

  test("block.selectDown reserved：注册但 disabled", () => {
    const block = findAction("block.selectDown")
    expect(block?.enabled).toBe(false)
    expect(matchAction("j", key(), "Scrollback")).toBeNull()
  })
})

describe("visibleActionsForContext", () => {
  test("Scrollback 可见动作含 runtime.open / run.stop / shortcuts.help，不含 block reserved", () => {
    const ids = visibleActionsForContext("Scrollback").map(a => a.id)
    expect(ids).toContain("runtime.open")
    expect(ids).toContain("run.stop")
    expect(ids).toContain("shortcuts.help")
    expect(ids).not.toContain("block.toggle")
  })

  test("Composer 可见动作含 chat.submit（供 Ctrl+? 面板展示）", () => {
    const ids = visibleActionsForContext("Composer").map(a => a.id)
    expect(ids).toContain("chat.submit")
  })

  test("Clarification 可见动作 = 4 个", () => {
    const ids = visibleActionsForContext("Clarification").map(a => a.id)
    expect(ids).toEqual(["clarification.up", "clarification.down", "clarification.select", "clarification.cancel"])
  })
})
