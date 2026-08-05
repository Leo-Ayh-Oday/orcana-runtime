/** MACP-M2 acceptance: Workflow-Harness 正式适配 (H11_ADAPTER).
 *
 *  Every real model/tool/verification/human node executes through the H11
 *  Unified Node Runtime; the handler registry stays a read-only reducer
 *  surface. Gates: H11_ADAPTER / KERNEL_DIFF / DIRECT_LLM_BYPASS /
 *  DIRECT_TOOL_BYPASS.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../../src/provider/types"
import { buildTools, Result } from "../../src/tools/registry"
import { runScheduler } from "../../src/workflow/scheduler/scheduler"
import type { WorkflowSpec, WorkflowNodeSpec } from "../../src/workflow/types"
import type { HandlerRegistry } from "../../src/workflow/execution/handler-registry"
import { HandlerRegistry as RegistryImpl } from "../../src/workflow/execution/handler-registry"
import type { WorkflowHarnessEnvironment } from "../../src/workflow/harness/environment"
import { assembleRunScope } from "../../src/harness/runtime/run-scope"
import { mergeRunBudget } from "../../src/harness/runtime/budget-ledger"
import { createCapabilityRegistry } from "../../src/harness/capabilities/registry"
import { registerToolCapabilities } from "../../src/harness/capabilities/tool-adapter"
import { createCapabilityDescriptor } from "../../src/harness/capabilities/descriptor"
import { writeFileSync } from "node:fs"
import type { VerificationResult } from "../../src/verification/result"

class ProbeThenTextProvider implements LLMProvider {
  rounds = 0
  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "token_usage", data: { inputTokens: 100, outputTokens: 20, cacheSource: "provider", round: 0 } }
      yield { type: "tool_call", data: { id: "probe-1", name: "baseline_probe", input: {} } }
      return
    }
    yield { type: "token_usage", data: { inputTokens: 50, outputTokens: 10, cacheSource: "provider", round: 1 } }
    yield { type: "text", data: "final answer" }
  }
}

function probeTool() {
  return buildTools({
    name: "baseline_probe",
    description: "probe",
    isReadonly: true,
    isConcurrencySafe: true,
    inputSchema: { type: "object", properties: {}, required: [] },
    execute() {
      return Result.ok("ok")
    },
  })
}

const probeTools = probeTool()
const probe = probeTools.find(t => t.defn.name === "baseline_probe")!

interface EnvBundle {
  env: WorkflowHarnessEnvironment
  controller: AbortController
  projectRoot: string
  responses: Array<{ interruptId: string; prompt: string }>
}

function buildEnv(overrides: Partial<WorkflowHarnessEnvironment> = {}, budgetOverrides?: Record<string, number>): EnvBundle {
  const projectRoot = mkdtempSync(join(tmpdir(), "m2-harness-"))
  const controller = new AbortController()
  const scope = assembleRunScope({ runId: "m2-run", sessionId: "m2", projectRoot, controller })
  const capabilities = createCapabilityRegistry()
  capabilities.register(
    createCapabilityDescriptor({
      id: "baseline_probe",
      kind: "tool",
      inputSchema: { type: "object", properties: {}, required: [] },
      sideEffect: "read",
      concurrencyGroup: "probe",
      retryable: false,
    }),
    {
      async execute() {
        return { ok: true, output: { success: true, content: "ok" } }
      },
    },
  )
  const responses: EnvBundle["responses"] = []
  const env: WorkflowHarnessEnvironment = {
    scope,
    budgetLimits: mergeRunBudget(budgetOverrides),
    capabilities,
    tools: [probe],
    loopDeps: { provider: new ProbeThenTextProvider(), tools: probeTools },
    respond: async interrupt => {
      responses.push({ interruptId: interrupt.interruptId, prompt: interrupt.prompt })
      return { accepted: true }
    },
    ...overrides,
  }
  return { env, controller, projectRoot, responses }
}

function reg(): HandlerRegistry {
  const registry = new RegistryImpl()
  registry.register("test.reducer", "reducer", async input => ({ content: input.value ?? "reduced" }))
  return registry
}

function node(id: string, execution: WorkflowNodeSpec["execution"], input: Record<string, unknown> = {}, dependsOn: WorkflowNodeSpec["dependsOn"] = []): WorkflowNodeSpec {
  return { id, handler: "test.reducer", input, dependsOn, execution }
}

function spec(nodes: WorkflowNodeSpec[], mode?: WorkflowSpec["mode"]): WorkflowSpec {
  return { schemaVersion: "0.2", specId: `m2-${Math.random().toString(16).slice(2, 8)}`, nodes, mode }
}

const resultOf = (run: Awaited<ReturnType<typeof runScheduler>>, id: string) =>
  run.results.find(r => r.nodeId === id)!

const PASSED_TYPECHECK: VerificationResult = {
  kind: "typecheck",
  command: "tsc --noEmit",
  passed: true,
  issues: 0,
  durationMs: 12,
  summary: "no type errors",
}

describe("M2: llm_agent node → H11 LlmAgentNode", () => {
  test("executes through the unified node runtime; final text + usage propagate", async () => {
    const { env } = buildEnv()
    try {
      const run = await runScheduler(
        spec([node("agent", { kind: "llm_agent", prompt: "do it", maxRounds: 3 })]),
        reg(),
        { harness: env },
      )
      const result = resultOf(run, "agent")
      expect(result.status).toBe("done")
      expect((result.output as { text: string }).text).toBe("final answer")
      expect(result.usage?.inputTokens).toBeGreaterThan(0)
      expect(result.diagnostics).toEqual([])
      expect(result.durationMs).toBeGreaterThan(0)
    } finally {
      rmSync(env.scope.projectRoot, { recursive: true, force: true })
    }
  })

  test("budget exhaustion yields a structured result (errorKind)", async () => {
    const { env } = buildEnv({}, { maxModelCalls: 0 })
    try {
      const run = await runScheduler(
        spec([node("agent", { kind: "llm_agent", prompt: "do it", maxRounds: 2 })]),
        reg(),
        { harness: env },
      )
      const result = resultOf(run, "agent")
      expect(result.status).toBe("failed")
      expect(result.errorKind).toBe("cancelled")
    } finally {
      rmSync(env.scope.projectRoot, { recursive: true, force: true })
    }
  })

  test("declared llm_agent without loopDeps fails closed (no model bypass)", async () => {
    const { env } = buildEnv({ loopDeps: undefined })
    try {
      const run = await runScheduler(
        spec([node("agent", { kind: "llm_agent", prompt: "x" })]),
        reg(),
        { harness: env },
      )
      const result = resultOf(run, "agent")
      expect(result.status).toBe("failed")
      expect(result.error).toContain("loopDeps")
    } finally {
      rmSync(env.scope.projectRoot, { recursive: true, force: true })
    }
  })
})

describe("M2: tool node → H11 ToolNode (CapabilityRegistry)", () => {
  test("capability executes; NodeUsage.toolCalls propagates", async () => {
    const { env } = buildEnv()
    try {
      const run = await runScheduler(
        spec([node("tool1", { kind: "tool", capabilityId: "baseline_probe", params: {} })]),
        reg(),
        { harness: env },
      )
      const result = resultOf(run, "tool1")
      expect(result.status).toBe("done")
      expect((result.output as { success: boolean }).success).toBe(true)
      expect(result.usage?.toolCalls).toBe(1)
    } finally {
      rmSync(env.scope.projectRoot, { recursive: true, force: true })
    }
  })

  test("unknown capability fails with structured capability_not_found", async () => {
    const { env } = buildEnv()
    try {
      const run = await runScheduler(
        spec([node("tool1", { kind: "tool", capabilityId: "no_such_cap", params: {} })]),
        reg(),
        { harness: env },
      )
      const result = resultOf(run, "tool1")
      expect(result.status).toBe("failed")
      expect(result.errorKind).toBe("capability_not_found")
    } finally {
      rmSync(env.scope.projectRoot, { recursive: true, force: true })
    }
  })

  test("readonly mode rejects a write-class capability before execution", async () => {
    const { env } = buildEnv()
    const file = join(env.scope.projectRoot, "w.txt")
    env.capabilities.register(
      createCapabilityDescriptor({
        id: "mock_write",
        kind: "tool",
        inputSchema: { type: "object", properties: {}, required: [] },
        sideEffect: "write",
      }),
      {
        async execute() {
          writeFileSync(file, "new")
          return { ok: true, output: { success: true, content: "written" } }
        },
      },
    )
    try {
      const run = await runScheduler(
        spec([node("wt", { kind: "tool", capabilityId: "mock_write", params: {} })], "readonly"),
        reg(),
        { harness: env },
      )
      const result = resultOf(run, "wt")
      expect(result.status).toBe("failed")
      expect(result.error).toContain("rejected")
    } finally {
      rmSync(env.scope.projectRoot, { recursive: true, force: true })
    }
  })
})

describe("M2: verification node → H11 VerificationNode", () => {
  test("results ingest as bound artifacts + evidence (H8 adapter)", async () => {
    const { env } = buildEnv()
    try {
      const run = await runScheduler(
        spec([node("verify", { kind: "verification" }, { results: [PASSED_TYPECHECK] })]),
        reg(),
        { harness: env },
      )
      const result = resultOf(run, "verify")
      expect(result.status).toBe("done")
      expect((result.output as { passedCount: number }).passedCount).toBe(1)
      expect(result.evidence?.length).toBe(1)
      expect(result.evidence![0]!.artifactId).toBeDefined()
      expect(env.scope.evidenceLedger.entries.length).toBe(1)
      expect(result.usage?.toolCalls).toBe(0)
    } finally {
      rmSync(env.scope.projectRoot, { recursive: true, force: true })
    }
  })

  test("missing input.results fails closed", async () => {
    const { env } = buildEnv()
    try {
      const run = await runScheduler(
        spec([node("verify", { kind: "verification" }, {})]),
        reg(),
        { harness: env },
      )
      const result = resultOf(run, "verify")
      expect(result.status).toBe("failed")
      expect(result.error).toContain("input.results")
    } finally {
      rmSync(env.scope.projectRoot, { recursive: true, force: true })
    }
  })
})

describe("M2: human node → H11 HumanNode", () => {
  test("emits an interrupt to the responder; valid answer completes", async () => {
    const { env, responses } = buildEnv()
    try {
      const run = await runScheduler(
        spec([node("human1", { kind: "human", prompt: "approve the plan?" }, { kind: "plan_approval" })]),
        reg(),
        { harness: env },
      )
      const result = resultOf(run, "human1")
      expect(result.status).toBe("done")
      expect(responses).toHaveLength(1)
      expect(responses[0]!.prompt).toBe("approve the plan?")
      expect(result.output).toEqual({ accepted: true })
    } finally {
      rmSync(env.scope.projectRoot, { recursive: true, force: true })
    }
  })

  test("invalid answer fails with invalid_interrupt_response diagnostic", async () => {
    const { env } = buildEnv({
      respond: async () => ({}) as unknown,
    })
    try {
      const run = await runScheduler(
        spec([node("human1", { kind: "human", prompt: "approve?" }, { kind: "plan_approval" })]),
        reg(),
        { harness: env },
      )
      const result = resultOf(run, "human1")
      expect(result.status).toBe("failed")
      expect(result.diagnostics?.[0]?.code).toBe("invalid_interrupt_response")
    } finally {
      rmSync(env.scope.projectRoot, { recursive: true, force: true })
    }
  })

  test("cancellation propagates into the running node", async () => {
    const { env, controller, responses } = buildEnv()
    try {
      controller.abort("user abort")
      const run = await runScheduler(
        spec([node("human1", { kind: "human", prompt: "approve?" }, { kind: "plan_approval" })]),
        reg(),
        { harness: env },
      )
      const result = resultOf(run, "human1")
      expect(result.status).toBe("failed")
      expect(result.error).toContain("user abort")
      expect(responses).toHaveLength(0)
    } finally {
      rmSync(env.scope.projectRoot, { recursive: true, force: true })
    }
  })
})

describe("M2: fail-closed wiring", () => {
  test("declared H11 node without harness environment rejects the run", async () => {
    await expect(
      runScheduler(spec([node("agent", { kind: "llm_agent", prompt: "x" })]), reg()),
    ).rejects.toThrow(/harness environment/)
  })

  test("legacy function nodes still execute via the handler registry (no bypass)", async () => {
    const { env } = buildEnv()
    try {
      const run = await runScheduler(
        spec([
          { id: "reducer", handler: "test.reducer", input: { value: "r1" }, dependsOn: [] },
          node("tool1", { kind: "tool", capabilityId: "baseline_probe", params: {} }, {}, ["reducer"]),
        ]),
        reg(),
        { harness: env },
      )
      expect(resultOf(run, "reducer").status).toBe("done")
      expect((resultOf(run, "reducer").output as { content: string }).content).toBe("r1")
      expect(resultOf(run, "tool1").status).toBe("done")
    } finally {
      rmSync(env.scope.projectRoot, { recursive: true, force: true })
    }
  })

  test("M1 conditional dependencies compose with H11 nodes (failed → blocked)", async () => {
    const { env } = buildEnv()
    try {
      const run = await runScheduler(
        spec([
          node("tool1", { kind: "tool", capabilityId: "no_such_cap", params: {} }),
          node("agent", { kind: "llm_agent", prompt: "x", maxRounds: 2 }, {}, [{ nodeId: "tool1", when: "succeeded" }]),
        ]),
        reg(),
        { harness: env },
      )
      expect(resultOf(run, "tool1").status).toBe("failed")
      expect(resultOf(run, "agent").status).toBe("blocked")
    } finally {
      rmSync(env.scope.projectRoot, { recursive: true, force: true })
    }
  })
})
