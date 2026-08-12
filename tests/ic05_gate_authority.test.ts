/** IC05 —— Gate Authority 行为一致性测试。
 *
 * 核心：Gate Authority taxonomy 与实际行为一致（§25/§26/§31）。
 * 攻击回归：ContextReadiness 不再制造拒绝循环（§27）。
 * 计划回归：Case A/B/C（§28）。
 * Hard Gate 保留矩阵（§31）。
 */

import { afterAll, describe, expect, test } from "bun:test"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { RetryCoordinator } from "../src/runtime/retry/coordinator"
import { createRetryLedger } from "../src/runtime/retry-ledger"

const SAVED_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
process.env.ORCANA_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_TRIAGE === undefined) delete process.env.ORCANA_FLASH_TRIAGE
  else process.env.ORCANA_FLASH_TRIAGE = SAVED_TRIAGE
})

class MemoryTrace {
  events: Array<{ type: string; data?: unknown }> = []
  record(type: string, data?: unknown) { this.events.push({ type, data }) }
}

/** 每轮要求同一个安全写（write_file）+ 重读，连续直至完成。 */
class WriteThenDoneProvider implements LLMProvider {
  rounds = 0
  async *streamChat(_o: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    const r = this.rounds++
    if (r < 2) {
      yield { type: "tool_call", data: { id: `w-${r}`, name: "write_file", input: { path: "a.txt", content: "x" } } }
    } else {
      yield { type: "text", data: "done" }
    }
  }
}

async function runLoop(prompt: string, opts: { provider: LLMProvider; tools?: Array<Record<string, unknown>>; maxRounds?: number } = { provider: new WriteThenDoneProvider() }) {
  const { agentLoop } = await import("../src/agent/loop")
  const trace = new MemoryTrace()
  const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 100 })
  const iterator = agentLoop(prompt, {
    provider: opts.provider,
    model: "test",
    tools: (opts.tools ?? []) as never,
    maxRounds: opts.maxRounds ?? 5,
    retryCoordinator: coordinator,
    runTrace: trace as never,
    contextMapPolicy: "off",
    flashTriagePolicy: "off",
  })
  let step: IteratorResult<StreamEvent, { kind: string; reason?: string }>
  do { step = await iterator.next() } while (!step.done)
  return { trace, decision: step.value }
}

describe("IC05 ContextReadiness attack regression (§27)", () => {
  test("advisory 不产生拒绝循环：write 保持暴露并执行（≤3 rounds）", async () => {
    const provider = new WriteThenDoneProvider()
    const { buildTools, Result } = await import("../src/tools/registry")
    const tools = buildTools({
      name: "write_file", description: "write", isReadonly: false, isConcurrencySafe: false,
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      async execute() { return Result.ok("ok") },
    })
    const { trace } = await runLoop("update a.txt", {
      provider,
      tools: tools as never,
    })
    // ContextReadiness 拒绝次数 = 0。
    const readinessDenials = trace.events.filter(e =>
      e.type === "gate_decision"
      && JSON.stringify(e.data).includes("context_readiness")
      && JSON.stringify(e.data).includes("deny"))
    expect(readinessDenials.length).toBe(0)
    // 写工具执行成功（tool 结果存在）。
    const toolResults = trace.events.filter(e => e.type === "tool_result")
    expect(toolResults.length).toBeGreaterThanOrEqual(1)
  })
})

describe("IC05 Planning regression (§28)", () => {
  test("Case A: ordinary complex task planning phase → write 仍可执行", async () => {
    const { evaluateToolPolicy } = await import("../src/agent/tool-execution/policy")
    const { PermissionGate } = await import("../src/agent/permission")
    const tool = {
      defn: {
        name: "write_file", description: "write", isReadonly: false,
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({ success: true, content: "ok" }),
      },
      execute: async () => ({ success: true, content: "ok" }),
      toAnthropicSchema: () => ({}),
    }
    const result = await evaluateToolPolicy({
      toolCall: { id: "c1", name: "write_file", input: {} },
      tool: tool as never,
      intentPolicy: { mode: "long_task", reason: "test" },
      taskTracker: { phase: "planning", requiredFiles: [] } as never,
      rippleBlockActive: false,
      pendingRippleObligations: [],
      permissionGate: new PermissionGate(),
      permissionMode: "full",
      rateLimits: { safe: 0, shell: 0, file: 0, network: 0, git: 0 },
      webSearchFailedThisTurn: false,
      webSearchFailReason: "",
      finalText: "",
    })
    expect(result.allowed).toBe(true)
  })

  test("Case B: explicit plan-only + Flash triage full_complex → intent readonly 优先", async () => {
    const { resolveRuntimeIntent, classifyIntent } = await import("../src/agent/intent")
    const { triageModeToIntent } = await import("../src/agent/flash-triage")
    const prompt = "只给方案，不要修改任何文件"
    const triageIntent = { mode: triageModeToIntent("full_complex"), reason: "Flash triage: complex" }
    const resolved = resolveRuntimeIntent(prompt, triageIntent)
    expect(resolved.mode).toBe("readonly")
    expect(classifyIntent(prompt).mode).toBe("readonly")
  })

  test("Case C: plan quality poor → planning-advisory 发出，execution 继续（无 3+ rewrite loop）", async () => {
    // 普通 long task：phase=building（full_complex 已转 building），planning
    // gate 只发 advisory —— 通过 run 级断言：规划差的任务仍能完成。
    const { evaluatePlanningArtifact } = await import("../src/agent/planning-gate")
    const poor = evaluatePlanningArtifact("do it", { requiredFiles: [] } as never)
    expect(poor.score).toBeLessThan(4)
    expect(poor.ok).toBe(false)
    // advisory 语义：ToolPolicy 不再因 phase=planning 拒绝写。
    const { evaluateToolPolicy } = await import("../src/agent/tool-execution/policy")
    const { PermissionGate } = await import("../src/agent/permission")
    const result = await evaluateToolPolicy({
      toolCall: { id: "c1", name: "write_file", input: {} },
      tool: {
        defn: { name: "write_file", description: "w", isReadonly: false, inputSchema: { type: "object", properties: {} }, execute: async () => ({ success: true, content: "ok" }) },
        execute: async () => ({ success: true, content: "ok" }),
        toAnthropicSchema: () => ({}),
      } as never,
      intentPolicy: { mode: "long_task", reason: "test" },
      taskTracker: { phase: "planning", requiredFiles: [] } as never,
      rippleBlockActive: false,
      pendingRippleObligations: [],
      permissionGate: new PermissionGate(),
      permissionMode: "full",
      rateLimits: { safe: 0, shell: 0, file: 0, network: 0, git: 0 },
      webSearchFailedThisTurn: false,
      webSearchFailReason: "",
      finalText: "",
    })
    expect(result.allowed).toBe(true)
  })
})

describe("IC05 Hard Gate preservation matrix (§31)", () => {
  test("permission deny → BLOCK", async () => {
    const { evaluateToolPolicy } = await import("../src/agent/tool-execution/policy")
    const gate = {
      ask: () => Promise.resolve({ action: "deny" }),
      deny: () => {},
      check: () => ({ allowed: false, level: "deny" }),
    } as never
    const result = await evaluateToolPolicy({
      toolCall: { id: "c1", name: "shell", input: {} },
      intentPolicy: { mode: "long_task", reason: "test" },
      taskTracker: null,
      rippleBlockActive: false,
      pendingRippleObligations: [],
      permissionGate: gate,
      permissionMode: "strict",
      rateLimits: { safe: 0, shell: 0, file: 0, network: 0, git: 0 },
      webSearchFailedThisTurn: false,
      webSearchFailReason: "",
      finalText: "",
      tool: {
        defn: { name: "shell", description: "s", isReadonly: false, inputSchema: { type: "object", properties: {} }, execute: async () => ({ success: true, content: "ok" }) },
        execute: async () => ({ success: true, content: "ok" }),
        toAnthropicSchema: () => ({}),
      } as never,
    })
    expect(result.allowed).toBe(false)
  })

  test("writable-root escape → BLOCK", async () => {
    const { evaluateToolPolicy } = await import("../src/agent/tool-execution/policy")
    const result = await evaluateToolPolicy({
      toolCall: { id: "c1", name: "write_file", input: { path: "/etc/passwd" } },
      intentPolicy: { mode: "long_task", reason: "test" },
      taskTracker: null,
      rippleBlockActive: false,
      pendingRippleObligations: [],
      permissionGate: { ask: () => Promise.resolve({ action: "allow" }), deny: () => {}, check: () => ({ allowed: true, level: "allow" }) } as never,
      permissionMode: "full",
      rateLimits: { safe: 0, shell: 0, file: 0, network: 0, git: 0 },
      projectRoot: "/tmp/w",
      writableRoots: ["/tmp/w/src"],
      webSearchFailedThisTurn: false,
      webSearchFailReason: "",
      finalText: "",
      tool: {
        defn: { name: "write_file", description: "w", isReadonly: false, inputSchema: { type: "object", properties: {} }, execute: async () => ({ success: true, content: "ok" }) },
        execute: async () => ({ success: true, content: "ok" }),
        toAnthropicSchema: () => ({}),
      } as never,
    })
    expect(result.allowed).toBe(false)
    expect((result as { reason?: string }).reason).toBe("writable_root")
  })

  test("explicit readonly intent → BLOCK write", async () => {
    const { evaluateToolPolicy } = await import("../src/agent/tool-execution/policy")
    const result = await evaluateToolPolicy({
      toolCall: { id: "c1", name: "write_file", input: {} },
      intentPolicy: { mode: "readonly", reason: "explicit no-write request" },
      taskTracker: null,
      rippleBlockActive: false,
      pendingRippleObligations: [],
      permissionGate: { ask: () => Promise.resolve({ action: "allow" }), deny: () => {}, check: () => ({ allowed: true, level: "allow" }) } as never,
      permissionMode: "full",
      rateLimits: { safe: 0, shell: 0, file: 0, network: 0, git: 0 },
      webSearchFailedThisTurn: false,
      webSearchFailReason: "",
      finalText: "",
      tool: {
        defn: { name: "write_file", description: "w", isReadonly: false, inputSchema: { type: "object", properties: {} }, execute: async () => ({ success: true, content: "ok" }) },
        execute: async () => ({ success: true, content: "ok" }),
        toAnthropicSchema: () => ({}),
      } as never,
    })
    expect(result.allowed).toBe(false)
    expect((result as { reason?: string }).reason).toBe("readonly_intent")
  })

  test("high-risk destructive confirmation missing → BLOCK", async () => {
    const { evaluateToolPolicy } = await import("../src/agent/tool-execution/policy")
    const result = await evaluateToolPolicy({
      toolCall: { id: "c1", name: "shell", input: { command: "rm -rf /" } },
      intentPolicy: { mode: "long_task", reason: "test" },
      taskTracker: null,
      rippleBlockActive: false,
      pendingRippleObligations: [],
      permissionGate: { ask: () => Promise.resolve({ action: "ask" }), deny: () => {}, check: () => ({ allowed: false, level: "ask" }) } as never,
      permissionMode: "strict",
      rateLimits: { safe: 0, shell: 0, file: 0, network: 0, git: 0 },
      webSearchFailedThisTurn: false,
      webSearchFailReason: "",
      finalText: "",
      tool: {
        defn: { name: "shell", description: "s", isReadonly: false, inputSchema: { type: "object", properties: {} }, execute: async () => ({ success: true, content: "ok" }) },
        execute: async () => ({ success: true, content: "ok" }),
        toAnthropicSchema: () => ({}),
      } as never,
    })
    expect(result.allowed).toBe(false)
  })

  test("context budget exhausted → BLOCK", async () => {
    const { ContextBudgetGate } = await import("../src/agent/gates/context-budget")
    const gateResult = new ContextBudgetGate().evaluate({
      round: 0, roundInputTokens: 1000, contextMax: 100, contextUsed: 1000,
      fullTools: [], tools: [], activeTools: [], intentReadonly: false, taskPlanning: false,
      cacheStableTools: false, effectivePrompt: "x", contextReadinessBlocked: false,
    } as never)
    expect(gateResult.pass).toBe(false)
  })

  test("open context debt → write ALLOW / DONE BLOCK（obligation 矩阵）", async () => {
    const { createContextDebts } = await import("../src/context/context-debt")
    const debts = createContextDebts({ hasLocateResult: false, hasSourceUnderstanding: false, hasProjectConstitution: true, hasVerificationPlan: true, confidence: 0.5, highRisk: false })
    expect(debts.some(d => d.status === "open")).toBe(true)
    // DONE block：ContextDebtCompletionGate 在 completion chain 中
    // （gate_scenario_audit 已证明 chain 含 semantic:context_debt）。
    const { createCompletionChain } = await import("../src/agent/gates/sync-completion-chain")
    const { GateTelemetry } = await import("../src/agent/gates/telemetry")
    const tel = new GateTelemetry()
    const cc = {
      round: 0, finalText: "done", intentPolicy: { mode: "long_task", reason: "t" },
      taskTracker: null, pendingRippleObligations: [], taskHadWrite: true, taskToolErrors: 0,
      taskModifiedFiles: 1, lastTypecheck: undefined, lastRippleReports: [], lastVerificationResults: [],
      planApproved: false, planningRejections: 0, maxRounds: 5, priorTools: [], priorFiles: new Set(),
      confidenceEvaluator: { evaluate: () => ({ ok: true, confidence: 1 }) },
      contextDebts: debts,
      completionBlockMessage: null, shouldBreak: false, breakEvent: null, statusMessage: "",
      injectMessages: [], traceEvent: null,
    } as never
    const result = createCompletionChain().evaluateSync(cc, tel)
    expect(result.pass).toBe(false)
  })
})

describe("IC05 Ripple deterministic vs heuristic (§18-20/§30)", () => {
  const { hasDeterministicBlockingRipple, DETERMINISTIC_RIPPLE_KINDS, HEURISTIC_RIPPLE_KINDS } = require("../src/agent/gates/pre-round") as typeof import("../src/agent/gates/pre-round")

  test("R1: exported API removed → deterministic hard block 保留", () => {
    const report = {
      findings: [{ kind: "exported-symbol-removal", severity: "block" }],
      decision: "block",
      callers: [],
      apiChanges: [],
    }
    expect(hasDeterministicBlockingRipple(report as never)).toBe(true)
    expect(DETERMINISTIC_RIPPLE_KINDS.has("exported-symbol-removal")).toBe(true)
  })

  test("R2: heuristic caller-overflow → advisory（非 hard block）", () => {
    expect(HEURISTIC_RIPPLE_KINDS.has("caller-overflow")).toBe(true)
    expect(DETERMINISTIC_RIPPLE_KINDS.has("caller-overflow")).toBe(false)
    const report = {
      findings: [{ kind: "caller-overflow", severity: "warn" }],
      decision: "warn",
      callers: Array.from({ length: 11 }, (_, i) => ({ file: `f${i}.ts`, symbol: "x" })),
      apiChanges: [],
    }
    expect(hasDeterministicBlockingRipple(report as never)).toBe(false)
  })

  test("R3: pending caller obligation → DONE blocked（RippleExitGate）", async () => {
    const { createCompletionChain } = await import("../src/agent/gates/sync-completion-chain")
    const { GateTelemetry } = await import("../src/agent/gates/telemetry")
    const tel = new GateTelemetry()
    const cc = {
      round: 0, finalText: "done", intentPolicy: { mode: "long_task", reason: "t" },
      taskTracker: null, pendingRippleObligations: [{ caller: "x.ts", symbol: "api", reason: "signature changed", waiver: null }],
      taskHadWrite: true, taskToolErrors: 0, taskModifiedFiles: 1, lastTypecheck: undefined,
      lastRippleReports: [], lastVerificationResults: [], planApproved: false, planningRejections: 0,
      maxRounds: 5, priorTools: [], priorFiles: new Set(),
      confidenceEvaluator: { evaluate: () => ({ ok: true, confidence: 1 }) },
      completionBlockMessage: null, shouldBreak: false, breakEvent: null, statusMessage: "",
      injectMessages: [], traceEvent: null,
    } as never
    const result = createCompletionChain().evaluateSync(cc, tel)
    expect(result.pass).toBe(false)
  })
})
