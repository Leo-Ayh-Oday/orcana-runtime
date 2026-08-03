import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { buildTools, Result } from "../src/tools/registry"
import { createNodeExecutionContext, createDefaultNodePolicyContext, createMinimalContextSlice } from "../src/harness/nodes/context"
import { runNode, runNodeToResult } from "../src/harness/nodes/run"
import { createFunctionNode } from "../src/harness/nodes/function-node"
import { createToolNode } from "../src/harness/nodes/tool-node"
import { createVerificationNode } from "../src/harness/nodes/verification-node"
import { createCapabilityRegistry } from "../src/harness/capabilities/registry"
import { registerToolCapabilities } from "../src/harness/capabilities/tool-adapter"
import { createCapabilityDescriptor } from "../src/harness/capabilities/descriptor"
import { assembleRunScope } from "../src/harness/runtime/run-scope"
import { createBudgetLedger, mergeRunBudget } from "../src/harness/runtime/budget-ledger"
import type { AgentRun, AgentRunInput } from "../src/harness/contracts/run"
import type { NodeExecutionContext } from "../src/harness/contracts/nodes"
import type { VerificationResult } from "../src/verification/result"

// H11 part A: node runtime contracts, sequential runner, FunctionNode —
// lifecycle events, cancellation, node context, single-use enforcement.

class ProbeThenTextProvider implements LLMProvider {
  rounds = 0
  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "token_usage", data: { inputTokens: 100, outputTokens: 20, cacheSource: "provider", round: 0 } }
      yield { type: "tool_call", data: { id: "probe-1", name: "baseline_probe", input: {} } }
      return
    }
    yield { type: "text", data: "done" }
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

/** Build a real AgentRun + node context (assembleRunScope, run-level ledger). */
function buildNodeContext(budgetLimits?: Record<string, number>): { context: NodeExecutionContext; run: AgentRun; projectRoot: string } {
  const projectRoot = mkdtempSync(join(tmpdir(), "h11-node-"))
  const runId = `run-${projectRoot.split("/").pop()}`
  const controller = new AbortController()
  const scope = assembleRunScope({ runId, sessionId: "sess-node", projectRoot, controller })
  const input: AgentRunInput = { prompt: "read", maxRounds: 2 }
  const run: AgentRun = {
    runId,
    sessionId: "sess-node",
    status: "running",
    input,
    scope,
    budget: createBudgetLedger(mergeRunBudget(budgetLimits)),
    createdAt: Date.now(),
    eventSequence: 0,
    schemaVersion: 1,
  }
  const capabilities = createCapabilityRegistry()
  registerToolCapabilities(capabilities, probeTool())
  const context = createNodeExecutionContext({
    run,
    capabilities,
    context: createMinimalContextSlice(),
  })
  return { context, run, projectRoot }
}

/** A write-class mock capability with a committed patch (artifact path).
 *  Input carries { path, content } so the artifact tracker can snapshot/diff. */
function registerWriteCapability(context: NodeExecutionContext, file: string): void {
  context.capabilities.register(
    createCapabilityDescriptor({
      id: "mock_write",
      kind: "tool",
      inputSchema: { type: "object", properties: {}, required: [] },
      sideEffect: "write",
    }),
    {
      async execute(input) {
        const params = input as { path?: string; content?: string }
        writeFileSync(params.path ?? file, params.content ?? "new")
        return { ok: true, output: { success: true, content: "written", metadata: { patchTransactionId: "ptxn_mock" } } }
      },
    },
  )
}

/** Register the probe tool as a real capability (first-batch filter skips it).
 *  Cooperates with cancellation so the abort path is observable. */
function registerProbeCapability(context: NodeExecutionContext): void {
  context.capabilities.register(
    { ...createCapabilityDescriptor({ id: "baseline_probe", kind: "tool", inputSchema: { type: "object", properties: {}, required: [] } }) },
    {
      execute: async (_input, ctx) => {
        if (ctx?.abortSignal?.aborted) return { ok: false, error: "aborted by signal" }
        return { ok: true, output: { success: true, content: "ok" } }
      },
    },
  )
}

describe("H11 node runtime", () => {
  test("FunctionNode lifecycle: running → output → terminal status", async () => {
    const { context } = buildNodeContext()
    const node = createFunctionNode<{ n: number }, number>({
      id: "double",
      handler: (input) => input.n * 2,
    })
    const { events, result } = await runNodeToResult(node, context, { n: 21 })
    expect(result.status).toBe("succeeded")
    expect(result.output).toBe(42)
    const statuses = events.filter((e) => e.type === "node.status")
    expect(statuses[0]).toMatchObject({ status: "running" })
    expect(statuses[1]).toMatchObject({ status: "succeeded" })
    expect(events.some((e) => e.type === "node.output" && (e as { output: unknown }).output === 42)).toBe(true)
  })

  test("FunctionNode failure emits node.error and fails the result", async () => {
    const { context } = buildNodeContext()
    const node = createFunctionNode({
      id: "boom",
      handler: () => { throw new Error("kaboom") },
    })
    const { events, result } = await runNodeToResult(node, context, {})
    expect(result.status).toBe("failed")
    expect(result.error?.message).toBe("kaboom")
    expect(events.some((e) => e.type === "node.error")).toBe(true)
  })

  test("pre-cancelled run: handler never executes", async () => {
    const { context } = buildNodeContext()
    context.cancellation.cancel("test-cancel")
    let executed = false
    const node = createFunctionNode({
      id: "never",
      handler: () => { executed = true; return "x" },
    })
    const { result } = await runNodeToResult(node, context, {})
    expect(executed).toBe(false)
    expect(result.status).toBe("failed")
    expect(result.error?.message).toContain("cancelled")
  })

  test("node context carries run id, scope, budget and cancellation", () => {
    const { context, run } = buildNodeContext()
    expect(context.runId).toBe(run.runId)
    expect(context.nodeRunId).toBeTruthy()
    expect(context.runScope.sessionId).toBe("sess-node")
    expect(context.budget).toBeDefined()
    expect(context.cancellation.signal).toBeDefined()
    expect(context.artifacts).toBeDefined()
    expect(context.trace).toBeDefined()
  })

  test("nodes are single-use: second runNode throws", async () => {
    const { context } = buildNodeContext()
    const node = createFunctionNode({ id: "once", handler: () => "ok" })
    await runNodeToResult(node, context, {})
    await expect(runNode(node, context, {}).next()).rejects.toThrow(/single-use/)
  })

  test("createDefaultNodePolicyContext provides conservative defaults", () => {
    const policy = createDefaultNodePolicyContext({ path: "x.ts" })
    expect(policy.permissionMode).toBe("strict")
    expect(policy.input).toEqual({ path: "x.ts" })
  })
})

// ── ToolNode + VerificationNode (part B) ──

describe("H11 ToolNode", () => {
  test("executes a registered capability successfully", async () => {
    const { context } = buildNodeContext()
    registerProbeCapability(context)
    const node = createToolNode({ id: "read" })
    const { events, result } = await runNodeToResult(node, context, { capabilityId: "baseline_probe", params: {} })
    expect(result.status).toBe("succeeded")
    expect(result.output?.success).toBe(true)
    expect(result.usage.toolCalls).toBe(1)
    expect(events.some((e) => e.type === "node.tool.result")).toBe(true)
  })

  test("unknown capability fails the node", async () => {
    const { context } = buildNodeContext()
    const node = createToolNode({ id: "nope" })
    const { result } = await runNodeToResult(node, context, { capabilityId: "missing", params: {} })
    expect(result.status).toBe("failed")
    expect(result.error?.kind).toBe("capability_not_found")
  })

  test("budget exhaustion blocks the tool and leaves no ledger leak", async () => {
    const { context } = buildNodeContext({ maxWrites: 0 })
    registerWriteCapability(context, join(context.runScope.projectRoot, "a.txt"))
    const node = createToolNode({ id: "write" })
    const { result } = await runNodeToResult(node, context, { capabilityId: "mock_write", params: { content: "x" } })
    expect(result.status).toBe("blocked")
    expect(result.error?.message).toContain("write_budget")
    expect(context.budget.used.writes).toBe(0)
    expect(context.budget.used.toolCalls).toBe(0)
  })

  test("write capability records a patch artifact in the run store", async () => {
    const { context, projectRoot } = buildNodeContext()
    const file = join(projectRoot, "a.txt")
    writeFileSync(file, "old")
    registerWriteCapability(context, file)
    const node = createToolNode({ id: "write" })
    const { result } = await runNodeToResult(node, context, { capabilityId: "mock_write", params: { path: file, content: "new" } })
    expect(result.status).toBe("succeeded")
    const patches = await context.artifacts.findByKind("patch")
    expect(patches).toHaveLength(1)
    expect(patches[0]!.producedBy).toBe("mock_write")
  })

  test("cancellation propagates to the capability executor", async () => {
    const { context } = buildNodeContext()
    registerProbeCapability(context)
    context.cancellation.cancel("node-cancel")
    const node = createToolNode({ id: "read" })
    const { result } = await runNodeToResult(node, context, { capabilityId: "baseline_probe", params: {} })
    // The executor surfaces the abort as a failed tool result.
    expect(["failed", "blocked"]).toContain(result.status)
  })
})

describe("H11 VerificationNode", () => {
  test("ingests verification results as bound artifacts and evidence", async () => {
    const { context } = buildNodeContext()
    const node = createVerificationNode({ id: "verify" })
    const verification: VerificationResult = {
      kind: "typecheck",
      command: "bun run typecheck",
      passed: true,
      issues: 0,
      durationMs: 10,
      summary: "typecheck ok",
    }
    const { events, result } = await runNodeToResult(node, context, { results: [verification] })
    expect(result.status).toBe("succeeded")
    expect(result.output?.passedCount).toBe(1)
    expect(result.output?.ingested).toHaveLength(1)
    expect(events.some((e) => e.type === "node.artifact")).toBe(true)
    const artifacts = await context.artifacts.findByKind("typecheck_result")
    expect(artifacts).toHaveLength(1)
  })

  test("unclassifiable kinds warn but do not fail", async () => {
    const { context } = buildNodeContext()
    const node = createVerificationNode({ id: "verify" })
    const verification: VerificationResult = {
      kind: "unknown",
      command: "mystery",
      passed: true,
      issues: 0,
      durationMs: 1,
      summary: "??",
    }
    const { result } = await runNodeToResult(node, context, { results: [verification] })
    expect(result.status).toBe("succeeded")
    expect(result.output?.ingested).toHaveLength(0)
    expect(result.diagnostics.some((d) => d.code === "unclassified_kind")).toBe(true)
  })
})
