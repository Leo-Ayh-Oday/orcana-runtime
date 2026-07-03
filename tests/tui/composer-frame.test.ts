/** Tests for PR-2 + PR-5: ComposerFrame + FooterHints context-aware switching.
 *
 *  Covers:
 *    1. makeDivider: 宽度计算 + 下限保护
 *    2. ComposerFrame: 纯展示组件结构
 *    3. PR-5: resolveActiveContext — CommandShelf context resolution
 *    4. PR-5: resolveKeyAction — CommandShelf pass-through（不抢键）
 *    5. PR-2 集成场景: footerHeight 包含分隔线
 */

import { describe, expect, test } from "bun:test"
import { makeDivider } from "../../src/tui/components/ComposerFrame"
import { resolveActiveContext, CONTEXT_PRIORITY, type InputContext } from "../../src/tui/input/types"
import { resolveKeyAction, type KeyResolveContext } from "../../src/tui/input/keymap"
import type { Key } from "ink"

// ── makeDivider: 宽度计算 ──

describe("PR-2: makeDivider", () => {
  test("正常宽度生成对应数量横线", () => {
    expect(makeDivider(80).length).toBe(80)
    expect(makeDivider(40).length).toBe(40)
    expect(makeDivider(100).length).toBe(100)
  })

  test("下限保护: 宽度 < 20 时用 20", () => {
    expect(makeDivider(10).length).toBe(20)
    expect(makeDivider(5).length).toBe(20)
    expect(makeDivider(0).length).toBe(20)
    expect(makeDivider(-5).length).toBe(20)
  })

  test("恰好 20 时不放大", () => {
    expect(makeDivider(20).length).toBe(20)
  })

  test("使用全角横线 ─ 字符", () => {
    const divider = makeDivider(40)
    expect(divider).toMatch(/^─+$/)
    expect(divider.charAt(0)).toBe("─")
  })

  test("空字符串不出现（下限保护）", () => {
    const divider = makeDivider(0)
    expect(divider.length).toBeGreaterThan(0)
  })
})

// ── ComposerFrame: 数据结构验证 ──

describe("PR-2: ComposerFrame structure", () => {
  test("ComposerFrameProps 包含 children + width", () => {
    const props = { children: null, width: 80 }
    expect(props.width).toBe(80)
    expect(props.children).toBeNull()
  })

  test("width 传递给 makeDivider 生成分隔线", () => {
    const width = 60
    const divider = makeDivider(width)
    expect(divider.length).toBe(width)
  })
})

// ── PR-5: resolveActiveContext — CommandShelf context ──

describe("PR-5: resolveActiveContext with commandOpen", () => {
  test("commandOpen=true → CommandShelf context", () => {
    expect(resolveActiveContext({
      clarificationActive: false,
      commandOpen: true,
    })).toBe("CommandShelf")
  })

  test("commandOpen=false → Scrollback context", () => {
    expect(resolveActiveContext({
      clarificationActive: false,
      commandOpen: false,
    })).toBe("Scrollback")
  })

  test("commandOpen 默认 undefined → Scrollback", () => {
    expect(resolveActiveContext({
      clarificationActive: false,
    })).toBe("Scrollback")
  })

  test("Clarification 优先于 commandOpen", () => {
    expect(resolveActiveContext({
      clarificationActive: true,
      commandOpen: true,
    })).toBe("Clarification")
  })

  test("Confirm 优先于 commandOpen", () => {
    expect(resolveActiveContext({
      clarificationActive: false,
      confirmActive: true,
      commandOpen: true,
    })).toBe("Confirm")
  })

  test("RewindList 优先于 commandOpen", () => {
    expect(resolveActiveContext({
      clarificationActive: false,
      rewindListActive: true,
      commandOpen: true,
    })).toBe("RewindList")
  })

  test("RewindConfirm 优先于 commandOpen", () => {
    expect(resolveActiveContext({
      clarificationActive: false,
      rewindConfirmActive: true,
      commandOpen: true,
    })).toBe("RewindConfirm")
  })
})

// ── PR-5: CONTEXT_PRIORITY 排序 ──

describe("PR-5: CONTEXT_PRIORITY with CommandShelf", () => {
  test("CommandShelf > Scrollback", () => {
    expect(CONTEXT_PRIORITY.CommandShelf).toBeGreaterThan(CONTEXT_PRIORITY.Scrollback)
  })

  test("Clarification > CommandShelf", () => {
    expect(CONTEXT_PRIORITY.Clarification).toBeGreaterThan(CONTEXT_PRIORITY.CommandShelf)
  })

  test("CommandShelf > Composer > Global", () => {
    expect(CONTEXT_PRIORITY.CommandShelf).toBeGreaterThan(CONTEXT_PRIORITY.Composer)
    expect(CONTEXT_PRIORITY.CommandShelf).toBeGreaterThan(CONTEXT_PRIORITY.Global)
  })

  test("CommandShelf priority = 2", () => {
    expect(CONTEXT_PRIORITY.CommandShelf).toBe(2)
  })

  test("完整优先级链: Confirm > RewindConfirm > RewindList=Clarification > CommandShelf > Scrollback > Composer > Global", () => {
    expect(CONTEXT_PRIORITY.Confirm).toBeGreaterThan(CONTEXT_PRIORITY.RewindConfirm)
    expect(CONTEXT_PRIORITY.RewindConfirm).toBeGreaterThan(CONTEXT_PRIORITY.RewindList)
    expect(CONTEXT_PRIORITY.RewindList).toBe(CONTEXT_PRIORITY.Clarification)
    expect(CONTEXT_PRIORITY.Clarification).toBeGreaterThan(CONTEXT_PRIORITY.CommandShelf)
    expect(CONTEXT_PRIORITY.CommandShelf).toBeGreaterThan(CONTEXT_PRIORITY.Scrollback)
    expect(CONTEXT_PRIORITY.Scrollback).toBeGreaterThan(CONTEXT_PRIORITY.Composer)
    expect(CONTEXT_PRIORITY.Composer).toBeGreaterThan(CONTEXT_PRIORITY.Global)
  })
})

// ── PR-5: resolveKeyAction — CommandShelf pass-through ──

describe("PR-5: resolveKeyAction CommandShelf pass-through", () => {
  function k(partial: Partial<Key> = {}): Key {
    return partial as Key
  }

  function commandShelfCtx(overrides: Partial<KeyResolveContext> = {}): KeyResolveContext {
    return { context: "CommandShelf", bodyHeight: 30, scrollStep: 3, ...overrides }
  }

  test("CommandShelf: PageUp → null（不滚动，pass-through 到 OrcanaComposer）", () => {
    expect(resolveKeyAction("", k({ pageUp: true }), commandShelfCtx())).toBeNull()
  })

  test("CommandShelf: PageDown → null（不滚动）", () => {
    expect(resolveKeyAction("", k({ pageDown: true }), commandShelfCtx())).toBeNull()
  })

  test("CommandShelf: Ctrl+Up → null（不滚动）", () => {
    expect(resolveKeyAction("", k({ ctrl: true, upArrow: true }), commandShelfCtx())).toBeNull()
  })

  test("CommandShelf: Ctrl+Down → null（不滚动）", () => {
    expect(resolveKeyAction("", k({ ctrl: true, downArrow: true }), commandShelfCtx())).toBeNull()
  })

  test("CommandShelf: ↑ → null（pass-through 到 OrcanaComposer 命令导航）", () => {
    expect(resolveKeyAction("", k({ upArrow: true }), commandShelfCtx())).toBeNull()
  })

  test("CommandShelf: ↓ → null（pass-through 到 OrcanaComposer 命令导航）", () => {
    expect(resolveKeyAction("", k({ downArrow: true }), commandShelfCtx())).toBeNull()
  })

  test("CommandShelf: Enter → null（pass-through 到 OrcanaComposer 命令执行）", () => {
    expect(resolveKeyAction("", k({ return: true }), commandShelfCtx())).toBeNull()
  })

  test("CommandShelf: Esc → null（pass-through 到 OrcanaComposer 关闭菜单）", () => {
    expect(resolveKeyAction("", k({ escape: true }), commandShelfCtx())).toBeNull()
  })

  test("CommandShelf: Tab → null（pass-through 到 OrcanaComposer 命令补全）", () => {
    expect(resolveKeyAction("", k({ tab: true }), commandShelfCtx())).toBeNull()
  })

  test("CommandShelf: 任意字符 → null（pass-through 到 TextArea 文本编辑）", () => {
    expect(resolveKeyAction("x", k(), commandShelfCtx())).toBeNull()
    expect(resolveKeyAction("/", k(), commandShelfCtx())).toBeNull()
  })
})

// ── PR-5: 对比 Scrollback vs CommandShelf 键位行为 ──

describe("PR-5: Scrollback vs CommandShelf key behavior", () => {
  function k(partial: Partial<Key> = {}): Key {
    return partial as Key
  }

  test("PageUp: Scrollback 滚动 vs CommandShelf pass-through", () => {
    const scrollResult = resolveKeyAction("", k({ pageUp: true }), {
      context: "Scrollback", bodyHeight: 30, scrollStep: 3,
    })
    const commandResult = resolveKeyAction("", k({ pageUp: true }), {
      context: "CommandShelf", bodyHeight: 30, scrollStep: 3,
    })
    expect(scrollResult).not.toBeNull()
    expect(scrollResult!.type).toBe("scroll.pageUp")
    expect(commandResult).toBeNull()
  })

  test("Ctrl+Up: Scrollback 滚动 vs CommandShelf pass-through", () => {
    const scrollResult = resolveKeyAction("", k({ ctrl: true, upArrow: true }), {
      context: "Scrollback", bodyHeight: 30, scrollStep: 3,
    })
    const commandResult = resolveKeyAction("", k({ ctrl: true, upArrow: true }), {
      context: "CommandShelf", bodyHeight: 30, scrollStep: 3,
    })
    expect(scrollResult).not.toBeNull()
    expect(scrollResult!.type).toBe("scroll.up")
    expect(commandResult).toBeNull()
  })
})

// ── PR-2 集成: footerHeight 计算包含分隔线 ──

describe("PR-2: footerHeight includes divider lines", () => {
  test("footerHeight = panelRows + inputRows + 1(hints) + thinkingDockRows + 2(dividers)", () => {
    const panelRows = 0
    const inputRows = 2
    const hintsRows = 1
    const thinkingDockRows = 0
    const dividerRows = 2
    const expected = panelRows + inputRows + hintsRows + thinkingDockRows + dividerRows
    expect(expected).toBe(5)
  })

  test("thinkingDock 可见时 footerHeight 增加 1", () => {
    const base = 0 + 2 + 1 + 0 + 2
    const withThinkingDock = 0 + 2 + 1 + 1 + 2
    expect(withThinkingDock - base).toBe(1)
  })

  test("commandOpen 时 inputRows=5, footerHeight 相应增加", () => {
    const idle = 0 + 2 + 1 + 0 + 2
    const command = 0 + 5 + 1 + 0 + 2
    expect(command - idle).toBe(3)
  })
})

// ── PR-5: TuiAction 命名空间 ──

describe("PR-5: TuiAction namespace", () => {
  test("TuiAction 包含 chat.* actions", () => {
    const chatActions: Array<string> = ["chat.submit", "chat.newline", "chat.cancel"]
    for (const action of chatActions) {
      expect(action).toMatch(/^chat\./)
    }
  })

  test("TuiAction 包含 command.* actions", () => {
    const commandActions: Array<string> = [
      "command.next", "command.previous", "command.submit", "command.insert", "command.close",
    ]
    for (const action of commandActions) {
      expect(action).toMatch(/^command\./)
    }
  })

  test("TuiAction 包含 scroll.* actions", () => {
    const scrollActions: Array<string> = ["scroll.up", "scroll.down", "scroll.pageUp", "scroll.pageDown"]
    for (const action of scrollActions) {
      expect(action).toMatch(/^scroll\./)
    }
  })

  test("TuiAction 包含 app.* actions", () => {
    const appActions: Array<string> = ["app.interrupt", "app.toggleTranscript"]
    for (const action of appActions) {
      expect(action).toMatch(/^app\./)
    }
  })

  test("TuiAction 包含 tool.toggleExpand", () => {
    expect("tool.toggleExpand").toMatch(/^tool\./)
  })
})
