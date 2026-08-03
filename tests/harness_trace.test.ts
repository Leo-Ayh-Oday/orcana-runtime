import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentHarness } from "../src/harness/runtime/agent-harness"
import { createJsonlTraceWriter } from "../src/harness/telemetry/trace-writer"
import { migrateLegacyTrace, migrateLegacyTraceLine } from "../src/harness/telemetry/migration"
import type { EventEnvelope, HarnessEvent } from "../src/harness/contracts/events"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { buildTools, Result } from "../src/tools/registry"

// H5 acceptance: typed trace envelopes land on disk with continuous sequence,
// legacy traces migrate through shared types, secrets are redacted, and a
// failing trace write never fails the run.

const SAVED_ORCANA_FLASH_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
process.env.ORCANA_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_ORCANA_FLASH_TRIAGE === undefined) delete process.env.ORCANA_FLASH_TRIAGE
  else process.env.ORCANA_FLASH_TRIAGE = SAVED_ORCANA_FLASH_TRIAGE
})

class ProbeThenTextProvider implements LLMProvider {
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

function readEnvelopes(file: string): Array<EventEnvelope<unknown>> {
  return readFileSync(file, "utf-8").trim().split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as EventEnvelope<unknown>)
}

describe("Harness H5 typed trace", () => {
  test("a run writes continuous typed envelopes to harness events JSONL", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dscode-h5-"))
    try {
      const harness = createAgentHarness({
        deps: { provider: new ProbeThenTextProvider(), tools: probeTool() },
        sessionId: "sess-trace",
        projectRoot: cwd,
      })
      const session = await harness.createSession()
      const events: HarnessEvent[] = []
      for await (const event of harness.run(session.sessionId, { prompt: "Read only: probe. Do not edit.", metadata: {} })) {
        events.push(event)
      }
      const runId = events[0]!.runId
      const file = join(cwd, ".orcana", "harness", "events", `${runId}.jsonl`)
      const envelopes = readEnvelopes(file)

      expect(envelopes.length).toBeGreaterThan(0)
      expect(envelopes.length).toBe(events.length)
      for (let i = 0; i < envelopes.length; i++) {
        expect(envelopes[i]!.schemaVersion).toBe(1)
        expect(envelopes[i]!.runId).toBe(runId)
        expect(envelopes[i]!.sessionId).toBe("sess-trace")
        expect(envelopes[i]!.sequence).toBe(i + 1)
        expect(envelopes[i]!.timestamp).toBeTruthy()
        // Same order as the emitted stream.
        expect(envelopes[i]!.type).toBe(events[i]!.type)
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("payload secrets are redacted on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dscode-h5-redact-"))
    try {
      const writer = createJsonlTraceWriter({ dir, runId: "run-r", sessionId: "sess-r" })
      await writer.append({
        schemaVersion: 1,
        eventId: "e-1",
        sequence: 1,
        runId: "run-r",
        sessionId: "sess-r",
        type: "test.event",
        timestamp: new Date().toISOString(),
        payload: { apiKey: "sk-secret-123", token: "tok", keep: "visible" },
      })
      await writer.flush()
      const line = readFileSync(join(dir, "run-r.jsonl"), "utf-8")
      expect(line).toContain("[redacted]")
      expect(line).not.toContain("sk-secret-123")
      expect(line).toContain("visible")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a failing trace write never fails the run", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dscode-h5-fail-"))
    try {
      // Make the events directory a file so mkdir/append fails silently.
      mkdirSync(join(cwd, ".orcana", "harness"), { recursive: true })
      writeFileSync(join(cwd, ".orcana", "harness", "events"), "blocked")
      const harness = createAgentHarness({
        deps: { provider: new ProbeThenTextProvider(), tools: probeTool() },
        sessionId: "sess-trace-fail",
        projectRoot: cwd,
      })
      const session = await harness.createSession()
      const events: HarnessEvent[] = []
      for await (const event of harness.run(session.sessionId, { prompt: "Read only: probe. Do not edit.", metadata: {} })) {
        events.push(event)
      }
      const snapshot = await harness.inspect(events[0]!.runId)
      expect(snapshot.status).toBe("completed")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("migrateLegacyTraceLine converts legacy kernel lines into envelopes", () => {
    const line = JSON.stringify({ runId: "run_x", timestamp: "2026-08-02T00:00:00Z", type: "gate_decision", data: { gate: "ripple", decision: "continue" } })
    const envelope = migrateLegacyTraceLine(line)
    expect(envelope).not.toBeNull()
    expect(envelope!.type).toBe("gate_decision")
    expect(envelope!.schemaVersion).toBe(1)
    expect((envelope!.payload as { legacy: unknown }).legacy).toEqual({ gate: "ripple", decision: "continue" })
    expect(envelope!.runId).toBe("run_x")

    expect(migrateLegacyTraceLine("not json")).toBeNull()
    expect(migrateLegacyTraceLine('{"no":"type"}')).toBeNull()
  })

  test("migrateLegacyTrace migrates whole files with ordered sequences", () => {
    const text = [
      JSON.stringify({ runId: "run_y", type: "a", data: { n: 1 } }),
      "garbage line",
      JSON.stringify({ runId: "run_y", type: "b", data: { n: 2 } }),
    ].join("\n")
    const envelopes = migrateLegacyTrace(text)
    expect(envelopes).toHaveLength(2)
    expect(envelopes[0]!.type).toBe("a")
    expect(envelopes[1]!.type).toBe("b")
    expect(envelopes[0]!.sequence).toBe(1)
    expect(envelopes[1]!.sequence).toBe(2)
  })

  test("trace writer flush/close are idempotent and safe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dscode-h5-close-"))
    try {
      const writer = createJsonlTraceWriter({ dir, runId: "run-c", sessionId: "sess-c" })
      const envelope = {
        schemaVersion: 1 as const,
        eventId: "e-1",
        sequence: 1,
        runId: "run-c",
        sessionId: "sess-c",
        type: "run.started",
        timestamp: new Date().toISOString(),
        payload: { status: "running" },
      }
      await writer.append(envelope)
      await writer.flush()
      await writer.flush()
      await writer.close()
      await writer.close()
      await writer.append(envelope) // after close: no-op
      const lines = readFileSync(join(dir, "run-c.jsonl"), "utf-8").trim().split("\n")
      expect(lines).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
