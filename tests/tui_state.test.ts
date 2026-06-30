import { describe, expect, test } from "bun:test"
import { createInitialTuiState, reduceTuiEvent } from "../src/tui/state/event-reducer"
import { TuiStore } from "../src/tui/state/tui-store"

describe("TUI state reducer", () => {
  test("user.message creates user and pending assistant messages", () => {
    const state = reduceTuiEvent(createInitialTuiState(), { type: "user.message", text: "Build it" }, 100)

    expect(state.done).toBe(false)
    expect(state.status).toBe("starting...")
    expect(state.messages).toHaveLength(2)
    expect(state.messages[0]).toMatchObject({ role: "user", text: "Build it", createdAt: 100 })
    expect(state.messages[1]).toMatchObject({ role: "assistant", text: "", pending: true })
  })

  test("assistant deltas accumulate and final clears streaming state", () => {
    let state = reduceTuiEvent(createInitialTuiState(), { type: "user.message", text: "Hello" }, 100)
    state = reduceTuiEvent(state, { type: "assistant.delta", text: "Hel" }, 110)
    state = reduceTuiEvent(state, { type: "assistant.delta", text: "lo" }, 120)

    expect(state.streamingText).toBe("Hello")
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", text: "Hello", pending: true })

    state = reduceTuiEvent(state, { type: "assistant.final", text: "" }, 130)
    expect(state.streamingText).toBe("")
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", text: "Hello", pending: false })
  })

  test("ui.event_message deduplicates within the configured interval", () => {
    let state = createInitialTuiState()
    state = reduceTuiEvent(state, { type: "ui.event_message", kind: "tool", text: "read_file", dedupeKey: "tool:read" }, 100)
    state = reduceTuiEvent(state, { type: "ui.event_message", kind: "tool", text: "read_file", dedupeKey: "tool:read" }, 500)
    state = reduceTuiEvent(state, { type: "ui.event_message", kind: "tool", text: "read_file", dedupeKey: "tool:read" }, 1200)

    expect(state.messages.map(message => message.text)).toEqual(["read_file", "read_file"])
  })
})

describe("TuiStore", () => {
  test("dispatchMany applies events in order and notifies once", () => {
    const store = new TuiStore()
    let notifications = 0
    store.subscribe(() => {
      notifications++
    })

    store.dispatchMany([
      { type: "ui.status", text: "working" },
      { type: "ui.queue_count", count: 2 },
      { type: "ui.done", done: false },
    ])

    expect(notifications).toBe(1)
    expect(store.getState()).toMatchObject({
      status: "working",
      queueCount: 2,
      done: false,
    })
  })

  test("reset returns to initial state and notifies subscribers", () => {
    const store = new TuiStore()
    let notifications = 0
    store.subscribe(() => {
      notifications++
    })

    store.dispatch({ type: "ui.status", text: "working" })
    store.reset()

    expect(notifications).toBe(2)
    expect(store.getState().status).toBe("ready")
    expect(store.getState().messages).toEqual([])
  })
})
