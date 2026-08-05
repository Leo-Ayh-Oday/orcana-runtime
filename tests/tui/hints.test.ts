/** Tests for hints + ShortcutsPanel（Depthline P3）。
 *
 *  覆盖：
 *    - 主表面 ≤3 动作
 *    - busy/idle/窄屏降级
 *    - modal 上下文提示派生自注册表
 *    - Ctrl+? 面板行无 ANSI、分组、截断
 */

import { describe, expect, test } from "bun:test"
import { hintsForContext, shortcutLabel } from "../../src/tui/presentation/hints"
import { formatShortcutLines } from "../../src/tui/components/overlays/ShortcutsPanel"

describe("hintsForContext: 主表面", () => {
  test("idle 宽屏：Enter send · / commands · ? shortcuts（≤3）", () => {
    const model = hintsForContext("Scrollback", false, 100)
    expect(model.hidden).toBe(false)
    expect(model.entries.length).toBe(3)
    expect(model.entries[0]).toEqual({ shortcut: "Enter", label: " send" })
    expect(model.entries[2].shortcut).toBe("Ctrl+?")
    expect(model.entries[2].label).toBe(" shortcuts")
  })

  test("busy：Enter queue · Esc stop · Ctrl+T activity（≤3）", () => {
    const model = hintsForContext("Scrollback", true, 100)
    expect(model.entries.length).toBe(3)
    expect(model.entries[0]).toEqual({ shortcut: "Enter", label: " queue" })
    expect(model.entries[1].shortcut).toBe("Esc")
    expect(model.entries[1].label).toBe(" stop")
    expect(model.entries[2].shortcut).toBe("Ctrl+T")
    expect(model.entries[2].label).toBe(" activity")
  })

  test("窄屏（<60）busy：只显示 Enter queue", () => {
    const model = hintsForContext("Scrollback", true, 50)
    expect(model.entries.length).toBe(1)
  })

  test("Confirm context：approve · deny · deny all 派生自注册表", () => {
    const model = hintsForContext("Confirm", false, 100)
    expect(model.entries[0].shortcut).toBe("Y")
    expect(model.entries[0].label).toBe(" approve")
    expect(model.entries[1].shortcut).toBe("N")
    expect(model.entries[2].shortcut).toBe("A")
  })

  test("CommandShelf：↑↓ select 引导 + Enter run · Tab insert · Esc close", () => {
    const model = hintsForContext("CommandShelf", false, 100)
    expect(model.entries[0].label).toBe(" ")
    expect(model.entries[1]).toEqual({ shortcut: "Enter", label: " run" })
    expect(model.entries[2]).toEqual({ shortcut: "Tab", label: " insert" })
  })
})

describe("shortcutLabel", () => {
  test("组合修饰键", () => {
    expect(shortcutLabel("t", true)).toBe("Ctrl+T")
    expect(shortcutLabel("return", undefined, true)).toBe("Shift+Enter")
    expect(shortcutLabel("up")).toBe("↑")
  })
})

describe("formatShortcutLines（Ctrl+? 面板）", () => {
  test("包含关键动作 label 且无 ANSI", () => {
    const lines = formatShortcutLines(80)
    const joined = lines.join("\n")
    expect(joined).toContain("Toggle runtime inspector")
    expect(joined).toContain("Stop current run")
    expect(joined).toContain("Show shortcut overview")
    expect(joined).not.toContain("Toggle block expansion")
    expect(joined).not.toMatch(/\u001b\[/)
  })

  test("分组标题按 context 输出一次", () => {
    const lines = formatShortcutLines(80)
    const scrollbackGroups = lines.filter(l => l === "Scrollback").length
    expect(scrollbackGroups).toBe(1)
    // 多 context 动作（rewind.select 等）在各自分组各出现一次
    const rewindListGroup = lines.indexOf("RewindList")
    expect(rewindListGroup).toBeGreaterThan(-1)
  })

  test("长描述截断", () => {
    const lines = formatShortcutLines(60)
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(60)
    }
  })
})
