/** Tests for presentation/dispatcher（Depthline P3）。
 *
 *  覆盖：
 *    - scroll 动作：amount 语义（page ≈ bodyHeight - 4）
 *    - run.stop 空闲保护
 *    - runtime.open / shortcuts.help toggle
 *    - rewind 导航（list 上下移动 / select 进入 confirm / confirm 执行 stub）
 *    - clarification.select 委托给 context
 *    - confirm approve/deny 关闭 overlay + 事件消息
 */

import { describe, expect, test } from "bun:test"
import { dispatchAction, pageScrollAmount, type ActionExecutionContext } from "../../src/tui/presentation/dispatcher"
import { TuiStore } from "../../src/tui/state/tui-store"
import type { OverlayState } from "../../src/tui/overlays"
import type { Runtime } from "../../src/runtime/bootstrap"

function makeCtx(overrides: Partial<ActionExecutionContext> = {}): ActionExecutionContext & {
  overlayLog: OverlayState[]
  eventMessages: string[]
} {
  const eventMessages: string[] = []
  const store = new TuiStore()
  store.subscribe(state => {
    const last = state.messages[state.messages.length - 1]
    if (last?.role === "event") eventMessages.push(last.text)
  })
  const initialOverlay = overrides.overlay ?? { kind: "none" }
  const overlayLog: OverlayState[] = [initialOverlay]
  const ctx: ActionExecutionContext = {
    store,
    runtime: {} as Runtime,
    isWorking: false,
    overlay: initialOverlay,
    bodyHeight: 30,
    scrollStep: 3,
    scrollUp: () => {},
    scrollDown: () => {},
    moveClarificationSelection: () => {},
    selectClarificationOption: () => {},
    cancelClarification: () => {},
    updateOverlay: updater => {
      overlayLog.push(updater(overlayLog[overlayLog.length - 1] ?? { kind: "none" }))
    },
    closeOverlay: () => {
      overlayLog.push({ kind: "none" })
    },
    stopRun: () => {},
    ...overrides,
  }
  return { ...ctx, overlayLog, eventMessages }
}

describe("pageScrollAmount", () => {
  test("page ≈ bodyHeight - 4（下限 3）", () => {
    expect(pageScrollAmount(30)).toBe(26)
    expect(pageScrollAmount(6)).toBe(3)
  })
})

describe("dispatchAction", () => {
  test("scroll.pageUp 用 pageScrollAmount", () => {
    const calls: number[] = []
    const ctx = makeCtx({ bodyHeight: 24, scrollUp: amount => calls.push(amount ?? 0) })
    expect(dispatchAction("scroll.pageUp", ctx)).toBe(true)
    expect(calls).toEqual([20])
  })

  test("scroll.up 用 scrollStep", () => {
    const calls: number[] = []
    const ctx = makeCtx({ scrollStep: 5, scrollUp: amount => calls.push(amount ?? 0) })
    dispatchAction("scroll.up", ctx)
    expect(calls).toEqual([5])
  })

  test("run.stop：空闲时不触发 stopRun，也不产生事件", () => {
    let stopped = 0
    const ctx = makeCtx({ isWorking: false, stopRun: () => { stopped++ } })
    dispatchAction("run.stop", ctx)
    expect(stopped).toBe(0)
    expect(ctx.eventMessages).toEqual([])
  })

  test("run.stop：运行中触发 stopRun + 事件消息", () => {
    let stopped = 0
    const ctx = makeCtx({ isWorking: true, stopRun: () => { stopped++ } })
    dispatchAction("run.stop", ctx)
    expect(stopped).toBe(1)
    expect(ctx.eventMessages.some(m => m.includes("stopped by user"))).toBe(true)
  })

  test("runtime.open：none → runtime-inspector → none（toggle）", () => {
    const ctx = makeCtx()
    dispatchAction("runtime.open", ctx)
    expect(ctx.overlayLog[ctx.overlayLog.length - 1]!.kind).toBe("runtime-inspector")
    dispatchAction("runtime.open", ctx)
    expect(ctx.overlayLog[ctx.overlayLog.length - 1]!.kind).toBe("none")
  })

  test("shortcuts.help toggle", () => {
    const ctx = makeCtx()
    dispatchAction("shortcuts.help", ctx)
    expect(ctx.overlayLog[ctx.overlayLog.length - 1]!.kind).toBe("shortcuts")
  })

  test("clarification.select 委托 context", () => {
    let selected = 0
    const ctx = makeCtx({ selectClarificationOption: () => { selected++ } })
    dispatchAction("clarification.select", ctx)
    expect(selected).toBe(1)
  })

  test("confirm.approve：关闭 overlay + 事件消息", () => {
    const ctx = makeCtx({ overlay: { kind: "confirm", request: { requestId: "r1", toolName: "write", riskLevel: "high", riskDescription: "", params: {}, source: "", priority: 1, timestamp: 0 }, position: "" } })
    dispatchAction("confirm.approve", ctx)
    expect(ctx.overlayLog[ctx.overlayLog.length - 1]!.kind).toBe("none")
    expect(ctx.eventMessages.some(m => m.includes("write"))).toBe(true)
  })

  test("rewind.up：list 中上移 selection", () => {
    const ctx = makeCtx({
      overlay: { kind: "rewind", state: { phase: "list", state: { visible: true, selectedIndex: 1, entries: [{ round: 1, summary: "a", at: 0 }, { round: 2, summary: "b", at: 0 }] } } },
    })
    dispatchAction("rewind.up", ctx)
    const overlay = ctx.overlayLog[ctx.overlayLog.length - 1]!
    expect(overlay.kind).toBe("rewind")
    if (overlay.kind === "rewind") {
      expect(overlay.state.state.selectedIndex).toBe(0)
    }
  })

  test("rewind.select：list → confirm phase", () => {
    const ctx = makeCtx({
      overlay: { kind: "rewind", state: { phase: "list", state: { visible: true, selectedIndex: 1, entries: [{ round: 1, summary: "a", at: 0 }, { round: 2, summary: "b", at: 0 }] } } },
    })
    dispatchAction("rewind.select", ctx)
    const overlay = ctx.overlayLog[ctx.overlayLog.length - 1]!
    expect(overlay.kind).toBe("rewind")
    if (overlay.kind === "rewind") {
      expect(overlay.state.phase).toBe("confirm")
      expect(overlay.state.state.targetRound).toBe(2)
    }
  })

  test("未注册动作返回 false", () => {
    expect(dispatchAction("block.toggle", makeCtx())).toBe(false)
  })
})
