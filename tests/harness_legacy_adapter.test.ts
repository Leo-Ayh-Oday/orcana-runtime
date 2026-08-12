import { afterAll, describe, expect, test } from "bun:test"
import { createAgentHarness } from "../src/harness/runtime/agent-harness"
import { assembleRunScope } from "../src/harness/runtime/run-scope"
import {
  buildLoopOptions,
  createLegacyLoopAdapter,
  LEGACY_AUTO_APPROVE_PLAN,
  LEGACY_CONVERSATION_HISTORY,
  LEGACY_INITIAL_PLAN_STATE,
  LEGACY_PLAN_TEXT,
  LEGACY_RUN_TRACE,
  LEGACY_STABLE_MEMORY_CONTEXT,
  LEGACY_THINK_EFFORT,
} from "../src/harness/runtime/legacy-loop-adapter"
import type { AgentRun } from "../src/harness/contracts/run"
import type { HarnessEvent } from "../src/harness/contracts/events"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { buildTools, Result } from "../src/tools/registry"

// H1 adapter coverage: StreamEvent → HarnessEvent mapping, metadata →
// AgentOptions, envelope invariants (sequence, runId, sessionId).

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

/** Round 0: tool call; round 1: final text — covers the streaming surface. */
class ProbeThenTextProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "probe-1", name: "baseline_probe", input: {} } }
      return
    }
    yield { type: "text", data: "H1 adapter final." }
  }
}

function fakeRun(sessionId: string, input: { prompt: string; tools?: Array<{ name: string; description?: string }>; metadata?: Record<string, unknown> }): AgentRun {
  const runId = "run-test-1"
  const controller = new AbortController()
  return {
    runId,
    sessionId,
    status: "created",
    input: { prompt: input.prompt, tools: input.tools, metadata: input.metadata },
    scope: assembleRunScope({ runId, sessionId, projectRoot: process.cwd(), controller }),
    budget: undefined as never,
    createdAt: Date.now(),
    eventSequence: 0,
    schemaVersion: 1,
  }
}

async function collect(iterable: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

describe("LegacyLoopAdapter buildLoopOptions", () => {
  test("maps run input + metadata into AgentOptions", () => {
    const run = fakeRun("sess-1", { prompt: "inspect" })
    const metadata: Record<string, unknown> = {
      [LEGACY_CONVERSATION_HISTORY]: [{ role: "user" as const, content: "prev" }],
      [LEGACY_THINK_EFFORT]: "high",
      [LEGACY_STABLE_MEMORY_CONTEXT]: "stable anchor",
      [LEGACY_AUTO_APPROVE_PLAN]: true,
      [LEGACY_INITIAL_PLAN_STATE]: "approved",
      [LEGACY_PLAN_TEXT]: "plan text",
    }
    const opts = buildLoopOptions(run, run.input, { provider: {} as never, tools: probeTool() }, undefined)

    expect(opts.conversationHistory).toBeUndefined() // metadata keys not present in this input
    const opts2 = buildLoopOptions(
      run,
      { prompt: "inspect", maxRounds: 3, metadata },
      { provider: {} as never, tools: probeTool() },
    )
    expect(opts2.conversationHistory).toEqual([{ role: "user", content: "prev" }])
    expect(opts2.thinkEffort).toBe("high")
    expect(opts2.stableMemoryContext).toBe("stable anchor")
    expect(opts2.autoApprovePlan).toBe(true)
    expect(opts2.initialPlanState).toBe("approved")
    expect(opts2.planText).toBe("plan text")
    expect(opts2.maxRounds).toBe(3)
  })

  test("filters tools by name when input.tools is provided", () => {
    const run = fakeRun("sess-1", {
      prompt: "inspect",
      tools: [{ name: "baseline_probe", description: "probe" }],
    })
    const opts = buildLoopOptions(run, run.input, { provider: {} as never, tools: probeTool() })
    expect(opts.tools.map(t => t.defn.name)).toEqual(["baseline_probe"])
  })

  test("passes abortSignal through", () => {
    const controller = new AbortController()
    const run = fakeRun("sess-1", { prompt: "inspect" })
    const opts = buildLoopOptions(run, run.input, { provider: {} as never, tools: [] }, controller.signal)
    expect(opts.abortSignal).toBe(controller.signal)
  })
})

describe("LegacyLoopAdapter execute event bridge", () => {
  test("streams toolCall/tool/text/usage events with continuous sequence and run ids", async () => {
    const harness = createAgentHarness({
      deps: { provider: new ProbeThenTextProvider(), tools: probeTool() },
      sessionId: "sess-bridge",
    })
    const session = await harness.createSession()
    const events = await collect(harness.run(session.sessionId, {
      prompt: "Read only: probe and summarize. Do not edit.",
      metadata: { [LEGACY_RUN_TRACE]: undefined },
    }))

    expect(events.length).toBeGreaterThan(0)
    const sequences = events.map(e => e.sequence)
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBe(sequences[i - 1]! + 1)
    }
    for (const event of events) {
      expect(event.runId).toBeTruthy()
      expect(event.sessionId).toBe(session.sessionId)
      expect(event.schemaVersion).toBe(1)
    }

    const toolCalls = events.filter(e => "toolCall" in e.payload)
    expect(toolCalls).toHaveLength(1)
    if (toolCalls[0] && "toolCall" in toolCalls[0].payload) {
      expect(toolCalls[0].payload.toolCall.name).toBe("baseline_probe")
    }

    const tools = events.filter(e => "toolName" in e.payload)
    expect(tools).toHaveLength(1)
    if (tools[0] && "toolName" in tools[0].payload) {
      expect(tools[0].payload.toolName).toBe("baseline_probe")
      expect(tools[0].payload.success).toBe(true)
    }

    const texts = events.filter(e => "text" in e.payload)
    expect(texts).toHaveLength(1)
    if (texts[0] && "text" in texts[0].payload) {
      expect(texts[0].payload.text).toBe("H1 adapter final.")
    }

    const usages = events.filter(e => "usage" in e.payload)
    expect(usages.length).toBeGreaterThan(0)
    const displays = events.filter(e => "display" in e.payload)
    expect(displays.length).toBeGreaterThan(0)
    expect(displays.some(e => "display" in e.payload && e.payload.display.kind === "status")).toBe(true)
  })

  test("bridges plan_ready with the opaque plan payload", async () => {
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
    const harness = createAgentHarness({
      deps: { provider: new PlanProvider(), tools: [], modelRouter: undefined, flashTriagePolicy: "always" },
      sessionId: "sess-plan",
    })
    const session = await harness.createSession()
    // IC05 Correction P0-B: Flash heuristic 不再触发 plan_ready —— 普通
    // 执行任务直接继续（无 mandatory approval pause）。
    const events = await collect(harness.run(session.sessionId, {
      prompt: "Build a complete small service with package setup, API, and typecheck verification.",
      metadata: {},
    }))

    const planReadys = events.filter(e => "planReady" in e.payload)
    expect(planReadys).toHaveLength(0)
  })

  test("bridges clarification_ready into the clarification payload", async () => {
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
    const harness = createAgentHarness({
      deps: { provider: new ClarificationProvider(), tools: [] },
      sessionId: "sess-clar",
    })
    const session = await harness.createSession()
    const events = await collect(harness.run(session.sessionId, {
      prompt: "做一个全栈项目",
      metadata: {},
    }))

    const clarifications = events.filter(e => "clarification" in e.payload)
    expect(clarifications).toHaveLength(1)
    if (clarifications[0] && "clarification" in clarifications[0].payload) {
      expect(clarifications[0].payload.clarification.questions).toBeTruthy()
    }
  })

  test("bridges provider error events into the error payload", async () => {
    class ErrorProvider implements LLMProvider {
      async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
        yield { type: "error", data: "provider exploded" }
      }
    }
    const harness = createAgentHarness({
      deps: { provider: new ErrorProvider(), tools: [] },
      sessionId: "sess-err",
    })
    const session = await harness.createSession()
    const events = await collect(harness.run(session.sessionId, {
      prompt: "inspect",
      metadata: {},
    }))

    const errors = events.filter(e => "error" in e.payload)
    expect(errors.length).toBeGreaterThan(0)
    if (errors[0] && "error" in errors[0].payload) {
      expect(errors[0].payload.error).toContain("provider exploded")
    }
  })
})

describe("LegacyLoopAdapter adapter object", () => {
  test("createLegacyLoopAdapter returns a working execute", async () => {
    const adapter = createLegacyLoopAdapter({
      deps: { provider: new ProbeThenTextProvider(), tools: probeTool() },
    })
    const run = fakeRun("sess-2", { prompt: "Read only: probe. Do not edit." })
    const events = await collect(adapter.execute(run, run.input))
    expect(events.length).toBeGreaterThan(0)
    expect(events.some(e => "toolCall" in e.payload)).toBe(true)
  })
})
