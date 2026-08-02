import { afterAll, describe, expect, test } from "bun:test"
import { createAgentHarness } from "../src/harness/runtime/agent-harness"
import { setCurrentPlan } from "../src/agent/run/plan-store"
import type { HarnessEvent } from "../src/harness/contracts/events"
import { getActiveMode, setActiveMode } from "../src/agent/mode-contract"
import { getActivePatchContext, setActivePatchContext } from "../src/agent/patch-transaction"
import { getShellSandbox } from "../src/tools/shell"
import { requireRuntimeExecutionContext } from "../src/runtime/execution-context"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { buildTools, Result } from "../src/tools/registry"

// H3 acceptance: two mock runs driven in parallel never leak plan, mode,
// patch context, sandbox or cancellation state between each other, and each
// run's harness scope is the single source of truth (same instances the
// legacy kernel operates on — verified via in-run probes).

const SAVED_DEEPSEEK_FLASH_TRIAGE = process.env.DEEPSEEK_FLASH_TRIAGE
process.env.DEEPSEEK_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_DEEPSEEK_FLASH_TRIAGE === undefined) delete process.env.DEEPSEEK_FLASH_TRIAGE
  else process.env.DEEPSEEK_FLASH_TRIAGE = SAVED_DEEPSEEK_FLASH_TRIAGE
})

/** Round 0 tool call (probe), round 1 final text. */
class ProbeProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: `probe-${this.rounds}`, name: "run_probe", input: {} } }
      return
    }
    yield { type: "text", data: "isolated" }
  }
}

class HangProvider implements LLMProvider {
  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    yield { type: "status", data: "provider-ready" }
    await new Promise<void>(() => {})
  }
}

function probeTool(onExecute: () => void) {
  return buildTools({
    name: "run_probe",
    description: "Run-scope probe executed inside the run's ALS context",
    isReadonly: true,
    isConcurrencySafe: true,
    inputSchema: { type: "object", properties: {}, required: [] },
    execute() {
      onExecute()
      return Result.ok("probe-ok")
    },
  })
}

async function collect(iterable: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

describe("Harness H3 run isolation", () => {
  test("parallel runs keep kernel planStore/sandbox separate; plan writes reflect in own snapshot", async () => {
    const seen: Array<{ plan: unknown; sandbox: unknown }> = []
    const makeDeps = () => ({
      provider: new ProbeProvider(),
      tools: probeTool(() => {
        seen.push({
          plan: requireRuntimeExecutionContext().planStore,
          sandbox: getShellSandbox(),
        })
        // Write into this run's plan store — the harness snapshot must see it.
        setCurrentPlan(requireRuntimeExecutionContext().planStore, {
          goal: `plan-${seen.length}`,
          nodes: [{ id: "n1", title: "t", status: "pending", blockedBy: [], dependsOn: [] }],
          _lastValidation: null,
        } as never)
      }),
    })
    const harness = createAgentHarness({ deps: makeDeps(), sessionId: "sess-iso-a" })
    const harnessB = createAgentHarness({ deps: makeDeps(), sessionId: "sess-iso-b" })
    const sessionA = await harness.createSession()
    const sessionB = await harnessB.createSession()

    const [eventsA, eventsB] = await Promise.all([
      collect(harness.run(sessionA.sessionId, { prompt: "Read only: probe A. Do not edit.", metadata: {} })),
      collect(harnessB.run(sessionB.sessionId, { prompt: "Read only: probe B. Do not edit.", metadata: {} })),
    ])
    expect(eventsA.length).toBeGreaterThan(0)
    expect(eventsB.length).toBeGreaterThan(0)
    expect(seen).toHaveLength(2)

    // Kernel-level isolation: different planStore and sandbox instances.
    expect(seen[0]!.plan).not.toBe(seen[1]!.plan)
    expect(seen[0]!.sandbox).not.toBe(seen[1]!.sandbox)

    // Harness-level: each snapshot reflects only its own run's plan writes.
    const snapshotA = await harness.inspect(eventsA[0]!.runId)
    const snapshotB = await harnessB.inspect(eventsB[0]!.runId)
    expect((snapshotA.planState as { goal: string }).goal).toBe("plan-1")
    expect((snapshotB.planState as { goal: string }).goal).toBe("plan-2")
  })

  test("mode changes in run A do not leak into run B (ALS per-run isolation)", async () => {
    const harness = createAgentHarness({
      deps: {
        provider: new ProbeProvider(),
        tools: probeTool(() => {
          setActiveMode("planner")
        }),
      },
      sessionId: "sess-mode-a",
    })
    let bModeInsideRun = ""
    const harnessB = createAgentHarness({
      deps: {
        provider: new ProbeProvider(),
        tools: probeTool(() => {
          // B's own ALS context: must still see the initial mode.
          bModeInsideRun = getActiveMode().mode
        }),
      },
      sessionId: "sess-mode-b",
    })
    const sessionA = await harness.createSession()
    const sessionB = await harnessB.createSession()
    const [, eventsB] = await Promise.all([
      collect(harness.run(sessionA.sessionId, { prompt: "Read only: probe A. Do not edit.", metadata: {} })),
      collect(harnessB.run(sessionB.sessionId, { prompt: "Read only: probe B. Do not edit.", metadata: {} })),
    ])

    expect(bModeInsideRun).toBe("coder")
    const snapshotB = await harnessB.inspect(eventsB[0]!.runId)
    expect((snapshotB.modeState as { mode: string }).mode).toBe("coder")
  })

  test("patch context set in run A stays null in run B", async () => {
    const harness = createAgentHarness({
      deps: {
        provider: new ProbeProvider(),
        tools: probeTool(() => {
          setActivePatchContext({ scope: ["src/a.ts"], verification: ["typecheck"], nodeId: "n1" })
        }),
      },
      sessionId: "sess-patch-a",
    })
    let bPatchInsideRun: unknown = "unset"
    const harnessB = createAgentHarness({
      deps: {
        provider: new ProbeProvider(),
        tools: probeTool(() => {
          bPatchInsideRun = getActivePatchContext()
        }),
      },
      sessionId: "sess-patch-b",
    })
    const sessionA = await harness.createSession()
    const sessionB = await harnessB.createSession()
    await Promise.all([
      collect(harness.run(sessionA.sessionId, { prompt: "Read only: probe A. Do not edit.", metadata: {} })),
      collect(harnessB.run(sessionB.sessionId, { prompt: "Read only: probe B. Do not edit.", metadata: {} })),
    ])

    expect(bPatchInsideRun).toBeNull()
  })

  test("cancelling run A does not affect run B", async () => {
    const harness = createAgentHarness({
      deps: { provider: new HangProvider(), tools: [] },
      sessionId: "sess-cancel-a",
    })
    const harnessB = createAgentHarness({
      deps: { provider: new ProbeProvider(), tools: probeTool(() => {}) },
      sessionId: "sess-cancel-b",
    })
    const sessionA = await harness.createSession()
    const sessionB = await harnessB.createSession()

    const iteratorA = harness.run(sessionA.sessionId, { prompt: "inspect", metadata: {} })[Symbol.asyncIterator]()
    const firstA = await iteratorA.next()
    const runIdA = firstA.value.runId
    let ready = false
    while (!ready) {
      const step = await iteratorA.next()
      if (step.done) break
      const payload = step.value.payload
      if ("display" in payload && payload.display.data === "provider-ready") ready = true
    }
    await harness.cancel(runIdA, "cancel A")

    // B runs to completion unaffected.
    const eventsB = await collect(harnessB.run(sessionB.sessionId, { prompt: "Read only: probe B. Do not edit.", metadata: {} }))
    const snapshotB = await harnessB.inspect(eventsB[0]!.runId)
    expect(snapshotB.status).toBe("completed")

    // Drain A to its cancelled terminal.
    while (true) {
      const step = await iteratorA.next()
      if (step.done) break
    }
    const snapshotA = await harness.inspect(runIdA)
    expect(snapshotA.status).toBe("cancelled")
    expect(snapshotA.outcome?.kind).toBe("cancelled")
  })
})
