/** Tests for TuiStore — covers the public mutation boundary API.
 *
 *  Tested behaviors:
 *    - getState() returns the current state (and reflects dispatch)
 *    - dispatch(event) applies reducer and notifies listeners
 *    - dispatchMany(events) applies all events but notifies only once
 *    - subscribe(listener) returns an unsubscribe function
 *    - unsubscribe stops further notifications
 *    - reset() restores the initial state and notifies listeners
 *    - constructor accepts an optional initial state
 */

import { describe, expect, test } from "bun:test"
import { TuiStore } from "../../src/tui/state/tui-store"
import {
  createInitialTuiState,
  reduceTuiEvent,
} from "../../src/tui/state/event-reducer"
import type { TuiState } from "../../src/tui/state/types"

// ── getState / dispatch ──

describe("TuiStore: getState and dispatch", () => {
  test("getState() returns the initial state before any dispatch", () => {
    const store = new TuiStore()
    const state = store.getState()
    expect(state).toBeDefined()
    expect(state.messages).toEqual([])
    expect(state.done).toBe(true)
  })

  test("dispatch(event) updates state via reducer", () => {
    const store = new TuiStore()
    store.dispatch({ type: "user.message", text: "hello" })

    const state = store.getState()
    // user.message creates user + pending assistant messages
    expect(state.messages).toHaveLength(2)
    expect(state.messages[0]!.role).toBe("user")
    expect(state.messages[1]!.role).toBe("assistant")
    expect(state.messages[1]!.pending).toBe(true)
    expect(state.streamingText).toBe("")
  })

  test("dispatch(event) is consistent with reduceTuiEvent applied directly", () => {
    const store = new TuiStore()
    const event = { type: "assistant.delta", text: "chunk" } as const
    store.dispatch({ type: "user.message", text: "hi" })
    store.dispatch(event)

    // Recompute directly from reducer for comparison
    let manual = createInitialTuiState()
    manual = reduceTuiEvent(manual, { type: "user.message", text: "hi" }, 0)
    manual = reduceTuiEvent(manual, event, 0)
    // Compare all fields that don't depend on Date.now()
    expect(store.getState().messages).toHaveLength(manual.messages.length)
    expect(store.getState().streamingText).toBe(manual.streamingText)
  })
})

// ── dispatchMany ──

describe("TuiStore: dispatchMany", () => {
  test("dispatchMany applies all events and notifies only once", () => {
    const store = new TuiStore()
    let notifyCount = 0
    store.subscribe(() => {
      notifyCount++
    })

    const events = [
      { type: "user.message", text: "hello" },
      { type: "assistant.delta", text: "Hi " },
      { type: "assistant.delta", text: "there" },
      { type: "assistant.final", text: "Hi there" },
    ] as const

    store.dispatchMany(events)

    expect(notifyCount).toBe(1) // critical: single notification
    const state = store.getState()
    expect(state.messages).toHaveLength(2) // user + finalized assistant
    expect(state.streamingText).toBe("")
    const assistant = state.messages.find(m => m.role === "assistant")
    expect(assistant).toBeDefined()
    expect(assistant!.text).toBe("Hi there")
  })

  test("dispatchMany with empty array is a no-op (no notification)", () => {
    const store = new TuiStore()
    let notifyCount = 0
    store.subscribe(() => {
      notifyCount++
    })

    store.dispatchMany([])
    expect(notifyCount).toBe(0)
  })

  test("dispatchMany preserves event order", () => {
    const store = new TuiStore()
    // Push multiple event_messages; order should be preserved
    store.dispatchMany([
      { type: "ui.event_message", kind: "tool", text: "first", minIntervalMs: 0 },
      { type: "ui.event_message", kind: "tool", text: "second", minIntervalMs: 0 },
      { type: "ui.event_message", kind: "tool", text: "third", minIntervalMs: 0 },
    ])

    const msgs = store.getState().messages
    expect(msgs).toHaveLength(3)
    expect(msgs[0]!.text).toBe("first")
    expect(msgs[1]!.text).toBe("second")
    expect(msgs[2]!.text).toBe("third")
  })
})

// ── subscribe / unsubscribe ──

describe("TuiStore: subscribe", () => {
  test("subscribe(listener) is called on dispatch", () => {
    const store = new TuiStore()
    const received: TuiState[] = []
    store.subscribe(state => {
      received.push(state)
    })

    store.dispatch({ type: "user.message", text: "hi" })

    expect(received).toHaveLength(1)
    expect(received[0]!.messages).toHaveLength(2)
  })

  test("multiple listeners are all notified", () => {
    const store = new TuiStore()
    let calls1 = 0
    let calls2 = 0
    store.subscribe(() => {
      calls1++
    })
    store.subscribe(() => {
      calls2++
    })

    store.dispatch({ type: "user.message", text: "hi" })

    expect(calls1).toBe(1)
    expect(calls2).toBe(1)
  })

  test("unsubscribe stops further notifications", () => {
    const store = new TuiStore()
    let calls = 0
    const unsubscribe = store.subscribe(() => {
      calls++
    })

    store.dispatch({ type: "user.message", text: "first" })
    expect(calls).toBe(1)

    unsubscribe()

    store.dispatch({ type: "user.message", text: "second" })
    expect(calls).toBe(1) // no additional call
  })

  test("unsubscribe is idempotent", () => {
    const store = new TuiStore()
    let calls = 0
    const unsubscribe = store.subscribe(() => {
      calls++
    })

    unsubscribe()
    unsubscribe() // second call should be a no-op

    store.dispatch({ type: "user.message", text: "hi" })
    expect(calls).toBe(0)
  })

  test("same listener function can only be subscribed once", () => {
    const store = new TuiStore()
    let calls = 0
    const listener = () => {
      calls++
    }
    store.subscribe(listener)
    store.subscribe(listener) // duplicate add — Set dedupes

    store.dispatch({ type: "user.message", text: "hi" })
    expect(calls).toBe(1) // notified only once despite double subscribe
  })
})

// ── reset ──

describe("TuiStore: reset", () => {
  test("reset() restores initial state and notifies listeners", () => {
    const store = new TuiStore()
    let notifyCount = 0
    store.subscribe(() => {
      notifyCount++
    })

    store.dispatch({ type: "user.message", text: "hi" })
    store.dispatch({ type: "assistant.delta", text: "chunk" })
    expect(store.getState().messages.length).toBeGreaterThan(0)

    notifyCount = 0
    store.reset()

    expect(notifyCount).toBe(1)
    const state = store.getState()
    expect(state.messages).toEqual([])
    expect(state.streamingText).toBe("")
    expect(state.done).toBe(true)
    expect(state.tools).toEqual([])
  })

  test("reset() produces a fresh state distinct from any prior state", () => {
    const store = new TuiStore()
    store.dispatch({ type: "user.message", text: "hi" })
    const beforeReset = store.getState()

    store.reset()
    const afterReset = store.getState()

    expect(afterReset).not.toBe(beforeReset) // different object
    expect(afterReset.messages).toEqual([])
    // Fresh _nextId should be 0 again
    expect(afterReset._nextId).toBe(0)
  })
})

// ── constructor with initial state ──

describe("TuiStore: constructor", () => {
  test("constructor accepts a custom initial state", () => {
    const initial = createInitialTuiState()
    initial.done = false
    initial.status = "custom"
    initial.queueCount = 5

    const store = new TuiStore(initial)

    const state = store.getState()
    expect(state.done).toBe(false)
    expect(state.status).toBe("custom")
    expect(state.queueCount).toBe(5)
  })

  test("constructor without initial state uses createInitialTuiState()", () => {
    const store = new TuiStore()
    const state = store.getState()
    const expected = createInitialTuiState()
    // Compare everything except timestamps that might differ
    expect(state.mode).toBe(expected.mode)
    expect(state.done).toBe(expected.done)
    expect(state.status).toBe(expected.status)
    expect(state.messages).toEqual(expected.messages)
  })
})
