import { describe, expect, test } from "bun:test"
import { dispatchTuiCommand, type TuiCommandContext } from "../../src/tui/commands/dispatcher"
import { StreamEventAdapter } from "../../src/tui/state/event-adapter"
import { TuiStore } from "../../src/tui/state/tui-store"

function createContext(overrides: Partial<TuiCommandContext> = {}) {
  const store = new TuiStore()
  const adapter = new StreamEventAdapter()
  const messages: string[] = []
  const context: TuiCommandContext = {
    runtime: ({
      registry: {
        allModels: [],
        listProviders: () => [],
      },
    } as unknown) as TuiCommandContext["runtime"],
    store,
    adapter,
    historyRef: { current: [] },
    setClarification: () => {},
    addSystemMessage: (content: string) => {
      messages.push(content)
    },
    isRunning: () => false,
    exit: () => {
      throw new Error("exit")
    },
    openModels: () => {},
    openEffort: () => {},
    setThinkEffort: () => {},
    ...overrides,
  }
  return { context, store, messages }
}

describe("dispatchTuiCommand", () => {
  test("returns not_command for normal prompts", () => {
    const { context } = createContext()
    expect(dispatchTuiCommand("fix the test", context)).toBe("not_command")
  })

  test("passes unknown slash commands to the agent", () => {
    const { context } = createContext()
    expect(dispatchTuiCommand("/custom do this", context)).toBe("pass_to_agent")
  })

  test("rejects unsafe commands while the agent is running", () => {
    const { context, messages } = createContext({ isRunning: () => true })
    expect(dispatchTuiCommand("/clear", context)).toBe("handled")
    expect(messages[0]).toContain("not available while the agent is running")
  })

  test("/status emits local runtime status", () => {
    const { context, messages } = createContext()
    expect(dispatchTuiCommand("/status", context)).toBe("handled")
    expect(messages[0]).toContain("Status: ready")
    expect(messages[0]).toContain("Model: deepseek-v4-pro")
  })

  test("/clear resets history and store state", () => {
    const { context, store } = createContext()
    context.historyRef.current = [{ role: "user", content: "hello" }]
    store.dispatch({ type: "user.message", text: "hello" })

    expect(store.getState().messages.length).toBeGreaterThan(0)
    expect(dispatchTuiCommand("/clear", context)).toBe("handled")
    expect(context.historyRef.current).toEqual([])
    expect(store.getState().messages).toEqual([])
    expect(store.getState().status).toBe("ready")
  })
})
