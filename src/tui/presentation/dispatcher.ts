/** dispatcher — ActionHandlerMap（Depthline P3）。
 *
 *  与 presentation/actions.ts 分离：
 *    - Registry = 纯元数据（测试无需 Runtime）
 *    - Dispatcher = 执行（持有 store / runtime / overlay / scroll 控制器）
 *
 *  dispatchAction(id, ctx) 返回 false 表示未注册处理（reserved 等），调用方忽略。
 */

import type { Runtime } from "../../runtime/bootstrap"
import type { TuiStore } from "../state/tui-store"
import type { OverlayState } from "../overlays"
import type { ActionId } from "./actions"

export interface ActionExecutionContext {
  store: TuiStore
  runtime: Runtime
  /** 当前是否在运行（run.stop 的空闲保护）。 */
  isWorking: boolean
  /** 当前 overlay（confirm 消息取 toolName 等用）。 */
  overlay: OverlayState
  bodyHeight: number
  scrollStep: number
  scrollUp: (amount?: number) => void
  scrollDown: (amount?: number) => void
  moveClarificationSelection: (delta: number) => void
  /** 确认当前澄清选项（ChatApp 持有 clarification 状态）。 */
  selectClarificationOption: () => void
  cancelClarification: () => void
  updateOverlay: (updater: (s: OverlayState) => OverlayState) => void
  closeOverlay: () => void
  stopRun: () => void
}

export type ActionHandler = (ctx: ActionExecutionContext) => void

/** 页面滚动量：PageUp/PageDown ≈ 视口高度 - 4（原 keymap 语义）。 */
export function pageScrollAmount(bodyHeight: number): number {
  return Math.max(3, bodyHeight - 4)
}

const handlers: Partial<Record<ActionId, ActionHandler>> = {
  "scroll.up": ctx => ctx.scrollUp(ctx.scrollStep),
  "scroll.down": ctx => ctx.scrollDown(ctx.scrollStep),
  "scroll.pageUp": ctx => ctx.scrollUp(pageScrollAmount(ctx.bodyHeight)),
  "scroll.pageDown": ctx => ctx.scrollDown(pageScrollAmount(ctx.bodyHeight)),

  "clarification.up": ctx => ctx.moveClarificationSelection(-1),
  "clarification.down": ctx => ctx.moveClarificationSelection(1),
  "clarification.select": ctx => ctx.selectClarificationOption(),
  "clarification.cancel": ctx => ctx.cancelClarification(),

  "confirm.approve": ctx => {
    const toolName = ctx.overlay.kind === "confirm" ? ctx.overlay.request.toolName : ""
    ctx.store.dispatch({ type: "ui.event_message", kind: "activity", text: `✓ confirmed ${toolName}`, minIntervalMs: 0 })
    ctx.closeOverlay()
  },
  "confirm.deny": ctx => {
    const toolName = ctx.overlay.kind === "confirm" ? ctx.overlay.request.toolName : ""
    ctx.store.dispatch({ type: "ui.event_message", kind: "error", text: `✗ denied ${toolName}`, minIntervalMs: 0 })
    ctx.closeOverlay()
  },
  "confirm.denyAll": ctx => {
    ctx.store.dispatch({ type: "ui.event_message", kind: "error", text: "✗ denied all pending confirmations", minIntervalMs: 0 })
    ctx.closeOverlay()
  },
  "confirm.dismiss": ctx => ctx.closeOverlay(),

  "rewind.up": ctx => {
    ctx.updateOverlay(s => {
      if (s.kind !== "rewind" || s.state.phase !== "list") return s
      return { ...s, state: { ...s.state, state: { ...s.state.state, selectedIndex: Math.max(0, s.state.state.selectedIndex - 1) } } }
    })
  },
  "rewind.down": ctx => {
    ctx.updateOverlay(s => {
      if (s.kind !== "rewind" || s.state.phase !== "list") return s
      return { ...s, state: { ...s.state, state: { ...s.state.state, selectedIndex: Math.min(s.state.state.entries.length - 1, s.state.state.selectedIndex + 1) } } }
    })
  },
  "rewind.select": ctx => {
    ctx.updateOverlay(s => {
      if (s.kind !== "rewind") return s
      if (s.state.phase === "list") {
        const entry = s.state.state.entries[s.state.state.selectedIndex]
        return {
          ...s,
          state: {
            phase: "confirm" as const,
            state: { visible: true, targetRound: entry?.round ?? 0, mode: "code" as const, previewFiles: [] },
          },
        }
      }
      ctx.store.dispatch({ type: "ui.event_message", kind: "activity", text: `rewind to round ${s.state.state.targetRound} (stub — backend not yet wired)`, minIntervalMs: 0 })
      return { kind: "none" }
    })
  },
  "rewind.cancel": ctx => ctx.closeOverlay(),

  "runtime.open": ctx => {
    ctx.updateOverlay(s => s.kind === "runtime-inspector" ? { kind: "none" } : { kind: "runtime-inspector" })
  },
  "shortcuts.help": ctx => {
    ctx.updateOverlay(s => s.kind === "shortcuts" ? { kind: "none" } : { kind: "shortcuts" })
  },
  "run.stop": ctx => {
    if (!ctx.isWorking) return
    ctx.stopRun()
    ctx.store.dispatch({ type: "ui.event_message", kind: "activity", text: "stopped by user", minIntervalMs: 0 })
  },
}

/** 分发动作。未注册（reserved 等）返回 false。 */
export function dispatchAction(id: ActionId, ctx: ActionExecutionContext): boolean {
  const handler = handlers[id]
  if (!handler) return false
  handler(ctx)
  return true
}
