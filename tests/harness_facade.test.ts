import { afterAll, describe, expect, test } from "bun:test"
import { createAgentHarness } from "../src/harness/runtime/agent-harness"
import { HarnessError } from "../src/harness/contracts/errors"
import type { HarnessEvent } from "../src/harness/contracts/events"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { buildTools, Result } from "../src/tools/registry"

// H1 facade coverage: the single production entry — sessions, run lifecycle
// (created → running → terminal), cancel bridging, inspect snapshots, and the
// H7-placeholder resume.

const SAVED_DEEPSEEK_FLASH_TRIAGE = process.env.DEEPSEEK_FLASH_TRIAGE
process.env.DEEPSEEK_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_DEEPSEEK_FLASH_TRIAGE === undefined) delete process.env.DEEPSEEK_FLASH_TRIAGE
  else process.env.DEEPSEEK_FLASH_TRIAGE = SAVED_DEEPSEEK_FLASH_TRIAGE
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
    yield { type: "text", data: "H1 facade final." }
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

async function collect(iterable: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

describe("AgentHarness facade (H1)", () => {
  test("runs a full turn through the facade and completes with final text once", async () => {
    const harness = createAgentHarness({
      deps: { provider: new ProbeThenTextProvider(), tools: probeTool() },
      sessionId: "sess-full",
    })
    const session = await harness.createSession()
    expect(session.sessionId).toBe("sess-full")
    expect(session.projectRoot).toBeTruthy()

    const events = await collect(harness.run(session.sessionId, {
      prompt: "Read only: probe and summarize. Do not edit.",
      metadata: {},
    }))

    const texts = events.filter(e => "text" in e.payload)
    expect(texts).toHaveLength(1)
    if (texts[0] && "text" in texts[0].payload) {
      expect(texts[0].payload.text).toBe("H1 facade final.")
    }
    // All events carry the run id (usable for cancel/inspect).
    const runIds = new Set(events.map(e => e.runId))
    expect(runIds.size).toBe(1)
    const runId = [...runIds][0]!
    const snapshot = await harness.inspect(runId)
    expect(snapshot.status).toBe("completed")
    expect(snapshot.runId).toBe(runId)
    expect(snapshot.sessionId).toBe("sess-full")
  })

  test("cancel aborts the provider and marks the run cancelled", async () => {
    const provider = new AbortAwareProvider()
    const harness = createAgentHarness({
      deps: { provider, tools: [] },
      sessionId: "sess-cancel",
    })
    const session = await harness.createSession()
    const iterator = harness.run(session.sessionId, { prompt: "inspect", metadata: {} })[Symbol.asyncIterator]()

    let runId: string | undefined
    const first = await iterator.next()
    expect(first.done).toBe(false)
    runId = first.value.runId
    // Drain until provider-ready display event, then cancel.
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
    expect(provider.aborted).toBe(false)

    await harness.cancel(runId!, "test cancel")
    // Drain to completion — the run should end and be cancelled.
    let drained = 0
    while (true) {
      const step = await iterator.next()
      if (step.done) break
      drained++
    }
    expect(drained).toBeGreaterThanOrEqual(0)
    expect(provider.aborted).toBe(true)
    const snapshot = await harness.inspect(runId!)
    expect(snapshot.status).toBe("cancelled")
  })

  test("inspect throws RunNotFoundError for unknown runs", async () => {
    const harness = createAgentHarness({
      deps: { provider: new ProbeThenTextProvider(), tools: probeTool() },
      sessionId: "sess-inspect",
    })
    await expect(harness.inspect("no-such-run")).rejects.toThrow(HarnessError)
  })

  test("resume is a loud placeholder until H7", async () => {
    const harness = createAgentHarness({
      deps: { provider: new ProbeThenTextProvider(), tools: probeTool() },
      sessionId: "sess-resume",
    })
    await expect(async () => {
      for await (const _ev of harness.resume("run-1", { interruptId: "i-1", response: {} } as never)) {
        // no-op
      }
    }).toThrow(/H7/)
  })

  test("multiple runs on one session are tracked independently", async () => {
    const harness = createAgentHarness({
      deps: { provider: new ProbeThenTextProvider(), tools: probeTool() },
      sessionId: "sess-multi",
    })
    const session = await harness.createSession()
    const first = await collect(harness.run(session.sessionId, {
      prompt: "Read only: probe one. Do not edit.",
      metadata: {},
    }))
    const second = await collect(harness.run(session.sessionId, {
      prompt: "Read only: probe two. Do not edit.",
      metadata: {},
    }))
    const firstRunId = first[0]!.runId
    const secondRunId = second[0]!.runId
    expect(firstRunId).not.toBe(secondRunId)
    expect(await (await harness.inspect(firstRunId)).status).toBe("completed")
    expect(await (await harness.inspect(secondRunId)).status).toBe("completed")
    const sessionAfter = (await harness.createSession())
    expect(sessionAfter.sessionId).toBe("sess-multi")
  })
})
