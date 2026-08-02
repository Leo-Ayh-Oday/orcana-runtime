import { describe, expect, test } from "bun:test"
import { normalizeToolResultContent } from "../src/agent/tool-execution/result-normalizer"
import { executeToolBatch, type ToolBatchContext } from "../src/agent/tool-execution/batch-executor"
import { executeSingleTool } from "../src/agent/tool-execution/single-executor"
import type { ToolDescriptor, ToolResult } from "../src/tools/registry"
import { ToolExecutionLedger } from "../src/agent/tool-ledger"
import { GateTelemetry } from "../src/agent/gates/telemetry"
import { ErrorTracker } from "../src/agent/round/pre-loop"
import { PermissionGate } from "../src/agent/permission"
import { createRoundState } from "../src/agent/run/state"
import type { AgentRunState, RoundToolCall } from "../src/agent/run/types"

function makeDescriptor(
  defn: Partial<ToolDescriptor["defn"]> & Pick<ToolDescriptor["defn"], "name" | "description" | "inputSchema" | "isReadonly">,
  execute?: ToolDescriptor["execute"],
): ToolDescriptor {
  const handler = execute ?? (async () => ({ success: true, content: `${defn.name}:ok` }))
  return {
    defn: { ...defn, execute: handler as ToolDescriptor["defn"]["execute"] },
    execute: handler,
    toAnthropicSchema: () => defn.inputSchema,
  }
}

function readonlyTool(name: string): ToolDescriptor {
  return makeDescriptor({
    name,
    description: name,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    isReadonly: true,
    isConcurrencySafe: true,
  })
}

function makeCall(id: string, name: string, input: Record<string, unknown> = {}): RoundToolCall {
  return { id, name, input }
}

function buildContext(overrides: Partial<ToolBatchContext> = {}): ToolBatchContext {
  const roundState = createRoundState(0)
  const planning = { taskTracker: null } as unknown as AgentRunState["planning"]
  const execution = {
    taskHadWrite: false,
    toolErrors: 0,
    modifiedFileCount: 0,
    consecutiveErrors: 0,
    requestedMaxThinking: false,
    runtimeSelfEditFiles: new Set<string>(),
    taskFiles: new Set<string>(),
    lastToolNames: [],
    rippleBlockActive: false,
  } as unknown as AgentRunState["execution"]
  const verificationState = {
    evidenceLedger: null as unknown as AgentRunState["verification"]["evidenceLedger"],
    rippleObligations: [],
    lastResults: [],
    lastRippleReports: [],
  } as unknown as AgentRunState["verification"]
  const notices = {
    announcedKernel: false,
    webSearchFailedThisTurn: false,
    webSearchFailReason: "",
    announcedContextDegraded: false,
    announcedEpochForceCompress: false,
  } as unknown as AgentRunState["notices"]

  const base: ToolBatchContext = {
    round: 0,
    completedToolCalls: [],
    tools: [],
    permissionGate: new PermissionGate(),
    permissionMode: "full",
    preRoundCtx: { taskPlanning: false },
    contextReadinessBlocked: false,
    finalText: "",
    roundState,
    planning,
    execution,
    verificationState,
    notices,
    intentPolicy: { mode: "auto", reason: "test" } as unknown as AgentRunState["planning"]["intentPolicy"],
    toolLedger: new ToolExecutionLedger(),
    gateTelemetry: new GateTelemetry(),
    errorTracker: new ErrorTracker(),
    resultsContent: [],
    prompt: "test",
    trustedVerification: () => undefined,
  }
  return { ...base, ...overrides }
}

async function drain(batch: AsyncGenerator<any, any, unknown>): Promise<any[]> {
  const events: any[] = []
  let result: any
  const iter = batch[Symbol.asyncIterator]()
  while (true) {
    const next = await iter.next()
    if (next.done) { result = next.value; break }
    events.push(next.value)
  }
  return [events, result] as any
}

describe("normalizeToolResultContent", () => {
  test("short content passes through unchanged", () => {
    expect(normalizeToolResultContent("hello world", true)).toBe("hello world")
  })

  test("long content is truncated head+tail", () => {
    // >1400 chars so truncation is engaged
    const content = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n")
    expect(content.length).toBeGreaterThan(1400)
    const out = normalizeToolResultContent(content, true)
    expect(out.length).toBeLessThan(content.length)
    expect(out).toMatch(/\[\d+ lines trimmed\]/)
    expect(out).toContain("line 0")
    expect(out).toContain("line 99")
  })

  test("error tail keeps error-aware marker", () => {
    const body = Array.from({ length: 100 }, () => "x".repeat(30)).join("\n")
    const content = `${body}\nerror TS1234: boom\n`
    expect(content.length).toBeGreaterThan(1400)
    const out = normalizeToolResultContent(content, true)
    expect(out).toContain("errors detected in tail")
  })

  test("failed result is not truncated", () => {
    const content = Array.from({ length: 100 }, () => "x".repeat(30)).join("\n")
    expect(normalizeToolResultContent(content, false)).toBe(content)
  })
})

describe("executeToolBatch", () => {
  test("runs readonly calls in parallel and records to ledger", async () => {
    const tools = [readonlyTool("a"), readonlyTool("b")]
    const ctx = buildContext({
      completedToolCalls: [makeCall("1", "a"), makeCall("2", "b")],
      tools,
    })
    const [events, result] = await drain(executeToolBatch(ctx))
    expect(result.aborted).toBe(false)
    expect(events.some((e: any) => e.type === "status" && String(e.data).includes("greedy-tools"))).toBe(true)
    expect(ctx.toolLedger.snapshot()).toHaveLength(2)
    expect(ctx.toolLedger.failedCount()).toBe(0)
    expect(ctx.resultsContent).toHaveLength(2)
  })

  test("permission-denied tool is not executed and recorded as failed", async () => {
    let writes = 0
    const denyGate = new PermissionGate()
    denyGate.deny("write_file")
    const tools: ToolDescriptor[] = [makeDescriptor({
      name: "write_file",
      description: "write",
      inputSchema: { type: "object", properties: {} },
      isReadonly: false,
    }, async () => { writes += 1; return { success: true, content: "ok" } })]
    const ctx = buildContext({
      completedToolCalls: [makeCall("1", "write_file", { path: "x.ts" })],
      tools,
      permissionGate: denyGate,
      permissionMode: "full",
    })
    const [events, result] = await drain(executeToolBatch(ctx))
    expect(result.aborted).toBe(false)
    expect(writes).toBe(0)
    expect(ctx.toolLedger.snapshot()).toHaveLength(1)
    expect(ctx.toolLedger.snapshot()[0]!.success).toBe(false)
    expect(ctx.resultsContent).toHaveLength(1)
  })

  test("hook-blocked tool is recorded as blocked in the ledger", async () => {
    const hooks = {
      runBefore: async () => ({ blocked: true, warnings: ["write frozen by rule capsule"] }),
      runAfter: async () => ({ blocked: false, warnings: [] }),
    } as any
    let writes = 0
    const tools: ToolDescriptor[] = [makeDescriptor({
      name: "edit_file",
      description: "edit",
      inputSchema: { type: "object", properties: {} },
      isReadonly: false,
    }, async () => { writes += 1; return { success: true, content: "ok" } })]
    const ctx = buildContext({
      completedToolCalls: [makeCall("1", "edit_file", { path: "x.ts" })],
      tools,
      hooks,
    })
    const [events, result] = await drain(executeToolBatch(ctx))
    expect(result.aborted).toBe(false)
    expect(writes).toBe(0)
    expect(ctx.toolLedger.blockedCount()).toBe(1)
  })

  test("abort mid-batch returns aborted sentinel", async () => {
    const controller = new AbortController()
    const tools = [readonlyTool("a"), readonlyTool("b")]
    const ctx = buildContext({
      completedToolCalls: [makeCall("1", "a"), makeCall("2", "b")],
      tools,
      abortSignal: controller.signal,
    })
    // Abort before draining so the first post-execute check fires.
    controller.abort()
    const [events, result] = await drain(executeToolBatch(ctx))
    expect(result.aborted).toBe(true)
  })

  test("aborted in-flight streaming tool is recorded as aborted in the ledger", async () => {
    const controller = new AbortController()
    // read_file is level-0 safe so it passes every policy gate and actually
    // executes; the streaming variant holds the iterator open until abort.
    const tools: ToolDescriptor[] = [{
      defn: {
        name: "read_file",
        description: "read",
        inputSchema: { type: "object", properties: {} },
        isReadonly: true,
        isConcurrencySafe: true,
      },
      executeStream: async function* () {
        // Never yields — holds the iterator open until the run aborts.
        await new Promise<void>(() => {})
      },
      execute: async () => ({ success: true, content: "unused" }),
      toAnthropicSchema: () => ({}),
    } as unknown as ToolDescriptor]
    const ctx = buildContext({
      completedToolCalls: [makeCall("1", "read_file")],
      tools,
      abortSignal: controller.signal,
    })
    const iter = executeToolBatch(ctx)[Symbol.asyncIterator]()
    const pending = iter.next() // starts executing the hanging stream
    await new Promise(resolve => setTimeout(resolve, 20)) // let it get in-flight
    controller.abort() // abort mid-stream
    const first = await pending
    expect(first.done).toBe(true)
    expect((first.value as { aborted: boolean }).aborted).toBe(true)
    // Drain any remaining events; the ledger must record the aborted tool.
    while (true) {
      const next = await iter.next()
      if (next.done) break
    }
    expect(ctx.toolLedger.snapshot()).toHaveLength(1)
    expect(ctx.toolLedger.snapshot()[0]!.aborted).toBe(true)
    expect(ctx.toolLedger.snapshot()[0]!.success).toBe(false)
  })
})

describe("executeSingleTool", () => {
  test("applies before/after hooks around execution", async () => {
    const calls: string[] = []
    const tool: ToolDescriptor = makeDescriptor({
      name: "probe",
      description: "probe",
      inputSchema: { type: "object", properties: {} },
      isReadonly: true,
    }, async () => { calls.push("execute"); return { success: true, content: "ok" } })
    const hooks = {
      runBefore: async () => { calls.push("before"); return { blocked: false, warnings: [], replaceParams: undefined } },
      runAfter: async () => { calls.push("after"); return { blocked: false, result: { success: true, content: "ok" } as ToolResult, warnings: [] } },
    } as any
    const out = await executeSingleTool({ tool, params: {}, hooks })
    expect(calls).toEqual(["before", "execute", "after"])
    expect(out.result.content).toBe("ok")
  })
})
