import { afterAll, describe, expect, test } from "bun:test"
import { createAgentHarness } from "../src/harness/runtime/agent-harness"
import type { HarnessEvent } from "../src/harness/contracts/events"
import type { AgentRunTrace } from "../src/agent/run-trace"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { buildTools, Result } from "../src/tools/registry"

// H2 acceptance: every exit maps to a structured RunOutcome; each run has
// exactly one terminal state visible via inspect().

const SAVED_ORCANA_FLASH_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
process.env.ORCANA_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_ORCANA_FLASH_TRIAGE === undefined) delete process.env.ORCANA_FLASH_TRIAGE
  else process.env.ORCANA_FLASH_TRIAGE = SAVED_ORCANA_FLASH_TRIAGE
})

function probeTool() {
  return buildTools({
    name: "baseline_probe",
    description: "Return a deterministic read-only probe result",
    isReadonly: true,
    isConcurrencySafe: true,
    inputSchema: { type: "object", properties: {}, required: [] },
    execute() {
      return Result.ok("probe-ok")
    },
  })
}

class ProbeThenTextProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "probe-1", name: "baseline_probe", input: {} } }
      return
    }
    yield { type: "text", data: "H2 final." }
  }
}

class AlwaysToolProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.rounds++
    yield { type: "tool_call", data: { id: `probe-${this.rounds}`, name: "baseline_probe", input: {} } }
  }
}

class AbortAwareProvider implements LLMProvider {
  aborted = false

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    options.abortSignal?.addEventListener("abort", () => {
      this.aborted = true
    }, { once: true })
    yield { type: "status", data: "provider-ready" }
    await new Promise<void>(() => {})
  }
}

class PlanProvider implements LLMProvider {
  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (options.purpose === "flash_triage") {
      yield {
        type: "text",
        data: JSON.stringify({
          mode: "plan_before_code",
          needsWeb: false,
          researchQueries: [],
          relevantSkillNames: [],
          planSteps: [
            { id: "foundation", title: "Create project foundation", deliverables: ["package.json", "tsconfig.json"], verification: "typecheck" },
            { id: "backend", title: "Create API and tests", deliverables: ["server/index.ts", "server/index.test.ts"], verification: "test" },
          ],
          requiredVerification: ["typecheck", "test"],
          reasoning: "multi-surface implementation requires an approved plan",
          riskLevel: "medium",
        }),
      }
      return
    }
    yield {
      type: "text",
      data: [
        "Problem model: build a complete small service. Scope includes package setup, TypeScript config, Bun API, tests, and typecheck verification. Out of scope: auth and deployment.",
        "Assumptions and uncertainty: the repo may be empty, so I will create a minimal but coherent structure. If existing files appear later, I will adapt instead of overwriting blindly.",
        "Risk and counter-argument: the fastest path is a default stub, but that would fail the quality floor. API tests should start and stop the service or use finite smoke checks.",
        "Selected approach: Bun TypeScript API with JSON content. I choose this because it keeps the first deliverable small, testable, and easy to inspect.",
        "Execution checklist:",
        "- Create package.json and tsconfig.json with scripts for typecheck, test, and build.",
        "- Create server/index.ts and server/index.test.ts with success and error paths.",
        "- Run external verification: bun run typecheck, bun test.",
      ].join("\n"),
    }
  }
}

class ClarificationProvider implements LLMProvider {
  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    yield {
      type: "text",
      data: [
        "[clarification-gate]",
        JSON.stringify({
          questions: [{
            id: "scope",
            title: "选择交付范围",
            options: [
              { key: "A", label: "最小可用版本", recommended: true },
              { key: "B", label: "完整产品版本" },
            ],
          }],
        }),
      ].join("\n"),
    }
  }
}

async function runAndInspect(
  deps: Parameters<typeof createAgentHarness>[0]["deps"],
  prompt: string,
  metadata: Record<string, unknown> = {},
  sessionId = "sess-lc",
  maxRounds?: number,
): Promise<{ status: string; outcomeKind: string; events: HarnessEvent[]; runId: string }> {
  const harness = createAgentHarness({ deps, sessionId })
  const session = await harness.createSession()
  const events: HarnessEvent[] = []
  for await (const event of harness.run(session.sessionId, { prompt, metadata, maxRounds })) {
    events.push(event)
  }
  const runId = events[0]!.runId
  const snapshot = await harness.inspect(runId)
  return { status: snapshot.status, outcomeKind: snapshot.outcome?.kind ?? "none", events, runId }
}

describe("Harness H2 lifecycle outcomes", () => {
  test("normal completion → completed with outcome", async () => {
    const result = await runAndInspect(
      { provider: new ProbeThenTextProvider(), tools: probeTool() },
      "Read only: probe and summarize. Do not edit.",
    )
    expect(result.status).toBe("completed")
    expect(result.outcomeKind).toBe("completed")
  })

  test("plan approval pause → waiting with plan-approval interrupt", async () => {
    const result = await runAndInspect(
      { provider: new PlanProvider(), tools: [], flashTriagePolicy: "always" },
      "Build a complete small service with package setup, API, and typecheck verification.",
    )
    expect(result.status).toBe("waiting")
    expect(result.outcomeKind).toBe("waiting")
    // Plan-ready bridge event surfaced before the waiting lifecycle event.
    const planReadys = result.events.filter(e => "planReady" in e.payload)
    expect(planReadys).toHaveLength(1)
  })

  test("clarification pause → waiting with clarification interrupt", async () => {
    const result = await runAndInspect(
      { provider: new ClarificationProvider(), tools: [] },
      "做一个全栈项目",
    )
    expect(result.status).toBe("waiting")
    expect(result.outcomeKind).toBe("waiting")
    const clarifications = result.events.filter(e => "clarification" in e.payload)
    expect(clarifications).toHaveLength(1)
  })

  test("context budget hard block → blocked", async () => {
    const oldWarn = process.env.ORCANA_CONTEXT_WARN_RATIO
    const oldBlock = process.env.ORCANA_CONTEXT_BLOCK_RATIO
    process.env.ORCANA_CONTEXT_WARN_RATIO = "0.000001"
    process.env.ORCANA_CONTEXT_BLOCK_RATIO = "0.000002"
    try {
      const result = await runAndInspect(
        { provider: new ProbeThenTextProvider(), tools: probeTool() },
        "continue",
        {},
        "sess-budget",
      )
      expect(result.status).toBe("blocked")
      expect(result.outcomeKind).toBe("blocked")
      const blockedEvents = result.events.filter(e => "status" in e.payload && e.payload.status === "blocked")
      expect(blockedEvents.length).toBeGreaterThan(0)
    } finally {
      if (oldWarn === undefined) delete process.env.ORCANA_CONTEXT_WARN_RATIO
      else process.env.ORCANA_CONTEXT_WARN_RATIO = oldWarn
      if (oldBlock === undefined) delete process.env.ORCANA_CONTEXT_BLOCK_RATIO
      else process.env.ORCANA_CONTEXT_BLOCK_RATIO = oldBlock
    }
  })

  test("round budget exhaustion → paused", async () => {
    const provider = new AlwaysToolProvider()
    const result = await runAndInspect(
      { provider, tools: probeTool() },
      "inspect the project state",
      {},
      "sess-round",
      2,
    )
    expect(provider.rounds).toBe(2)
    expect(result.status).toBe("paused")
    expect(result.outcomeKind).toBe("paused")
  })

  test("exception during run → failed with failure outcome (error still propagates)", async () => {
    const throwingTrace = {
      record(type: string) {
        if (type === "round_started") throw new Error("h2 trace failure")
      },
    }
    const harness = createAgentHarness({
      deps: { provider: new ProbeThenTextProvider(), tools: probeTool() },
      sessionId: "sess-fail",
    })
    const session = await harness.createSession()
    const events: HarnessEvent[] = []
    let thrown: unknown
    try {
      for await (const event of harness.run(session.sessionId, {
        prompt: "Read only: probe. Do not edit.",
        metadata: { "legacy.runTrace": throwingTrace },
      })) {
        events.push(event)
      }
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe("h2 trace failure")
    // The run still formed a failed outcome with a run.failed event.
    const runId = events[0]!.runId
    const snapshot = await harness.inspect(runId)
    expect(snapshot.status).toBe("failed")
    expect(snapshot.outcome?.kind).toBe("failed")
    expect(events.some(e => e.type === "run.failed")).toBe(true)
  })

  test("cancel → cancelled with reason", async () => {
    const provider = new AbortAwareProvider()
    const harness = createAgentHarness({ deps: { provider, tools: [] }, sessionId: "sess-cancel2" })
    const session = await harness.createSession()
    const iterator = harness.run(session.sessionId, { prompt: "inspect", metadata: {} })[Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first.done).toBe(false)
    const runId = first.value.runId
    // Drain until provider-ready, then cancel.
    let sawReady = false
    while (!sawReady) {
      const step = await iterator.next()
      if (step.done) break
      const payload = step.value.payload
      if ("display" in payload && payload.display.kind === "status" && payload.display.data === "provider-ready") {
        sawReady = true
      }
    }
    expect(sawReady).toBe(true)
    await harness.cancel(runId, "user hit cancel")
    while (true) {
      const step = await iterator.next()
      if (step.done) break
    }
    expect(provider.aborted).toBe(true)
    const snapshot = await harness.inspect(runId)
    expect(snapshot.status).toBe("cancelled")
    expect(snapshot.outcome?.kind).toBe("cancelled")
    if (snapshot.outcome?.kind === "cancelled") {
      expect(snapshot.outcome.reason).toBe("user hit cancel")
    }
  })
})
