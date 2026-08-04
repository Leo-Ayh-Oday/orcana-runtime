import { describe, expect, test } from "bun:test"
import { agentLoop } from "../src/agent/loop"
import { buildTools, Result } from "../src/tools/registry"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { createAgentHarness } from "../src/harness/runtime/agent-harness"
import type { HarnessEvent } from "../src/harness/contracts/events"
import { createLlmAgentNode } from "../src/harness/nodes/llm-agent-node"
import { createNodeExecutionContext } from "../src/harness/nodes/context"
import { runNodeToResult } from "../src/harness/nodes/run"
import { createCapabilityRegistry } from "../src/harness/capabilities/registry"
import { registerToolCapabilities } from "../src/harness/capabilities/tool-adapter"
import { assembleRunScope } from "../src/harness/runtime/run-scope"
import { createBudgetLedger, mergeRunBudget } from "../src/harness/runtime/budget-ledger"
import { buildLoopOptions } from "../src/harness/runtime/legacy-loop-adapter"
import type { AgentRun } from "../src/harness/contracts/run"
import { addEvidence, generateEvidenceId } from "../src/agent/evidence-ledger"
import { computeWorkspaceHash } from "../src/harness/persistence/workspace-hash"

// H11 acceptance: a single agent IS one LlmAgentNode. Three-way parity check
// (direct agentLoop / AgentHarness / LlmAgentNode) on the same scripted
// provider + tools.

const SAVED_FLASH_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
process.env.ORCANA_FLASH_TRIAGE = "off"

class ProbeThenTextProvider implements LLMProvider {
  rounds = 0
  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "token_usage", data: { inputTokens: 100, outputTokens: 20, cacheSource: "provider", round: 0 } }
      yield { type: "tool_call", data: { id: "probe-1", name: "baseline_probe", input: { q: "x" } } }
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

const PROMPT = "Read only: probe and summarize. Do not edit."

// ── Path A: direct agentLoop (bare AgentOptions — no harness scope needed) ──
async function runPathA() {
  const provider = new ProbeThenTextProvider()
  const options = {
    provider,
    model: "test",
    tools: probeTool(),
    maxRounds: 2,
  } as never
  const texts: string[] = []
  const toolCalls: Array<{ name: string; input: unknown }> = []
  for await (const event of agentLoop(PROMPT, options)) {
    if (event.type === "text") texts.push(String(event.data))
    if (event.type === "tool_call") {
      const call = event.data as { name: string; input: unknown }
      toolCalls.push({ name: call.name, input: call.input })
    }
  }
  return { finalText: texts[texts.length - 1] ?? "", toolCalls }
}

// ── Path B: AgentHarness ──
async function runPathB() {
  const harness = createAgentHarness({
    deps: { provider: new ProbeThenTextProvider(), tools: probeTool() },
    sessionId: "sess-b",
  })
  const session = await harness.createSession()
  const events: HarnessEvent[] = []
  for await (const event of harness.run(session.sessionId, { prompt: PROMPT, maxRounds: 2 } as never)) {
    events.push(event)
  }
  const snapshot = await harness.inspect(events[0]!.runId)
  const texts = events.filter((e) => "text" in e.payload).map((e) => (e.payload as { text: string }).text)
  const toolCalls = events.filter((e) => "toolCall" in e.payload).map((e) => {
    const tc = (e.payload as { toolCall: { name: string; input: unknown } }).toolCall
    return { name: tc.name, input: tc.input }
  })
  return { finalText: texts[texts.length - 1] ?? "", toolCalls, outcome: snapshot.outcome }
}

// ── Path C: LlmAgentNode ──
async function runPathC() {
  const projectRoot = "/tmp/h11-llm-agent-node"
  const runId = "run-c"
  const controller = new AbortController()
  const scope = assembleRunScope({ runId, sessionId: "sess-c", projectRoot, controller })
  const run: AgentRun = {
    runId,
    sessionId: "sess-c",
    status: "running",
    input: { prompt: PROMPT, maxRounds: 2 },
    scope,
    budget: createBudgetLedger(mergeRunBudget(undefined)),
    createdAt: Date.now(),
    eventSequence: 0,
    schemaVersion: 1,
  }
  const capabilities = createCapabilityRegistry()
  registerToolCapabilities(capabilities, probeTool())
  const context = createNodeExecutionContext({ run, capabilities })
  const node = createLlmAgentNode({ id: "agent", deps: { provider: new ProbeThenTextProvider(), tools: probeTool() } })
  const { events, result } = await runNodeToResult(node, context, { prompt: PROMPT, maxRounds: 2 })
  const texts = events.filter((e) => e.type === "node.text").map((e) => (e as { text: string }).text)
  const toolCalls = events.filter((e) => e.type === "node.tool.call").map((e) => {
    const tc = (e as { toolCall: { name: string; input: unknown } }).toolCall
    return { name: tc.name, input: tc.input }
  })
  return { finalText: texts[texts.length - 1] ?? "", toolCalls, result, events }
}

describe("H11 LlmAgentNode parity", () => {
  test("final text matches the direct agentLoop and AgentHarness paths", async () => {
    const [a, b, c] = await Promise.all([runPathA(), runPathB(), runPathC()])
    expect(c.finalText).toBe("final answer")
    expect(a.finalText).toBe(c.finalText)
    expect(b.finalText).toBe(c.finalText)
  })

  test("tool call sequence matches (names and inputs)", async () => {
    const [a, b, c] = await Promise.all([runPathA(), runPathB(), runPathC()])
    expect(c.toolCalls).toEqual([{ name: "baseline_probe", input: { q: "x" } }])
    expect(a.toolCalls).toEqual(c.toolCalls)
    expect(b.toolCalls).toEqual(c.toolCalls)
  })

  test("node result succeeds with final output and parity outcome", async () => {
    const [b, c] = await Promise.all([runPathB(), runPathC()])
    expect(c.result.status).toBe("succeeded")
    expect(c.result.output?.text).toBe("final answer")
    expect(c.result.output?.outcome.kind).toBe("completed")
    expect(b.outcome?.kind).toBe("completed")
  })

  test("usage accumulates provider tokens", async () => {
    const { result } = await runPathC()
    expect(result.output?.usage.inputTokens).toBe(150)
    expect(result.output?.usage.outputTokens).toBe(30)
  })

  test("budget guard cancels on exhaustion with explicit reason", async () => {
    const projectRoot = "/tmp/h11-llm-agent-budget"
    const runId = "run-c-budget"
    const controller = new AbortController()
    const scope = assembleRunScope({ runId, sessionId: "sess-budget", projectRoot, controller })
    const run: AgentRun = {
      runId,
      sessionId: "sess-budget",
      status: "running",
      input: { prompt: PROMPT, maxRounds: 2 },
      scope,
      budget: createBudgetLedger(mergeRunBudget({ maxToolCalls: 0 })),
      createdAt: Date.now(),
      eventSequence: 0,
      schemaVersion: 1,
    }
    const capabilities = createCapabilityRegistry()
    const context = createNodeExecutionContext({ run, capabilities })
    const node = createLlmAgentNode({ id: "agent-budget", deps: { provider: new ProbeThenTextProvider(), tools: probeTool() } })
    const { result } = await runNodeToResult(node, context, { prompt: PROMPT, maxRounds: 2 })
    expect(result.status).toBe("cancelled")
    expect(result.output?.outcome.kind).toBe("cancelled")
  })

  test("R1: AgentNodeOutput carries the evidence/artifact/tx/digest chain", async () => {
    const { result } = await runPathC()
    const output = result.output!
    expect(Array.isArray(output.evidenceIds)).toBe(true)
    expect(Array.isArray(output.artifactIds)).toBe(true)
    expect(Array.isArray(output.patchTransactionIds)).toBe(true)
    expect(Array.isArray(output.unresolvedRippleObligations)).toBe(true)
    expect(output.resultingWorkspaceDigest).toBe(computeWorkspaceHash("/tmp/h11-llm-agent-node"))
    // NodeResult.evidence and output.evidenceIds are the same ledger diff.
    expect(result.evidence.map((e) => e.id)).toEqual(output.evidenceIds)
  })

  test("R1: the node diffs the same ledger the kernel is injected with (seed excluded)", async () => {
    // Seed the run-scope ledger before the node starts: buildLoopOptions now
    // injects scope.evidenceLedger, so the kernel and the node share ONE
    // authoritative ledger — the node's diff must exclude pre-existing
    // entries while still being the kernel's own write target.
    const seeded = { id: generateEvidenceId(), kind: "manual" as const, output: "pre-existing", passed: true, timestamp: Date.now() }
    const projectRoot = "/tmp/h11-llm-agent-node-seeded"
    const runId = "run-seeded"
    const controller = new AbortController()
    const scope = assembleRunScope({ runId, sessionId: "sess-seeded", projectRoot, controller })
    addEvidence(scope.evidenceLedger, seeded)
    const run: AgentRun = {
      runId,
      sessionId: "sess-seeded",
      status: "running",
      input: { prompt: PROMPT, maxRounds: 2 },
      scope,
      budget: createBudgetLedger(mergeRunBudget(undefined)),
      createdAt: Date.now(),
      eventSequence: 0,
      schemaVersion: 1,
    }
    const capabilities = createCapabilityRegistry()
    registerToolCapabilities(capabilities, probeTool())
    const context = createNodeExecutionContext({ run, capabilities })
    const node = createLlmAgentNode({ id: "agent-seeded", deps: { provider: new ProbeThenTextProvider(), tools: probeTool() } })
    const { result } = await runNodeToResult(node, context, { prompt: PROMPT, maxRounds: 2 })
    expect(result.status).toBe("succeeded")
    expect(result.output!.evidenceIds).not.toContain(seeded.id)
    expect(result.output!.evidenceIds).toEqual(result.evidence.map((e) => e.id))
  })
})

describe("H11 acceptance: single agent as one LlmAgentNode", () => {
  test("runs a full single-agent turn through the node without AgentHarness", async () => {
    const projectRoot = "/tmp/h11-acceptance"
    const runId = "run-accept"
    const controller = new AbortController()
    const scope = assembleRunScope({ runId, sessionId: "sess-accept", projectRoot, controller })
    const run: AgentRun = {
      runId,
      sessionId: "sess-accept",
      status: "running",
      input: { prompt: PROMPT, maxRounds: 2 },
      scope,
      budget: createBudgetLedger(mergeRunBudget(undefined)),
      createdAt: Date.now(),
      eventSequence: 0,
      schemaVersion: 1,
    }
    const capabilities = createCapabilityRegistry()
    registerToolCapabilities(capabilities, probeTool())
    const context = createNodeExecutionContext({ run, capabilities })
    const node = createLlmAgentNode({ id: "agent-accept", deps: { provider: new ProbeThenTextProvider(), tools: probeTool() } })
    const { events, result } = await runNodeToResult(node, context, { prompt: PROMPT, maxRounds: 2 })
    expect(result.status).toBe("succeeded")
    expect(result.output?.text).toBe("final answer")
    // Lifecycle events bookend the run.
    expect(events[0]).toMatchObject({ type: "node.status", status: "running" })
    expect(events[events.length - 1]).toMatchObject({ type: "node.status", status: "succeeded" })
  })
})
