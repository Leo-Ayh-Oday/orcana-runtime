import { afterAll, describe, expect, test } from "bun:test"
import { createAgentHarness } from "../src/harness/runtime/agent-harness"
import { assembleRunScope, createNoopTraceWriter } from "../src/harness/runtime/run-scope"
import { createRunCancellation } from "../src/harness/runtime/cancellation"
import { createPlanStore, setCurrentPlan } from "../src/agent/run/plan-store"
import { SandboxManager } from "../src/sandbox/sandbox"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { buildTools, Result } from "../src/tools/registry"

// H3: the typed AgentRunScope — real owners, cancellation bridging, no-op
// trace, and serializable inspect snapshots.

const SAVED_ORCANA_FLASH_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
process.env.ORCANA_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_ORCANA_FLASH_TRIAGE === undefined) delete process.env.ORCANA_FLASH_TRIAGE
  else process.env.ORCANA_FLASH_TRIAGE = SAVED_ORCANA_FLASH_TRIAGE
})

class ProbeProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "probe-1", name: "baseline_probe", input: {} } }
      return
    }
    yield { type: "text", data: "scope ok" }
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

describe("Harness H3 typed run scope", () => {
  test("assembleRunScope builds real typed owners", () => {
    const controller = new AbortController()
    const scope = assembleRunScope({
      runId: "run-s-1",
      sessionId: "sess-s",
      projectRoot: process.cwd(),
      controller,
      activeMode: "planner",
    })

    expect(scope.planStore).toBeInstanceOf(Object)
    expect(scope.planStore.current).toBeNull()
    expect(scope.modeStore.mode).toBe("planner")
    expect(scope.patchContext).toBeNull()
    expect(scope.sandbox).toBeInstanceOf(SandboxManager)
    expect(scope.rippleSession.obligations).toEqual([])
    expect(scope.evidenceLedger.entries).toEqual([])
    expect(scope.cancellation.signal).toBe(controller.signal)
    expect(scope.cancellation.cancelled).toBe(false)
  })

  test("run cancellation bridges cancel() into the signal", async () => {
    const controller = new AbortController()
    const cancellation = createRunCancellation(controller)
    cancellation.cancel("user cancel")
    expect(cancellation.cancelled).toBe(true)
    expect(cancellation.reason).toBe("user cancel")
    expect(controller.signal.aborted).toBe(true)
    expect(() => cancellation.throwIfCancelled()).toThrow(/user cancel/)
  })

  test("no-op trace writer never throws", async () => {
    const trace = createNoopTraceWriter()
    await trace.append({
      schemaVersion: 1,
      eventId: "e-1",
      sequence: 1,
      runId: "run-s-1",
      sessionId: "sess-s",
      type: "run.started",
      timestamp: new Date().toISOString(),
      payload: { status: "running" },
    })
    await trace.flush()
    await trace.close()
  })

  test("inspect exposes serializable plan/mode snapshots from the run scope", async () => {
    const harness = createAgentHarness({
      deps: { provider: new ProbeProvider(), tools: probeTool() },
      sessionId: "sess-inspect3",
    })
    const session = await harness.createSession()
    const events: Array<{ runId: string }> = []
    for await (const event of harness.run(session.sessionId, { prompt: "Read only: probe. Do not edit.", metadata: {} })) {
      events.push(event)
    }
    const snapshot = await harness.inspect(events[0]!.runId)

    expect((snapshot.planState as { revision: number }).revision).toBe(0)
    expect((snapshot.modeState as { mode: string }).mode).toBe("coder")
    // H4: budget snapshot carries limits/used/remaining.
    const budget = snapshot.budgetState as { limits: { maxModelCalls: number }; used: { modelCalls: number }; remaining: { modelCalls: number } }
    expect(budget.limits.maxModelCalls).toBeGreaterThan(0)
    expect(budget.used.modelCalls).toBeGreaterThanOrEqual(0)
    expect(budget.remaining.modelCalls).toBeGreaterThanOrEqual(0)
    // H8: evidence state carries the serialized ledger entries (array).
    expect((snapshot.evidenceState as { entries: unknown[] }).entries).toBeInstanceOf(Array)
    expect(snapshot.artifactRefs).toBeInstanceOf(Array)
  })

  test("plan store is a live single owner (setCurrentPlan reflects in inspect)", async () => {
    const planStore = createPlanStore()
    setCurrentPlan(planStore, {
      goal: "test goal",
      nodes: [{ id: "n1", title: "node", status: "pending", blockedBy: [], dependsOn: [] }],
      _lastValidation: null,
    } as never)
    expect(planStore.revision).toBe(1)
    expect(planStore.current?.goal).toBe("test goal")
  })
})
