/** TuiStore — TUI 状态的唯一 mutation 边界。
 *
 *  设计原则（来自 Orcana TUI Workbench PR-1 计划）：
 *    - UI 不直接修改 state，只通过 dispatch(event) 提交意图
 *    - 内部调用纯 reducer（reduceTuiEvent）计算下一个 state
 *    - 通过 subscribe(listener) 通知 UI 更新
 *    - reset() 回到初始 state（用于 /clear 命令或会话重置）
 *
 *  API：
 *    getState()              — 返回当前 state（调用者不应修改）
 *    dispatch(event)         — 提交单个 TuiEvent，通知 listener
 *    dispatchMany(events)    — 批量提交（适配器一次产生多个事件时使用，
 *                              仅通知一次，避免多次 re-render）
 *    subscribe(listener)     — 订阅 state 变更，返回取消订阅函数
 *    reset()                 — 重置为初始 state，通知 listener
 *
 *  通知语义：
 *    - dispatch: 同步应用 reducer，同步通知所有 listener
 *    - dispatchMany: 顺序应用每个事件的 reducer，全部完成后通知一次
 *    - reset: 替换为 createInitialTuiState()，通知 listener
 *
 *  线程模型：
 *    单线程（Node.js/Bun 事件循环），无锁。listener 在 dispatch 调用栈中
 *    同步执行，因此 listener 内不应调用 dispatch（会导致递归）。如需在
 *    listener 中触发新事件，使用 queueMicrotask 或 setTimeout(0) 延迟。
 */

import type { TuiEvent } from "../events"
import type { TuiState } from "./types"
import { createInitialTuiState, reduceTuiEvent } from "./event-reducer"

export type TuiStoreListener = (state: TuiState) => void

export class TuiStore {
  private state: TuiState
  private listeners: Set<TuiStoreListener>

  constructor(initial?: TuiState) {
    this.state = initial ?? createInitialTuiState()
    this.listeners = new Set()
  }

  /** 返回当前 state。调用者不应直接修改返回的对象。 */
  getState(): TuiState {
    return this.state
  }

  /** 提交单个事件，更新 state 并通知所有 listener。 */
  dispatch(event: TuiEvent): void {
    this.state = reduceTuiEvent(this.state, event, Date.now())
    this.notify()
  }

  /** 批量提交多个事件。顺序应用 reducer，全部完成后仅通知一次。
   *  适配器（StreamEventAdapter.adapt）一次可能产生 3-4 个 TuiEvent，
   *  使用 dispatchMany 避免每个事件都触发一次 listener 通知。 */
  dispatchMany(events: readonly TuiEvent[]): void {
    if (events.length === 0) return
    const now = Date.now()
    let next = this.state
    for (const ev of events) {
      next = reduceTuiEvent(next, ev, now)
    }
    this.state = next
    this.notify()
  }

  /** 订阅 state 变更。返回取消订阅函数。
   *  listener 在 dispatch/dispatchMany/reset 的调用栈中同步执行，
   *  不应在 listener 内直接调用 dispatch（会导致递归）。 */
  subscribe(listener: TuiStoreListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 重置为初始 state 并通知 listener。
   *  用于 /clear 命令或会话重置。 */
  reset(): void {
    this.state = createInitialTuiState()
    this.notify()
  }

  // ── 内部 ──

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }
}
