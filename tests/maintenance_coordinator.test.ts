import { describe, expect, test } from "bun:test"
import {
  runAdaptiveCheckpoint,
  runForwardMicrocompact,
  runMaintenance,
  runKnowledgeDistillation,
  runThinkingCompaction,
  type MaintenanceContext,
} from "../src/agent/maintenance/coordinator"
import type { AgentRunState, RoundToolCall } from "../src/agent/run/types"
import type { ThinkingStore } from "../src/memory/thinking-store"
import type { LLMProvider } from "../src/provider/types"
import type { ToolResult } from "../src/tools/registry"
import { registerCheckpointStore, unregisterCheckpointStore, resetCheckpointScheduler } from "../src/session/checkpoint"

const provider: LLMProvider = {
  streamChat: async function* () { yield { type: "done" } },
} as unknown as LLMProvider

/** K8/K36 测试用 provider——产出 compactThinkingChain 可解析的 JSON。 */
const jsonProvider: LLMProvider = {
  streamChat: async function* () {
    yield { type: "text", data: `{"key_insights":["关键洞察A"],"discarded":[],"verified":["已验证结论B"],"open":[]}` }
  },
} as unknown as LLMProvider

function thinkingAssistantMsg(thinking: string): { role: "assistant"; content: Array<Record<string, unknown>> } {
  return { role: "assistant", content: [{ type: "thinking", thinking }] }
}

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

describe("runThinkingCompaction (K8 evidence binding)", () => {
  function compactionCtx(overrides: Partial<MaintenanceContext> = {}) {
    return buildCtx({
      round: 5,
      epochAction: "forceCompress",
      provider: jsonProvider,
      preRoundCtx: { contextBudgetPercent: 10, contextBudgetMode: "normal" },
      rawMessages: [
        thinkingAssistantMsg("first thinking"),
        thinkingAssistantMsg("second thinking"),
      ],
      maintenance: { thinkingCompacted: false },
      ...overrides,
    })
  }

  test("without evidence state: compaction succeeds, storeCompressed carries no evidence, summary omits Evidence line", async () => {
    let captured: any = null
    const store = {
      mergeCompressedInsights: (existing: string) => ({ merged: `${existing}\n\n- [✓] 已验证结论B <!-- 0 -->`, changed: true, needsFullRewrite: false }),
      storeCompressed: (input: any) => { captured = input },
    } as unknown as ThinkingStore
    const ctx = compactionCtx({ thinkingStore: store })
    const events = await drain(runThinkingCompaction(ctx))
    // storeCompressed 被调用并带完整 output
    expect(captured).not.toBeNull()
    expect(captured.compactOutput.verified).toEqual(["已验证结论B"])
    expect(captured.evidence).toBeUndefined()
    expect(captured.compactOutput.evidence).toBeUndefined()
    // volatile 摘要不带 Evidence 行，行为不退化
    const lastMsg = ctx.rawMessages[ctx.rawMessages.length - 1]!
    expect(lastMsg.role).toBe("user")
    const content = typeof lastMsg.content === "string" ? lastMsg.content : JSON.stringify(lastMsg.content)
    expect(content).toContain("✓ [verified] 已验证结论B")
    expect(content).not.toContain("Evidence:")
    // one-shot 守卫
    expect(ctx.maintenance.thinkingCompacted).toBe(true)
    expect(events.some(e => e.type === "status" && String(e.data).includes("insights"))).toBe(true)
  })

  test("with evidence ledger: verified insights carry the evidence anchor into cold memory summary + storeCompressed", async () => {
    let captured: any = null
    const store = {
      mergeCompressedInsights: (existing: string, output: any) => {
        const evLine = output.evidence ? `Evidence: ${output.evidence}` : ""
        return { merged: `${existing}\n\n${evLine}\n- [✓] 已验证结论B <!-- 0 -->`.trim(), changed: true, needsFullRewrite: false }
      },
      storeCompressed: (input: any) => { captured = input },
    } as unknown as ThinkingStore
    const ctx = compactionCtx({
      thinkingStore: store,
      verificationState: {
        evidenceLedger: {
          entries: [{ id: "evi_1", kind: "typecheck" as const, output: "ok", passed: true, timestamp: Date.now() }],
        },
      } as unknown as AgentRunState["verification"],
    })
    const events = await drain(runThinkingCompaction(ctx))
    // storeCompressed 携带 evidence 锚
    expect(captured.evidence).toBe("ledger=1")
    expect(captured.compactOutput.evidence).toBe("ledger=1")
    // volatile 摘要带 Evidence 行
    const lastMsg = ctx.rawMessages[ctx.rawMessages.length - 1]!
    const content = typeof lastMsg.content === "string" ? lastMsg.content : JSON.stringify(lastMsg.content)
    expect(content).toContain("Evidence: ledger=1")
    // status 事件不退化
    expect(events.some(e => e.type === "status" && String(e.data).includes("insights"))).toBe(true)
  })
})

describe("runThinkingCompaction (K36 stable prefix source write-through)", () => {
  test("changed branch updates stableMemoryContext, fires write-through, and emits observable status", async () => {
    const merged = "cold\n\n- [✓] 已验证结论B <!-- 0 -->"
    const store = {
      mergeCompressedInsights: () => ({ merged, changed: true, needsFullRewrite: false }),
      storeCompressed: () => ({} as unknown as ThinkingStore),
    } as unknown as ThinkingStore
    let written: string | undefined
    const traces: any[] = []
    const ctx = buildCtx({
      round: 5,
      epochAction: "forceCompress",
      provider: jsonProvider,
      thinkingStore: store,
      preRoundCtx: { contextBudgetPercent: 10, contextBudgetMode: "normal" },
      rawMessages: [thinkingAssistantMsg("t1"), thinkingAssistantMsg("t2")],
      maintenance: { thinkingCompacted: false },
      stableMemoryWriteThrough: (m) => { written = m },
      runTrace: { record: (type: string, data: unknown) => { traces.push({ type, data }) } } as unknown as MaintenanceContext["runTrace"],
    })
    const events = await drain(runThinkingCompaction(ctx))
    expect(ctx.stableMemoryContext).toBe(merged)
    expect(written).toBe(merged)
    // 可观测：status 提示下一轮重建 prefix
    expect(events.some(e => e.type === "status" && String(e.data).includes("stable-prefix source updated"))).toBe(true)
    // 可观测：trace 记录
    const tc = traces.find(t => t.type === "thinking_compaction")
    expect(tc).toBeTruthy()
    expect(tc.data.stablePrefixSourceUpdated).toBe(true)
  })
})

describe("runAdaptiveCheckpoint (D3 real session id)", () => {
  test("checkpoint uses runState.identity.sessionId, not a hardcoded empty id", async () => {
    resetCheckpointScheduler()
    let captured: any = null
    const fakeStore = {
      saveCheckpoint: (rec: any) => { captured = rec },
      loadCheckpoint: () => null,
      close: () => {},
    } as any
    registerCheckpointStore("sess-abc", fakeStore)
    try {
      const ctx = buildCtx({
        round: 21,
        preRoundCtx: { contextBudgetPercent: 60, contextBudgetMode: "normal" },
        runState: {
          identity: { runId: "r1", sessionId: "sess-abc", prompt: "p", effectivePrompt: "e", language: "en" },
          conversation: { rawMessages: [], frozenStablePrefix: null, stablePrefixHash: "h" },
        } as unknown as AgentRunState,
      })
      await drain(runAdaptiveCheckpoint(ctx))
      expect(captured).not.toBeNull()
      expect(captured.sessionId).toBe("sess-abc")
      expect(captured.summary).toContain("Resume from round 21")
    } finally {
      unregisterCheckpointStore("sess-abc")
      resetCheckpointScheduler()
    }
  })
})
