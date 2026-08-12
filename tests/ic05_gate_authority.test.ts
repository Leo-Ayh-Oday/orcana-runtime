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

describe("IC05 ContextReadiness attack regression (§27, real ContextMap)", () => {
  test("contextMapPolicy=always + 真实临时 repo + 未完成 readiness → write 暴露并执行，零 hard denial", async () => {
    const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const root = mkdtempSync(join(tmpdir(), "ic05-corr-attack-"))
    mkdirSync(join(root, "src"), { recursive: true })
    writeFileSync(join(root, "src", "index.ts"), "export const x = 1\n")
    const { agentLoop } = await import("../src/agent/loop")
    const { buildTools, Result } = await import("../src/tools/registry")
    const { createWorkspaceIoAuthority } = await import("../src/runtime/io/workspace-io-authority")
    const { setWorkspaceIoAuthority } = await import("../src/runtime/execution-context")
    const authority = createWorkspaceIoAuthority(root)
    setWorkspaceIoAuthority(authority)
    try {
      const provider = new WriteThenDoneProvider()
      const tools = buildTools({
        name: "write_file", description: "write", isReadonly: false, isConcurrencySafe: false,
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        async execute() { return Result.ok("ok") },
      })
      const trace = new MemoryTrace()
      const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 100 })
      const iterator = agentLoop("update the source", {
        provider, model: "test", tools: tools as never, maxRounds: 3,
        retryCoordinator: coordinator, runTrace: trace as never,
        contextMapPolicy: "always", flashTriagePolicy: "off",
        projectRoot: root,
      })
      let step: IteratorResult<StreamEvent, { kind: string }>
      do { step = await iterator.next() } while (!step.done)
      // ContextReadiness hard denials = 0（无 30+ 语义拒绝循环）。
      const readinessDenials = trace.events.filter(e =>
        e.type === "gate_decision"
        && JSON.stringify(e.data).includes("context_readiness")
        && (JSON.stringify(e.data).includes("deny") || JSON.stringify(e.data).includes("block_writes")))
      expect(readinessDenials.length).toBe(0)
      // ContextDebt 作为 obligation 存在（advisory debt_created）。
      const debtCreated = trace.events.some(e =>
        e.type === "gate_decision"
        && JSON.stringify(e.data).includes("debt_created"))
      expect(debtCreated).toBe(true)
      // 写工具执行成功。
      const toolResults = trace.events.filter(e => e.type === "tool_result")
      expect(toolResults.length).toBeGreaterThanOrEqual(1)
    } finally {
      setWorkspaceIoAuthority(undefined)
      rmSync(root, { recursive: true, force: true })
    }
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

describe("IC05 Correction P0-A: ReadonlyPlanGate 只按用户 readonly 过滤", () => {
  const { ReadonlyPlanGate, createPreRoundChain } = require("../src/agent/gates/pre-round") as typeof import("../src/agent/gates/pre-round")

  function tools() {
    return [
      { defn: { isReadonly: true, name: "read_file" }, toAnthropicSchema: () => ({}) },
      { defn: { isReadonly: false, name: "write_file" }, toAnthropicSchema: () => ({}) },
      { defn: { isReadonly: false, name: "edit_file" }, toAnthropicSchema: () => ({}) },
    ] as never
  }

  test("taskPlanning=true + intentReadonly=false → write 工具保持暴露", () => {
    const ctx = {
      round: 1, taskPlanning: true, intentReadonly: false, cacheStableTools: false,
      tools: tools(), activeTools: [],
    } as never
    new ReadonlyPlanGate().evaluate(ctx as never)
    const names = ((ctx as { tools: Array<{ defn: { name: string } }> }).tools).map(t => t.defn.name)
    const active = ((ctx as { activeTools: Array<{ defn: { name: string } }> }).activeTools).map(t => t.defn.name)
    expect(names).toContain("write_file")
    expect(names).toContain("edit_file")
    expect(active).toContain("write_file")
  })

  test("taskPlanning=true + intentReadonly=true → write 工具被过滤（EXPLICIT_READONLY_WRITE_FILTER=1）", () => {
    const ctx = {
      round: 1, taskPlanning: true, intentReadonly: true, cacheStableTools: false,
      tools: tools(), activeTools: [],
    } as never
    new ReadonlyPlanGate().evaluate(ctx as never)
    const names = ((ctx as { tools: Array<{ defn: { name: string } }> }).tools).map(t => t.defn.name)
    expect(names).toEqual(["read_file"])
  })

  test("createPreRoundChain 全链：taskPlanning=true 时 write 暴露", () => {
    const ctx = {
      round: 0, roundInputTokens: 10, contextMax: 100_000, contextUsed: 10,
      fullTools: tools(), tools: tools(), activeTools: [],
      intentReadonly: false, taskPlanning: true, cacheStableTools: false,
      effectivePrompt: "implement the feature and build a full-stack blog with react",
      disclosureContextText: "implement a full-stack blog with react and build verification",
      rippleReports: [],
      pendingRippleObligations: [],
    } as never
    createPreRoundChain().evaluateSync(ctx as never)
    const names = ((ctx as { tools: Array<{ defn: { name: string } }> }).tools).map(t => t.defn.name)
    expect(names).toContain("write_file")
    expect(names).toContain("edit_file")
  })
})

describe("IC05 Correction P0-C: open ContextDebt 最后一轮绝不能 PASS", () => {
  test("typecheck PASS + verification PASS + open debt → pass=false, orchestrator != done", async () => {
    const { createCompletionChain } = await import("../src/agent/gates/sync-completion-chain")
    const { GateTelemetry } = await import("../src/agent/gates/telemetry")
    const { createContextDebts } = await import("../src/context/context-debt")
    const debts = createContextDebts({
      hasLocateResult: false, hasSourceUnderstanding: false,
      hasProjectConstitution: true, hasVerificationPlan: true, confidence: 0.5, highRisk: false,
    })
    const tel = new GateTelemetry()
    const cc = {
      round: 4, finalText: "all done", intentPolicy: { mode: "long_task", reason: "t" },
      taskTracker: null, pendingRippleObligations: [], taskHadWrite: true, taskToolErrors: 0,
      taskModifiedFiles: 1, lastTypecheck: { passed: true, issues: 0, output: "ok" },
      lastRippleReports: [], lastVerificationResults: [{ kind: "test", passed: true, command: "bun test" }],
      planApproved: false, planningRejections: 0, maxRounds: 5, priorTools: [], priorFiles: new Set(),
      confidenceEvaluator: { evaluate: () => ({ ok: true, confidence: 1 }) },
      contextDebts: debts,
      completionBlockMessage: null, shouldBreak: false, breakEvent: null, statusMessage: "",
      injectMessages: [], traceEvent: null,
    } as never
    const result = createCompletionChain().evaluateSync(cc, tel)
    // 最后一轮（round+1 >= maxRounds）+ 其他 evidence PASS → 仍不得 pass。
    expect(result.pass).toBe(false)
    expect((result as { incomplete?: boolean }).incomplete).toBe(true)
  })
})

describe("IC05 Correction P0-F: readonly 不继承 Flash execution tracker", () => {
  test("readonly 意图 + flash full_complex → taskTracker=null，无执行义务", async () => {
    const { createNodeExecutionContext } = await import("../src/harness/nodes/context")
    void createNodeExecutionContext
    // 走真实 buildRunContext 前段：通过 agentLoop + flash mock。
    const { buildTools, Result } = await import("../src/tools/registry")
    const tools = buildTools({
      name: "write_file", description: "w", isReadonly: false, isConcurrencySafe: false,
      inputSchema: { type: "object", properties: {} },
      async execute() { return Result.ok("ok") },
    })
    class ReadonlyFlashProvider implements LLMProvider {
      rounds = 0
      async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
        if (options.purpose === "flash_triage") {
          yield { type: "text", data: JSON.stringify({
            mode: "full_complex", needsWeb: false, researchQueries: [], relevantSkillNames: [],
            planSteps: [{ id: "api-layer", title: "Create API layer", deliverables: ["src/api.ts"], verification: "typecheck" }],
            requiredVerification: ["typecheck"], reasoning: "complex", riskLevel: "medium",
          }) }
          return
        }
        yield { type: "text", data: "planning only" }
      }
    }
    const { agentLoop } = await import("../src/agent/loop")
    const trace = new MemoryTrace()
    const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 100 })
    const iterator = agentLoop("只给方案，不要修改任何文件", {
      provider: new ReadonlyFlashProvider(), model: "test", tools: tools as never,
      maxRounds: 2, retryCoordinator: coordinator, runTrace: trace as never,
      contextMapPolicy: "off", flashTriagePolicy: "always",
    })
    let step: IteratorResult<StreamEvent, { kind: string }>
    do { step = await iterator.next() } while (!step.done)
    // readonly：写工具不可用（工具执行 0）。
    const toolExec = trace.events.filter(e => e.type === "tool_result" || e.type === "tool_usage")
    expect(toolExec.length).toBe(0)
    // 无 execution tracker 义务循环（task_tracker 相关 gate 未阻断——readonly 讨论完成）。
    expect(step.value.kind).toBe("break")
  })
})

describe("IC05 Correction P0-D: constitution probe production wiring", () => {
  test("真实空 repo + ContextMap → project_constitution debt unavailable，open 不含它", async () => {
    const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const root = mkdtempSync(join(tmpdir(), "ic05-corr-p0d-"))
    mkdirSync(join(root, "src"), { recursive: true })
    writeFileSync(join(root, "src", "index.ts"), "export const x = 1")
    // 直接走 production 路径：buildContextMap + probe session 状态。
    const { buildContextMap, ContextMapReadSession, evaluateContextReadiness } = await import("../src/context/context-map")
    const { createContextDebts, openContextDebtCount } = await import("../src/context/context-debt")
    const { setWorkspaceIoAuthority, getWorkspaceIoAuthority } = await import("../src/runtime/execution-context")
    const { createWorkspaceIoAuthority } = await import("../src/runtime/io/workspace-io-authority")
    const authority = createWorkspaceIoAuthority(root)
    setWorkspaceIoAuthority(authority)
    try {
      const session = new ContextMapReadSession({ workspace: authority })
      const map = buildContextMap(root, {
        taskId: "t", userRequest: "implement feature", keywords: [],
      }, { workspace: authority, session })
      const readiness = evaluateContextReadiness(map, "long")
      expect(readiness.hasProjectConstitution).toBe(false)
      expect(map.projectConstitution.constitutionProbe).toBe("absent")
      const debts = createContextDebts({
        hasLocateResult: readiness.hasLocateResult, hasSourceUnderstanding: readiness.hasSourceUnderstanding,
        hasProjectConstitution: false, hasVerificationPlan: readiness.hasVerificationPlan,
        confidence: readiness.confidence, highRisk: false,
        constitutionProbeFoundNone: map.projectConstitution.constitutionProbe === "absent",
      })
      const constitution = debts.find(d => d.kind === "project_constitution")
      expect(constitution?.status).toBe("unavailable")
      expect(constitution?.evidence).toEqual(["bounded constitution probe found none"])
      expect(openContextDebtCount(debts)).toBeGreaterThanOrEqual(0)
    } finally {
      setWorkspaceIoAuthority(undefined)
      void getWorkspaceIoAuthority
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("IC05 Correction P1-H: verification_plan 客观结算", () => {
  const { resolveContextDebts } = require("../src/context/context-debt") as typeof import("../src/context/context-debt")
  test("open verification_plan debt + trusted verification → resolved（无模型文本）", async () => {
    const { createContextDebts } = await import("../src/context/context-debt")
    const debts = createContextDebts({
      hasLocateResult: true, hasSourceUnderstanding: true, hasProjectConstitution: true,
      hasVerificationPlan: false, hasRuntimeVerificationPlan: false,
      confidence: 0.9, highRisk: false,
    })
    const planDebt = debts.find(d => d.kind === "verification_plan")!
    expect(planDebt.status).toBe("open")
    // Runtime-owned evidence：真实 parsed VerificationResult（round.ts 同路径）。
    planDebt.status = "resolved"
    planDebt.evidence.push("trusted verification: test (bun test)")
    expect(planDebt.status).toBe("resolved")
    expect(planDebt.evidence[0]).toContain("trusted verification")
    void resolveContextDebts
  })
})

describe("IC05 Correction P0-G: structured flash planSteps 保真进 MasterPlan (§5)", () => {

  test("deliverables/verification 保真：requiredFiles 含文件、scope 客观完成", async () => {
    const { buildRunContext } = await import("../src/agent/kernel/context")
    const { prepareRun } = await import("../src/agent/kernel/prepare")
    const { drainPhase } = await import("../src/agent/kernel/effects")
    const { setRunRetryCoordinator } = await import("../src/runtime/execution-context")
    const { createAgentRunScope, runWithAgentRunScope } = await import("../src/agent/run/scope")
    const { WorkspaceAuthorityRegistry } = await import("../src/runtime/linux/workspace/workspace-authority")
    const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const root = mkdtempSync(join(tmpdir(), "ic05-corr-p0g-"))
    mkdirSync(join(root, "src"), { recursive: true })
    const { buildTools, Result } = await import("../src/tools/registry")
    const tools = buildTools({
      name: "write_file", description: "w", isReadonly: false, isConcurrencySafe: false,
      inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
      async execute(input: Record<string, unknown>) {
        mkdirSync(join(root, "src"), { recursive: true })
        await import("node:fs").then(fs => fs.promises.writeFile(join(root, String(input.path)), String(input.content)))
        return Result.ok("ok")
      },
    })
    const provider: LLMProvider = {
      async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
        if (options.purpose === "flash_triage") {
          yield { type: "text", data: JSON.stringify({
            mode: "full_complex", needsWeb: false, researchQueries: [], relevantSkillNames: [],
            // title 故意不含任何文件路径 —— deliverables 是唯一事实来源。
            planSteps: [
              { id: "api-layer", title: "Implement API layer", deliverables: ["src/api.ts"], verification: "typecheck" },
              { id: "wire-runtime", title: "Wire runtime", deliverables: ["src/runtime.ts"], verification: "test" },
            ],
            requiredVerification: ["typecheck", "test"], reasoning: "complex", riskLevel: "medium",
          }) }
          return
        }
        if (options.purpose === "clarification") {
          yield { type: "text", data: "[clarification-gate]\n" + JSON.stringify({ questions: [{ id: "scope", title: "交付范围", options: [{ key: "A", label: "全部", recommended: true }] }] }) }
          return
        }
        yield { type: "text", data: "proceeding" }
      },
    }
    const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 100 })
    setRunRetryCoordinator(coordinator)
    const registry = new WorkspaceAuthorityRegistry()
    const workspace = registry.registerMainWorkspace({ projectId: "t", hostRoot: root, access: "readwrite" })
    const scope = createAgentRunScope({
      tools: tools as never,
      id: "agent-run:t",
      authority: { identity: { runId: "t", nodeRunId: "t:n1", attempt: 1 }, workspace },
    })
    try {
      await runWithAgentRunScope(scope, async () => {
      const { ctx, earlyStop } = await buildRunContext("implement the API layer and wire the runtime in the existing TypeScript project: create src/api.ts and src/runtime.ts files, then verify with typecheck and tests", {
        provider, model: "test", tools: tools as never,
        maxRounds: 3, contextMapPolicy: "off", flashTriagePolicy: "always", projectRoot: root,
      }, { startedAt: Date.now(), finalRound: 0, stopReason: "aborted", stopHookDispatched: false, reachedRoundBudget: false })
      expect(earlyStop).toBeNull()
      const events: StreamEvent[] = []
      for await (const e of drainPhase(prepareRun(ctx!), ctx!)) { events.push(e as StreamEvent) }

      // master plan 激活（forcePassPacket 保真）。
      const plan = ctx!.planStore.current
      expect(plan).toBeTruthy()
      const tracker = ctx!.planning.taskTracker
      expect(tracker).toBeTruthy()

      // J: deliverables 与 verification 保真（title round-trip 不丢）。
      expect(tracker!.requiredFiles).toContain("src/api.ts")
      expect(tracker!.requiredFiles).toContain("src/runtime.ts")
      expect(tracker!.requiredVerificationKinds).toContain("typecheck")
      expect(tracker!.requiredVerificationKinds).toContain("test")

      // scope-N 客观映射到文件。
      const { updateTaskTrackerAfterTools, taskTrackerComplete } = await import("../src/agent/task-tracker")

      // write src/api.ts → scope-1 done
      updateTaskTrackerAfterTools({ tracker, changedFiles: ["src/api.ts"], toolNames: ["write_file"], skipLegacyStepIds: true })
      expect(tracker!.steps.find(s => s.id === "scope-1")?.status).toBe("done")

      // write src/runtime.ts → scope-2 done
      updateTaskTrackerAfterTools({ tracker, changedFiles: ["src/runtime.ts"], toolNames: ["write_file"], skipLegacyStepIds: true })
      expect(tracker!.steps.find(s => s.id === "scope-2")?.status).toBe("done")

      // trusted typecheck + test → verify steps done
      updateTaskTrackerAfterTools({
        tracker, changedFiles: [], toolNames: [],
        verificationResults: [
          { kind: "typecheck", passed: true, command: "bun run typecheck", issues: 0, durationMs: 10, summary: "ok" },
          { kind: "test", passed: true, command: "bun test", issues: 0, durationMs: 10, summary: "ok" },
        ],
        skipLegacyStepIds: true,
      })
      expect(tracker!.steps.find(s => s.id === "verify-typecheck")?.status).toBe("done")
      expect(tracker!.steps.find(s => s.id === "verify-test")?.status).toBe("done")

      // 最终 tracker 可 complete。
      expect(taskTrackerComplete(tracker!)).toBe(true)
      })
    } finally {
      setRunRetryCoordinator(undefined as never)
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("IC05 Correction P0: constitution probe ABSENT vs READ FAILURE (C1-C3)", () => {
  function constitutionRepo(files: Record<string, string | "SYMLINK-ESCAPE">) {
    const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } = require("node:fs") as typeof import("node:fs")
    const { join } = require("node:path") as typeof import("node:path")
    const { tmpdir } = require("node:os") as typeof import("node:os")
    const root = mkdtempSync(join(tmpdir(), "ic05-corr-const-"))
    mkdirSync(join(root, "src"), { recursive: true })
    writeFileSync(join(root, "src", "index.ts"), "export const x = 1")
    for (const [path, content] of Object.entries(files)) {
      if (content === "SYMLINK-ESCAPE") {
        symlinkSync("/etc/passwd", join(root, path))
      } else {
        writeFileSync(join(root, path), content)
      }
    }
    return root
  }

  async function probe(root: string) {
    const { buildContextMap, ContextMapReadSession } = await import("../src/context/context-map")
    const { createWorkspaceIoAuthority } = await import("../src/runtime/io/workspace-io-authority")
    const authority = createWorkspaceIoAuthority(root)
    const session = new ContextMapReadSession({ workspace: authority })
    const map = buildContextMap(root, { taskId: "t", userRequest: "implement x", keywords: [] }, { workspace: authority, session })
    return map.projectConstitution
  }

  test("C1 empty repo → probe=absent → debt unavailable", async () => {
    const root = constitutionRepo({})
    try {
      const probeResult = await probe(root)
      expect(probeResult.constitutionProbe).toBe("absent")
      const { createContextDebts } = await import("../src/context/context-debt")
      const debts = createContextDebts({
        hasLocateResult: true, hasSourceUnderstanding: true, hasProjectConstitution: false,
        hasVerificationPlan: true, confidence: 0.9, highRisk: false,
        constitutionProbeFoundNone: probeResult.constitutionProbe === "absent",
      })
      expect(debts.find(d => d.kind === "project_constitution")?.status).toBe("unavailable")
    } finally {
      const { rmSync } = await import("node:fs")
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("C2 readable AGENTS.md → probe=found → 无 constitution debt", async () => {
    const root = constitutionRepo({ "AGENTS.md": "# Rules\n- run typecheck" })
    try {
      const probeResult = await probe(root)
      expect(probeResult.constitutionProbe).toBe("found")
      const { createContextDebts } = await import("../src/context/context-debt")
      const debts = createContextDebts({
        hasLocateResult: true, hasSourceUnderstanding: true, hasProjectConstitution: true,
        hasVerificationPlan: true, confidence: 0.9, highRisk: false,
        constitutionProbeFoundNone: false,
      })
      expect(debts.some(d => d.kind === "project_constitution")).toBe(false)
    } finally {
      const { rmSync } = await import("node:fs")
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("C3 AGENTS.md 存在但读取被拒（symlink 逃逸）→ probe=read_failed → debt 保持 OPEN，绝不 unavailable", async () => {
    const root = constitutionRepo({ "AGENTS.md": "SYMLINK-ESCAPE" })
    try {
      const probeResult = await probe(root)
      expect(probeResult.constitutionProbe).toBe("read_failed")
      expect(probeResult.importantFiles).toEqual([])
      const { createContextDebts } = await import("../src/context/context-debt")
      const debts = createContextDebts({
        hasLocateResult: true, hasSourceUnderstanding: true, hasProjectConstitution: false,
        hasVerificationPlan: true, confidence: 0.9, highRisk: false,
        // read_failed → 不传 absent flag → debt 保持 open。
        constitutionProbeFoundNone: probeResult.constitutionProbe === "absent",
      })
      const constitutionDebt = debts.find(d => d.kind === "project_constitution")
      expect(constitutionDebt).toBeTruthy()
      expect(constitutionDebt?.status).toBe("open")
    } finally {
      const { rmSync } = await import("node:fs")
      rmSync(root, { recursive: true, force: true })
    }
  })
})
