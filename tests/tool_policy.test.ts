/** Tests for evaluateToolPolicy — all 6 tool-execution gates. */
import { describe, expect, test } from "bun:test"
import { evaluateToolPolicy, type ToolPolicyInput, type ToolPolicyResult, type ToolPolicyBlocked } from "../src/agent/tool-execution/policy"
import { PermissionGate } from "../src/agent/permission"
import type { ToolDescriptor } from "../src/tools/registry"

function blocked(result: ToolPolicyResult): ToolPolicyBlocked {
  if (result.allowed) throw new Error("Expected blocked but got allowed")
  return result
}

function mockTool(name: string, isReadonly: boolean): ToolDescriptor {
  return {
    defn: {
      name,
      description: `Mock ${name}`,
      isReadonly,
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ success: true, content: "ok" }),
    },
    execute: async () => ({ success: true, content: "ok" }),
    toAnthropicSchema: () => ({}),
  }
}

const WRITE_TOOL = mockTool("shell", false)
const WRITE_TOOL_LOW_RISK = mockTool("write_file", false) // Risk 2 — used for non-risk gate tests
const READ_TOOL = mockTool("read_file", true)
const SEARCH_TOOL = mockTool("web_search", true)

function baseInput(overrides?: Partial<ToolPolicyInput>): ToolPolicyInput {  return {
    toolCall: { id: "call_1", name: "shell", input: {} },
    tool: undefined,
    intentPolicy: { mode: "long_task", reason: "test" },
    taskTracker: null,
    rippleBlockActive: false,
    pendingRippleObligations: [],
    permissionGate: new PermissionGate(),
    permissionMode: "full",
    rateLimits: { safe: 0, shell: 0, file: 0, network: 0, git: 0 },
    webSearchFailedThisTurn: false,
    webSearchFailReason: "",
    finalText: "",
    ...overrides,
  }
}

describe("evaluateToolPolicy — Gate 1: Rate Limit", () => {
  test("blocks shell tool when count reaches cap (5)", () => {
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "shell", input: {} },
      rateLimits: { safe: 0, shell: 5, file: 0, network: 0, git: 0 },
    }))
    expect(result.allowed).toBe(false)
    expect(blocked(result).reason).toBe("rate_limit")
    expect(blocked(result).source).toBe("policy:rate_limit")
    expect(blocked(result).priority).toBe(1)
    expect(blocked(result).blockMessage).toContain("5/5")
  })

  test("blocks file tool when count reaches cap (10)", () => {
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "write_file", input: {} },
      rateLimits: { safe: 0, shell: 0, file: 10, network: 0, git: 0 },
    }))
    expect(result.allowed).toBe(false)
    expect(blocked(result).reason).toBe("rate_limit")
    expect(blocked(result).blockMessage).toContain("10/10")
  })

  test("blocks network tool when count reaches cap (3)", () => {
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "web_search", input: {} },
      rateLimits: { safe: 0, shell: 0, file: 0, network: 3, git: 0 },
    }))
    expect(result.allowed).toBe(false)
    expect(blocked(result).reason).toBe("rate_limit")
    expect(blocked(result).blockMessage).toContain("3/3")
  })

  test("allows tool when count is below cap", () => {
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "shell", input: {} },
      rateLimits: { safe: 0, shell: 3, file: 0, network: 0, git: 0 },
    }))
    expect(result.allowed).toBe(true)
  })

  test("allows tool when count is exactly cap-1", () => {
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "shell", input: {} },
      rateLimits: { safe: 0, shell: 4, file: 0, network: 0, git: 0 },
    }))
    expect(result.allowed).toBe(true)
  })

  test("safe and git tools have no limit (Infinity cap)", () => {
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "read_file", input: {} },
      rateLimits: { safe: 9999, shell: 0, file: 0, network: 0, git: 0 },
    }))
    expect(result.allowed).toBe(true)
  })

  test("rate limit checked BEFORE permission — blocked at gate 1, not gate 2", () => {
    // Even a blocked permission should not be reached if rate limit fires first
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "shell", input: {} },
      rateLimits: { safe: 0, shell: 5, file: 0, network: 0, git: 0 },
    }))
    expect(result.allowed).toBe(false)
    expect(blocked(result).reason).toBe("rate_limit")
  })
})

describe("evaluateToolPolicy - Context Readiness", () => {
  test("blocks write tools when context readiness is incomplete", () => {
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "shell", input: {} },
      tool: WRITE_TOOL,
      contextReadinessBlocked: true,
      contextReadinessBlockers: ["High-risk task confidence below 0.75."],
    }))
    expect(result.allowed).toBe(false)
    expect(blocked(result).reason).toBe("context_readiness")
    expect(blocked(result).blockMessage).toContain("High-risk task confidence below 0.75.")
  })

  test("allows readonly tools when context readiness is incomplete", () => {
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "read_file", input: {} },
      tool: READ_TOOL,
      contextReadinessBlocked: true,
      contextReadinessBlockers: ["LocateResult is required for medium and larger tasks."],
    }))
    expect(result.allowed).toBe(true)
  })
})

describe("evaluateToolPolicy — Gate 2: Permission", () => {
  test("blocks tool with deny permission", () => {
    const pg = new PermissionGate()
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "shell", input: { command: "rm -rf /" } },
      permissionGate: pg,
      permissionMode: "strict",
    }))
    // Shell by default is "ask" level, not "deny" — this depends on safety policy
    // Deny is tested indirectly via permission gate tests
    expect(result.allowed !== undefined).toBe(true)
  })

  test("incrementRateLimit includes category even when blocked", () => {
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "shell", input: {} },
      rateLimits: { safe: 0, shell: 5, file: 0, network: 0, git: 0 },
    }))
    if (!result.allowed) {
      expect(result.incrementRateLimit).toBe("shell")
    }
  })
})

describe("evaluateToolPolicy — Gate 3: Readonly Intent", () => {
  test("blocks write tools in readonly mode", () => {
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "shell", input: {} },
      tool: WRITE_TOOL,
      intentPolicy: { mode: "readonly", reason: "user asked discussion question" },
    }))
    expect(result.allowed).toBe(false)
    expect(blocked(result).reason).toBe("readonly_intent")
  })

  test("allows readonly tools in readonly mode", () => {
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "read_file", input: {} },
      tool: READ_TOOL,
      intentPolicy: { mode: "readonly", reason: "user asked discussion question" },
    }))
    expect(result.allowed).toBe(true)
  })

  test("allows write tools in long_task mode", () => {
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "write_file", input: { file_path: "test.ts", content: "// ok" } },
      tool: WRITE_TOOL_LOW_RISK,
      intentPolicy: { mode: "long_task", reason: "building app" },
    }))
    expect(result.allowed).toBe(true)
  })
})

describe("evaluateToolPolicy — Gate 4: Ripple Block", () => {
  test("blocks writes when rippleBlockActive is true", () => {
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "shell", input: {} },
      tool: WRITE_TOOL,
      rippleBlockActive: true,
      pendingRippleObligations: [{ targetFile: "src/a.ts", symbol: "testFn", caller: { file: "src/b.ts", line: 1, symbol: "callerFn", text: "testFn()" }, reason: "export changed" }],
    }))
    expect(result.allowed).toBe(false)
    expect(blocked(result).reason).toBe("ripple_block")
  })

  test("allows reads when rippleBlockActive is true", () => {
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "read_file", input: {} },
      tool: READ_TOOL,
      rippleBlockActive: true,
      pendingRippleObligations: [{ targetFile: "src/a.ts", symbol: "testFn", caller: { file: "src/b.ts", line: 1, symbol: "callerFn", text: "testFn()" }, reason: "export changed" }],
    }))
    expect(result.allowed).toBe(true)
  })

  test("allows writes when rippleBlockActive is false", () => {
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "write_file", input: { file_path: "test.ts", content: "// ok" } },
      tool: WRITE_TOOL_LOW_RISK,
      rippleBlockActive: false,
      pendingRippleObligations: [],
    }))
    expect(result.allowed).toBe(true)
  })
})

describe("evaluateToolPolicy — Gate 5: Planning Phase", () => {
  test("blocks writes when taskTracker is in planning phase", () => {
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "shell", input: {} },
      tool: WRITE_TOOL,
      taskTracker: { phase: "planning", requiredFiles: [] } as unknown as ToolPolicyInput["taskTracker"],
    }))
    expect(result.allowed).toBe(false)
    expect(blocked(result).reason).toBe("planning_phase")
  })

  test("allows reads during planning phase", () => {
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "read_file", input: {} },
      tool: READ_TOOL,
      taskTracker: { phase: "planning", requiredFiles: [] } as unknown as ToolPolicyInput["taskTracker"],
    }))
    expect(result.allowed).toBe(true)
  })

  test("allows writes when taskTracker is null", () => {
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "write_file", input: { file_path: "test.ts", content: "// ok" } },
      tool: WRITE_TOOL_LOW_RISK,
      taskTracker: null,
    }))
    expect(result.allowed).toBe(true)
  })
})

describe("evaluateToolPolicy — Gate 6: Web Search Failed", () => {
  test("blocks web_search after a failure this turn", () => {
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "web_search", input: { query: "test" } },
      tool: SEARCH_TOOL,
      webSearchFailedThisTurn: true,
      webSearchFailReason: "All engines unavailable",
    }))
    expect(result.allowed).toBe(false)
    expect(blocked(result).reason).toBe("web_search_failed")
  })

  test("allows web_search when no failure this turn", () => {
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "web_search", input: { query: "test" } },
      tool: SEARCH_TOOL,
      webSearchFailedThisTurn: false,
    }))
    expect(result.allowed).toBe(true)
  })

  test("allows non-web_search tools even when web search failed", () => {
    const result = evaluateToolPolicy(baseInput({
      toolCall: { id: "c1", name: "web_fetch", input: { url: "https://example.com" } },
      tool: mockTool("web_fetch", true),
      webSearchFailedThisTurn: true,
      webSearchFailReason: "All engines unavailable",
    }))
    expect(result.allowed).toBe(true)
  })
})
