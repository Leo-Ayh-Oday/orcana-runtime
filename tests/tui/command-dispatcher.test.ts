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
    dispatchAction: () => {},
    ...overrides,
  }
  return { context, store, messages }
}

/** 带模型目录 + configureModel spy 的 runtime stub。 */
function modelRuntime(models: Array<{ id: string; displayName?: string; providerId: string }>) {
  const calls: Array<{ providerId: string; modelId: string }> = []
  return {
    registry: { allModels: models, listProviders: () => [...new Set(models.map(m => m.providerId))] },
    sessionId: "test-session",
    configureModel: async (input: { providerId: string; modelId: string }) => {
      calls.push({ providerId: input.providerId, modelId: input.modelId })
    },
    calls,
  }
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

  test("bare slash shows command help instead of starting a run", () => {
    const { context, messages } = createContext()
    // 裸 "/" 是命令入口：必须 handled，绝不 pass_to_agent（否则会创建 LLM run）
    expect(dispatchTuiCommand("/", context)).toBe("handled")
    expect(messages.join(" ")).toContain("/help")
    // 带空白也归一到裸斜杠
    expect(dispatchTuiCommand(" / ", context)).toBe("handled")
  })

  test("rejects unsafe commands while the agent is running", () => {
    const { context, messages } = createContext({ isRunning: () => true })
    expect(dispatchTuiCommand("/clear", context)).toBe("handled")
    expect(messages[0]).toContain("not available while the agent is running")
  })

  test("uses runtime command aliases for local TUI commands", () => {
    let openedProvider: string | undefined
    const rt = modelRuntime([{ id: "deepseek/deepseek-v4-pro", displayName: "V4 Pro", providerId: "deepseek" }])
    const { context } = createContext({
      runtime: rt as never,
      openModels: provider => {
        openedProvider = provider
      },
    })

    expect(dispatchTuiCommand("/model deepseek", context)).toBe("handled")
    expect(openedProvider).toBe("deepseek")
  })

  test("/status emits local runtime status", () => {
    const { context, messages } = createContext()
    expect(dispatchTuiCommand("/status", context)).toBe("handled")
    expect(messages[0]).toContain("Status: ready")
    expect(messages[0]).toContain("Model: deepseek-v4-pro")
  })

  test("/runtime maps to runtime.open action (Command → Action 映射)", () => {
    let dispatched: string[] = []
    const { context } = createContext({
      dispatchAction: id => {
        dispatched.push(id)
      },
    })
    expect(dispatchTuiCommand("/runtime", context)).toBe("handled")
    expect(dispatched).toEqual(["runtime.open"])
  })

  test("/inspector alias also maps to runtime.open", () => {
    let dispatched: string[] = []
    const { context } = createContext({
      dispatchAction: id => {
        dispatched.push(id)
      },
    })
    expect(dispatchTuiCommand("/inspector", context)).toBe("handled")
    expect(dispatched).toEqual(["runtime.open"])
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

  test("registered-but-unimplemented commands emit a notice instead of passing to agent", () => {
    const { context, messages } = createContext()
    expect(dispatchTuiCommand("/save", context)).toBe("handled")
    expect(messages[0]).toContain("/save 暂不可用")
    expect(messages[0]).toContain("尚未接入")
  })

  test("all unimplemented session commands are blocked, never sent to agent", () => {
    for (const cmd of ["/compact", "/sessions", "/search", "/undo"]) {
      const { context } = createContext()
      expect(dispatchTuiCommand(cmd, context), cmd).toBe("handled")
    }
  })

  test("disabled commands are still handled (not queued) while agent is running", () => {
    const { context, messages } = createContext({ isRunning: () => true })
    expect(dispatchTuiCommand("/sessions", context)).toBe("handled")
    expect(messages[0]).toContain("暂不可用")
  })

  test("/model <id> 直接切换模型（精确匹配）", async () => {
    const rt = modelRuntime([
      { id: "deepseek-v3", displayName: "DeepSeek V3", providerId: "deepseek" },
      { id: "deepseek-v4-pro", displayName: "V4 Pro", providerId: "deepseek" },
    ])
    const { context, store, messages } = createContext({ runtime: rt as never })
    expect(dispatchTuiCommand("/model deepseek-v3", context)).toBe("handled")
    await Promise.resolve()
    expect(rt.calls).toEqual([{ providerId: "deepseek", modelId: "deepseek-v3" }])
    expect(store.getState().modelName).toBe("deepseek-v3")
    expect(messages[0]).toContain("模型已切换")
  })

  test("/models <前缀> 唯一命中时直接切换", async () => {
    const rt = modelRuntime([
      { id: "anthropic/claude-sonnet", displayName: "Claude Sonnet", providerId: "anthropic" },
      { id: "anthropic/claude-opus", displayName: "Claude Opus", providerId: "anthropic" },
    ])
    const { context, messages } = createContext({ runtime: rt as never })
    expect(dispatchTuiCommand("/models sonnet", context)).toBe("handled")
    await Promise.resolve()
    expect(rt.calls).toEqual([{ providerId: "anthropic", modelId: "anthropic/claude-sonnet" }])
    expect(messages[0]).toContain("模型已切换")
  })

  test("/model <provider> 打开过滤对话框", () => {
    const rt = modelRuntime([
      { id: "anthropic/claude-sonnet", providerId: "anthropic" },
      { id: "deepseek/deepseek-v4-pro", providerId: "deepseek" },
    ])
    let openedProvider: string | undefined
    const { context } = createContext({ runtime: rt as never, openModels: p => { openedProvider = p } })
    expect(dispatchTuiCommand("/model anthropic", context)).toBe("handled")
    expect(openedProvider).toBe("anthropic")
  })

  test("/model <未知> 提示可用 provider，不静默发 agent", async () => {
    const rt = modelRuntime([{ id: "deepseek/deepseek-v4-pro", providerId: "deepseek" }])
    const { context, messages } = createContext({ runtime: rt as never })
    expect(dispatchTuiCommand("/model nope-123", context)).toBe("handled")
    await Promise.resolve()
    expect(messages[0]).toContain("未找到模型或 provider")
    expect(messages[0]).toContain("deepseek")
    expect(rt.calls).toEqual([])
  })
})
