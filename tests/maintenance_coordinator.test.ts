import { describe, expect, test } from "bun:test"
import {
  runForwardMicrocompact,
  runMaintenance,
  runKnowledgeDistillation,
  type MaintenanceContext,
} from "../src/agent/maintenance/coordinator"
import type { AgentRunState, RoundToolCall } from "../src/agent/run/types"
import type { LLMProvider } from "../src/provider/types"
import type { ToolResult } from "../src/tools/registry"

const provider: LLMProvider = {
  streamChat: async function* () { yield { type: "done" } },
} as unknown as LLMProvider

function buildCtx(overrides: Partial<MaintenanceContext> = {}): MaintenanceContext {
  const roundState = {
    toolResults: [],
    modifiedFiles: new Set<string>(),
    rateLimits: { shell: 0, file: 0, network: 0 },
    hadToolError: false,
    verificationPassed: false,
    serviceTestGuidanceNeeded: false,
    completionGateText: "",
    narrowEditEvidenceBlocked: false,
  }
  const base: MaintenanceContext = {
    round: 0,
    epochAction: "",
    provider,
    effectivePrompt: "test",
    routerRoundNum: 0,
    execution: { taskHadWrite: false, toolErrors: 0, modifiedFileCount: 0, consecutiveErrors: 0, requestedMaxThinking: false, runtimeSelfEditFiles: new Set<string>(), taskFiles: new Set<string>(), lastToolNames: [], rippleBlockActive: false } as unknown as AgentRunState["execution"],
    verificationState: { evidenceLedger: null as unknown as AgentRunState["verification"]["evidenceLedger"], rippleObligations: [], lastResults: [], lastRippleReports: [] } as unknown as AgentRunState["verification"],
    runState: null as unknown as AgentRunState,
    planning: { taskTracker: null } as unknown as AgentRunState["planning"],
    maintenance: { thinkingCompacted: false },
    budget: { microcompactCount: 0 } as unknown as AgentRunState["budget"],
    planStore: { current: null } as unknown as AgentRunState["planning"]["planStore"],
    taskFiles: new Set<string>(),
    rawMessages: [],
    resultsContent: [],
    completedToolCalls: [],
    learnPrompts: [],
    preRoundCtx: { contextBudgetPercent: 0, contextBudgetMode: "normal" },
    ...(overrides as object),
  }
  return base
}

async function drain(g: AsyncGenerator<any, any, unknown>): Promise<any[]> {
  const events: any[] = []
  for await (const e of g) events.push(e)
  return events
}

describe("runForwardMicrocompact", () => {
  test("compacts tool results when context budget is high", async () => {
    // shell has a 3000-char compact threshold; 4000-char content triggers it.
    const resultsContent: Array<Record<string, unknown>> = [
      { type: "tool_result", tool_use_id: "1", content: "x".repeat(4000) },
      { type: "tool_result", tool_use_id: "2", content: "y".repeat(10) },
    ]
    const completedToolCalls: RoundToolCall[] = [
      { id: "1", name: "shell", input: { command: "ls" } },
      { id: "2", name: "shell", input: { command: "echo hi" } },
    ]
    const ctx = buildCtx({
      preRoundCtx: { contextBudgetPercent: 40, contextBudgetMode: "normal" },
      resultsContent,
      completedToolCalls,
    })
    const events = await drain(runForwardMicrocompact(ctx))
    expect(events.some(e => e.type === "status" && String(e.data).startsWith("microcompact:"))).toBe(true)
    expect((ctx.budget as unknown as { microcompactCount: number }).microcompactCount).toBeGreaterThanOrEqual(1)
  })

  test("is a no-op at low budget", async () => {
    const ctx = buildCtx({ preRoundCtx: { contextBudgetPercent: 5, contextBudgetMode: "normal" } })
    const events = await drain(runForwardMicrocompact(ctx))
    expect(events).toHaveLength(0)
  })
})

describe("runKnowledgeDistillation", () => {
  test("no-ops without a knowledge base", () => {
    const ctx = buildCtx({ learnPrompts: ["some prompt"] })
    expect(() => runKnowledgeDistillation(ctx)).not.toThrow()
  })
})

describe("runMaintenance", () => {
  test("runs every maintenance op without throwing on a minimal context", async () => {
    const ctx = buildCtx()
    const events = await drain(runMaintenance(ctx))
    expect(Array.isArray(events)).toBe(true)
  })

  test("compacts forward pass and is safe end-to-end", async () => {
    const resultsContent: Array<Record<string, unknown>> = [
      { type: "tool_result", tool_use_id: "1", content: "z".repeat(50) },
    ]
    const completedToolCalls: RoundToolCall[] = [{ id: "1", name: "read_file", input: {} }]
    const ctx = buildCtx({
      preRoundCtx: { contextBudgetPercent: 45, contextBudgetMode: "normal" },
      resultsContent,
      completedToolCalls,
    })
    const events = await drain(runMaintenance(ctx))
    expect(Array.isArray(events)).toBe(true)
  })
})
