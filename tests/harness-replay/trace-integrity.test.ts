import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentHarness } from "../../src/harness/runtime/agent-harness"
import { createJsonlTraceWriter } from "../../src/harness/telemetry/trace-writer"
import { createNoopTraceWriter } from "../../src/harness/runtime/run-scope"
import { createFileHarnessStore } from "../../src/harness/persistence/file-harness-store"
import type { HarnessEvent } from "../../src/harness/contracts/events"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../../src/provider/types"
import { buildTools, Result } from "../../src/tools/registry"

// G0-2: trace write failures are counted and surfaced (fail-loud), never
// silent; restore surfaces a missing/incomplete audit stream as a warning.

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
    yield { type: "text", data: "trace ok" }
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

describe("G0-2 trace write failure policy", () => {
  test("failed batch writes are counted and surfaced via onWriteFailure, run still completes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "g02-fail-"))
    try {
      // Block the events dir so every batch write fails.
      mkdirSync(join(cwd, ".orcana", "harness"), { recursive: true })
      writeFileSync(join(cwd, ".orcana", "harness", "events"), "blocked")
      const failures: Array<{ runId: string; batchSize: number }> = []
      const harness = createAgentHarness({
        deps: { provider: new ProbeProvider(), tools: probeTool() },
        sessionId: "sess-g02-fail",
        projectRoot: cwd,
        onTraceWriteFailure: (info) => failures.push(info),
      })
      const session = await harness.createSession()
      const events: HarnessEvent[] = []
      for await (const event of harness.run(session.sessionId, { prompt: "Read only: probe. Do not edit.", metadata: {} })) {
        events.push(event)
      }
      const snapshot = await harness.inspect(events[0]!.runId)
      // The run must still complete (audit stream never fails the run)…
      expect(snapshot.status).toBe("completed")
      // …but the failure is fail-loud: the writer counted it and the observer saw it.
      expect(failures.length).toBeGreaterThan(0)
      expect(failures[0]!.runId).toBe(events[0]!.runId)
      expect(failures[0]!.batchSize).toBeGreaterThan(0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("healthy writer reports zero failures and no pending events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g02-ok-"))
    try {
      const writer = createJsonlTraceWriter({ dir, runId: "run-g02", sessionId: "sess-g02" })
      expect(writer.writeFailures()).toBe(0)
      expect(writer.pendingEvents()).toBe(0)
      await writer.append({ schemaVersion: 1, eventId: "e1", sequence: 1, runId: "run-g02", sessionId: "sess-g02", type: "run.started", timestamp: new Date().toISOString(), payload: {} } as never)
      await writer.flush()
      expect(writer.writeFailures()).toBe(0)
      expect(writer.pendingEvents()).toBe(0)
      await writer.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("noop trace writer exposes the G0-2 counters", () => {
    const writer = createNoopTraceWriter()
    expect(writer.writeFailures()).toBe(0)
    expect(writer.pendingEvents()).toBe(0)
  })
})

describe("G0-2 restore trace integrity check", () => {
  test("complete run: store reports full event stream, no warning", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "g02-integrity-"))
    try {
      const store = createFileHarnessStore({ root: join(cwd, ".orcana", "harness") })
      const harness = createAgentHarness({
        deps: { provider: new ProbeProvider(), tools: probeTool() },
        sessionId: "sess-g02-int",
        projectRoot: cwd,
        store,
      })
      const session = await harness.createSession()
      const events: HarnessEvent[] = []
      for await (const event of harness.run(session.sessionId, { prompt: "Read only: probe. Do not edit.", metadata: {} })) {
        events.push(event)
      }
      const runId = events[0]!.runId
      const serializable = await store.loadRun(runId)
      expect(serializable).not.toBeNull()
      const integrity = await store.traceIntegrity(runId)
      expect(integrity.eventFileExists).toBe(true)
      expect(integrity.eventCount).toBe(serializable!.eventSequence)
      expect(integrity.eventCount).toBeGreaterThan(0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("deleted event file: restore warns about the missing audit stream", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "g02-warn-"))
    try {
      const store = createFileHarnessStore({ root: join(cwd, ".orcana", "harness") })
      const harness = createAgentHarness({
        deps: { provider: new ProbeProvider(), tools: probeTool() },
        sessionId: "sess-g02-warn",
        projectRoot: cwd,
        store,
      })
      const session = await harness.createSession()
      const events: HarnessEvent[] = []
      for await (const event of harness.run(session.sessionId, { prompt: "Read only: probe. Do not edit.", metadata: {} })) {
        events.push(event)
      }
      const runId = events[0]!.runId
      rmSync(join(cwd, ".orcana", "harness", "events"), { recursive: true, force: true })

      // Fresh harness (no in-memory registry) → inspect falls back to the store.
      const warns: string[] = []
      const originalWarn = console.warn
      console.warn = (msg: unknown) => warns.push(String(msg))
      try {
        const harness2 = createAgentHarness({
          deps: { provider: new ProbeProvider(), tools: probeTool() },
          sessionId: "sess-g02-warn",
          projectRoot: cwd,
          store,
        })
        const snapshot = await harness2.inspect(runId)
        expect(snapshot.runId).toBe(runId)
        // Restore itself succeeds (run state is the restore source)…
        expect(snapshot.status).toBe("completed")
      } finally {
        console.warn = originalWarn
      }
      // …but the audit-stream gap is surfaced, never silent.
      expect(warns.some((w) => w.includes("trace integrity") && w.includes(runId))).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
