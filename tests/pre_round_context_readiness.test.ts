import { describe, expect, test } from "bun:test"
import { ContextReadinessToolFilterGate } from "../src/agent/gates/pre-round"
import type { PreRoundContext } from "../src/agent/gates/contexts"
import type { ToolDescriptor } from "../src/tools/registry"

function mockTool(name: string, isReadonly: boolean): ToolDescriptor {
  return {
    defn: {
      name,
      description: name,
      isReadonly,
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ success: true, content: "ok" }),
    },
    execute: async () => ({ success: true, content: "ok" }),
    toAnthropicSchema: () => ({ name }),
  }
}

function baseContext(tools: ToolDescriptor[], blocked: boolean): PreRoundContext {
  return {
    round: 0,
    roundInputTokens: 0,
    contextMax: 1_000_000,
    fullTools: tools,
    tools,
    rippleReports: [],
    pendingRippleObligations: [],
    intentReadonly: false,
    taskPlanning: false,
    contextReadinessBlocked: blocked,
    cacheStableTools: true,
    disclosureContextText: "",
    contextBudgetMode: "normal",
    contextBudgetPercent: 0,
    budgetMessage: null,
    announcedDegraded: false,
    rippleBlockActive: false,
    tokensSaved: 0,
    activeTools: tools,
  }
}

describe("ContextReadinessToolFilterGate", () => {
  test("filters write tools while marking the block active", () => {
    const read = mockTool("read_file", true)
    const write = mockTool("edit_file", false)
    const ctx = baseContext([read, write], true)

    new ContextReadinessToolFilterGate().evaluate(ctx)

    expect(ctx.contextReadinessBlockActive).toBe(true)
    expect(ctx.tools.map(tool => tool.defn.name)).toEqual(["read_file"])
    expect(ctx.activeTools.map(tool => tool.defn.name)).toEqual(["read_file"])
  })

  test("leaves tools untouched when readiness is satisfied", () => {
    const tools = [mockTool("read_file", true), mockTool("edit_file", false)]
    const ctx = baseContext(tools, false)

    new ContextReadinessToolFilterGate().evaluate(ctx)

    expect(ctx.contextReadinessBlockActive).toBe(false)
    expect(ctx.tools).toEqual(tools)
    expect(ctx.activeTools).toEqual(tools)
  })
})
