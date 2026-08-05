/** Tests for useTuiSelector / createSelectorSnapshot（Depthline P1）。
 *
 *  覆盖（P1 硬门禁的 selector 部分）：
 *    1. selector 字段未变化时不产生新 snapshot（unrelated 更新不通知）
 *    2. selector 字段变化时必定更新
 *    3. 默认 Object.is：组合对象 selector 必须显式 shallowEqual
 *    4. shallowEqual 对数组/对象生效
 *    5. dispatchMany 只通知一次 listener
 *    6. 组件卸载后 unsubscribe（React 集成）
 *    7. React 集成：unrelated 状态更新不触发组件重渲染
 */

import { describe, expect, test } from "bun:test"
import React from "react"
import { render, Text } from "ink"
import { PassThrough } from "node:stream"
import { TuiStore } from "../../src/tui/state/tui-store"
import {
  createSelectorSnapshot,
  shallowEqual,
  useTuiSelector,
} from "../../src/tui/state/use-tui-selector"
import { renderMetrics } from "../../src/tui/render-metrics"

function newStore(): TuiStore {
  const store = new TuiStore()
  store.dispatch({ type: "ui.status", text: "ready" })
  return store
}

function mockStdout(): NodeJS.WriteStream {
  const out = new PassThrough() as PassThrough & { columns: number; rows: number }
  out.columns = 80
  out.rows = 24
  return out as unknown as NodeJS.WriteStream
}

// ── createSelectorSnapshot（纯函数） ──

describe("createSelectorSnapshot", () => {
  test("unrelated state change: snapshot reference unchanged (Object.is)", () => {
    const store = newStore()
    const get = createSelectorSnapshot(store, s => s.messages)
    const before = get()
    store.dispatch({ type: "ui.queue_count", count: 3 })
    const after = get()
    expect(after).toBe(before)
  })

  test("selected field change: snapshot updates", () => {
    const store = newStore()
    const get = createSelectorSnapshot(store, s => s.messages)
    const before = get()
    store.dispatch({ type: "user.message", text: "hello" })
    const after = get()
    expect(after).not.toBe(before)
    // user.message 会创建 user 消息 + 空 pending assistant 消息
    expect(after.length - before.length).toBe(2)
  })

  test("primitive equality: same value keeps stored snapshot", () => {
    const store = newStore()
    const get = createSelectorSnapshot(store, s => s.queueCount)
    const before = get()
    store.dispatch({ type: "ui.status", text: "working" })
    const after = get()
    expect(after).toBe(before)
    expect(after).toBe(0)
  })

  test("default Object.is: object selector creates new snapshot on unrelated change", () => {
    const store = newStore()
    const get = createSelectorSnapshot(store, s => ({ q: s.queueCount }))
    const before = get()
    store.dispatch({ type: "ui.status", text: "working" })
    const after = get()
    expect(after).not.toBe(before) // 新对象引用 → 必须显式 shallowEqual
    expect(after).toEqual(before)
  })

  test("shallowEqual: unrelated change keeps snapshot reference", () => {
    const store = newStore()
    const get = createSelectorSnapshot(store, s => ({ q: s.queueCount, m: s.modelName }), shallowEqual)
    const before = get()
    store.dispatch({ type: "ui.status", text: "working" })
    expect(get()).toBe(before)
  })

  test("shallowEqual: selected field change updates snapshot", () => {
    const store = newStore()
    const get = createSelectorSnapshot(store, s => ({ q: s.queueCount }), shallowEqual)
    const before = get()
    store.dispatch({ type: "ui.queue_count", count: 5 })
    const after = get()
    expect(after).not.toBe(before)
    expect(after.q).toBe(5)
  })

  test("shallowEqual works on arrays", () => {
    const store = newStore()
    const get = createSelectorSnapshot(store, s => s.messages, shallowEqual)
    const before = get()
    store.dispatch({ type: "ui.status", text: "working" })
    expect(get()).toBe(before)
    store.dispatch({ type: "user.message", text: "hi" })
    expect(get()).not.toBe(before)
  })
})

// ── dispatchMany 通知语义 ──

describe("dispatchMany notification", () => {
  test("dispatchMany(N events) notifies listener once", () => {
    const store = newStore()
    let notified = 0
    const unsubscribe = store.subscribe(() => { notified++ })
    store.dispatchMany([
      { type: "assistant.delta", text: "a" },
      { type: "assistant.delta", text: "b" },
      { type: "assistant.delta", text: "c" },
    ])
    expect(notified).toBe(1)
    unsubscribe()
  })

  test("unsubscribe removes listener", () => {
    const store = newStore()
    let notified = 0
    const unsubscribe = store.subscribe(() => { notified++ })
    unsubscribe()
    store.dispatch({ type: "ui.status", text: "working" })
    expect(notified).toBe(0)
  })
})

// ── React 集成 ──

describe("useTuiSelector (React)", () => {
  test("unrelated store update does not re-render the component", async () => {
    const store = newStore()
    let renders = 0
    const Counter = React.memo(function Counter() {
      const messages = useTuiSelector(store, s => s.messages)
      renders++
      return <Text>{String(messages.length)}</Text>
    })
    const stdout = mockStdout()
    const { unmount } = render(<Counter />, { stdout })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(renders).toBeGreaterThan(0)
    const before = renders
    store.dispatch({ type: "ui.queue_count", count: 9 })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(renders).toBe(before)
    store.dispatch({ type: "user.message", text: "hello" })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(renders).toBeGreaterThan(before)
    unmount()
  })

  test("unmount unsubscribes: no selector evaluations after unmount", async () => {
    process.env.ORCANA_TUI_PROFILE = "1"
    renderMetrics.reset()
    try {
      const store = newStore()
      const Counter = React.memo(function Counter() {
        useTuiSelector(store, s => s.queueCount)
        return <Text>x</Text>
      })
      const stdout = mockStdout()
      const { unmount } = render(<Counter />, { stdout })
      await new Promise(resolve => setTimeout(resolve, 30))
      const mounted = renderMetrics.snapshot().selectorNotifications
      store.dispatch({ type: "ui.status", text: "working" })
      await new Promise(resolve => setTimeout(resolve, 30))
      const afterMounted = renderMetrics.snapshot().selectorNotifications
      expect(afterMounted).toBeGreaterThan(mounted)
      unmount()
      await new Promise(resolve => setTimeout(resolve, 30))
      const afterUnmount = renderMetrics.snapshot().selectorNotifications
      store.dispatch({ type: "ui.status", text: "ready" })
      store.dispatch({ type: "ui.queue_count", count: 1 })
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(renderMetrics.snapshot().selectorNotifications).toBe(afterUnmount)
    } finally {
      delete process.env.ORCANA_TUI_PROFILE
      renderMetrics.reset()
    }
  })
})
