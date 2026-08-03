import { describe, expect, test } from "bun:test"
import { buildTool, buildTools, isRuntimeBuiltToolDescriptor, Result } from "../src/tools/registry"

function restoreEnv(name: string, old: string | undefined) {
  if (old === undefined) delete process.env[name]
  else process.env[name] = old
}

describe("Tool Registry", () => {
  test("buildTool creates executable tool descriptor", async () => {
    const tool = buildTool({
      name: "echo",
      description: "Echoes input",
      isReadonly: true,
      inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
      async execute(params) {
        return Result.ok(String(params.msg))
      },
    })

    const result = await tool.execute({ msg: "hello" })
    expect(result.success).toBe(true)
    if (result.success) expect(result.content).toBe("hello")
    expect(isRuntimeBuiltToolDescriptor(tool)).toBe(true)
    expect(isRuntimeBuiltToolDescriptor({ ...tool })).toBe(false)

    const originalExecute = tool.execute
    tool.execute = async () => Result.ok("tampered")
    expect(isRuntimeBuiltToolDescriptor(tool)).toBe(false)
    tool.execute = originalExecute
    expect(isRuntimeBuiltToolDescriptor(tool)).toBe(true)
  })

  test("validation blocks invalid input", async () => {
    const tool = buildTool({
      name: "gated",
      description: "Gated tool",
      isReadonly: true,
      inputSchema: { type: "object", properties: {} },
      validate() {
        return { ok: false, message: "bad input" }
      },
      async execute() { return Result.ok("ok") },
    })

    const result = await tool.execute({})
    expect(result.success).toBe(false)
    if (!result.success) expect(result.content).toContain("blocked")
  })

  test("requiresConfirmation blocks without confirm=true", async () => {
    // Force interactive mode — test env has no TTY, so isNonInteractive() returns true
    const old = process.env.ORCANA_INTERACTIVE
    process.env.ORCANA_INTERACTIVE = "1"
    try {
    const tool = buildTool({
      name: "danger",
      description: "Dangerous tool",
      isReadonly: false,
      requiresConfirmation: true,
      inputSchema: { type: "object", properties: { confirm: { type: "boolean" } } },
      async execute() { return Result.ok("done") },
    })

    const result = await tool.execute({})
    expect(result.success).toBe(false)
    if (!result.success) expect(result.content).toContain("confirmation")
    } finally { restoreEnv("ORCANA_INTERACTIVE", old) }
  })

  test("buildTools creates multiple", () => {
    const tools = buildTools(
      { name: "a", description: "A", isReadonly: true, inputSchema: { type: "object", properties: {} }, async execute() { return Result.ok("a") } },
      { name: "b", description: "B", isReadonly: true, inputSchema: { type: "object", properties: {} }, async execute() { return Result.ok("b") } },
    )
    expect(tools).toHaveLength(2)
    expect(tools[0]!.defn.name).toBe("a")
  })

  test("toAnthropicSchema returns correct format", () => {
    const tool = buildTool({
      name: "test",
      description: "Test tool",
      isReadonly: true,
      inputSchema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
      async execute() { return Result.ok("ok") },
    })

    const schema = tool.toAnthropicSchema()
    expect(schema.name).toBe("test")
  })

  test("toAnthropicSchema exposes confirm for confirmed write tools", () => {
    const old = process.env.ORCANA_INTERACTIVE
    process.env.ORCANA_INTERACTIVE = "1"
    try {
    const tool = buildTool({
      name: "write",
      description: "Write tool",
      isReadonly: false,
      requiresConfirmation: true,
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      async execute() { return Result.ok("ok") },
    })

    const schema = tool.toAnthropicSchema() as { input_schema: { properties: Record<string, unknown>; required: string[] } }
    expect(schema.input_schema.properties.confirm).toBeTruthy()
    expect(schema.input_schema.required).toContain("confirm")
    } finally { restoreEnv("ORCANA_INTERACTIVE", old) }
  })
})

describe("Router", () => {
  test("first round is non-thinking", async () => {
    const { createState, decideThinking } = await import("../src/agent/router")
    const state = createState()
    expect(decideThinking(state)).toBeUndefined()
  })

  test("readonly tools stay non-thinking", async () => {
    const { createState, decideThinking, updateState } = await import("../src/agent/router")
    const state = createState()
    updateState(state, ["read_file", "web_search"], ["a.py"], false)
    expect(decideThinking(state)).toBeUndefined()
  })

  test("write tools upgrade to thinking", async () => {
    const { createState, decideThinking, updateState } = await import("../src/agent/router")
    const state = createState()
    updateState(state, ["edit_file"], ["a.py"], false)
    expect(decideThinking(state)).toEqual({ type: "enabled", budget_tokens: 8192, effort: "high" })
  })

  test("complex long task can think on the first round", async () => {
    const { createState, decideThinkingPlan } = await import("../src/agent/router")
    const state = createState()
    const decision = decideThinkingPlan(state, undefined, {
      prompt: "Implement a complete full-stack project with frontend, backend API, tests, build verification, and production quality.",
      intentMode: "long_task",
      planningPhase: true,
    })

    expect(decision.thinking?.type).toBe("enabled")
    expect(decision.thinking?.effort).toBe("max")
    expect(decision.thinking?.budget_tokens).toBeGreaterThanOrEqual(16384)
    expect(decision.visibleStatus).toContain("深度思考：")
  })

  test("explicit short Chinese deep-thinking prompts use max thinking", async () => {
    const { createState, decideThinkingPlan } = await import("../src/agent/router")
    const decision = decideThinkingPlan(createState(), undefined, {
      prompt: "帮我思考一个问题，要深度思考，怎么让智能体拥有推翻自己又重组自己的能力",
      intentMode: "readonly",
    })

    expect(decision.thinking?.type).toBe("enabled")
    expect(decision.thinking?.effort).toBe("max")
    expect(decision.visibleStatus).toContain("深度思考：")
    expect(decision.factors).toContain("明确要求深思")
  })

  test("single-file structural work gets deeper thinking than a simple edit", async () => {
    const { createState, decideThinkingPlan, updateState } = await import("../src/agent/router")
    const simple = createState()
    updateState(simple, ["edit_file"], ["src/a.ts"], false)
    const simpleDecision = decideThinkingPlan(simple, undefined, { prompt: "change one label", intentMode: "narrow_edit" })

    const structural = createState()
    updateState(structural, ["edit_file"], ["src/provider.ts"], false)
    const structuralDecision = decideThinkingPlan(structural, undefined, {
      prompt: "Refactor the runtime provider architecture and verification contract in this file.",
      intentMode: "narrow_edit",
    })

    expect(simpleDecision.thinking?.budget_tokens).toBe(8192)
    expect(structuralDecision.thinking?.budget_tokens).toBeGreaterThan(simpleDecision.thinking!.budget_tokens!)
    expect(structuralDecision.reason).toContain("结构")
  })
})
