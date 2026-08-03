import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { buildTools, Result } from "../src/tools/registry"
import { createNodeExecutionContext, createDefaultNodePolicyContext, createMinimalContextSlice } from "../src/harness/nodes/context"
import { runNode, runNodeToResult } from "../src/harness/nodes/run"
import { createFunctionNode } from "../src/harness/nodes/function-node"
import { createCapabilityRegistry } from "../src/harness/capabilities/registry"
import { registerToolCapabilities } from "../src/harness/capabilities/tool-adapter"
import { assembleRunScope } from "../src/harness/runtime/run-scope"
import { createBudgetLedger, mergeRunBudget } from "../src/harness/runtime/budget-ledger"
import type { AgentRun, AgentRunInput } from "../src/harness/contracts/run"
import type { NodeExecutionContext } from "../src/harness/contracts/nodes"

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
function buildNodeContext(budgetLimits?: Record<string, number>): { context: NodeExecutionContext; run: AgentRun } {
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
  return { context, run }
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
