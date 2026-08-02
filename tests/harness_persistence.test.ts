import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentHarness } from "../src/harness/runtime/agent-harness"
import { createFileHarnessStore } from "../src/harness/persistence/file-harness-store"
import { computeWorkspaceHash } from "../src/harness/persistence/workspace-hash"
import { restoreAgentRun } from "../src/harness/persistence/serialization"
import { setCurrentPlan } from "../src/agent/run/plan-store"
import type { HarnessEvent } from "../src/harness/contracts/events"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { buildTools, Result } from "../src/tools/registry"

// H6 acceptance: runs persist on terminal states, corrupt files are rejected,
// workspace hashes detect changes, and restored runs keep their completed
// state (no repeated irreversible work).

const SAVED_DEEPSEEK_FLASH_TRIAGE = process.env.DEEPSEEK_FLASH_TRIAGE
process.env.DEEPSEEK_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_DEEPSEEK_FLASH_TRIAGE === undefined) delete process.env.DEEPSEEK_FLASH_TRIAGE
  else process.env.DEEPSEEK_FLASH_TRIAGE = SAVED_DEEPSEEK_FLASH_TRIAGE
})

class ProbeThenTextProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "probe-1", name: "baseline_probe", input: {} } }
      return
    }
    yield { type: "text", data: "persist ok" }
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

describe("Harness H6 persistence", () => {
  test("terminal runs are saved to runs/ and snapshots/ via the store", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dscode-h6-"))
    try {
      const store = createFileHarnessStore({ root: join(cwd, ".deepseek-code", "harness") })
      const harness = createAgentHarness({
        deps: { provider: new ProbeThenTextProvider(), tools: probeTool() },
        sessionId: "sess-persist",
        projectRoot: cwd,
        store,
      })
      const session = await harness.createSession()
      const events: HarnessEvent[] = []
      for await (const event of harness.run(session.sessionId, { prompt: "Read only: probe. Do not edit.", metadata: {} })) {
        events.push(event)
      }
      const runId = events[0]!.runId

      const runsDir = join(cwd, ".deepseek-code", "harness", "runs")
      const snapshotsDir = join(cwd, ".deepseek-code", "harness", "snapshots")
      expect(readFileSync(join(runsDir, `${runId}.json`), "utf-8")).toContain('"status":"completed"')
      // Snapshot filename uses the run's final event sequence.
      const snapshotFiles = readdirSync(snapshotsDir).filter(f => f.startsWith(`${runId}-`))
      expect(snapshotFiles).toHaveLength(1)
      expect(readFileSync(join(snapshotsDir, snapshotFiles[0]!), "utf-8")).toContain('"completed"')

      // Historical inspect through the store (new harness instance).
      const harnessB = createAgentHarness({
        deps: { provider: new ProbeThenTextProvider(), tools: probeTool() },
        sessionId: "sess-persist",
        projectRoot: cwd,
        store,
      })
      const snapshot = await harnessB.inspect(runId)
      expect(snapshot.status).toBe("completed")
      expect(snapshot.outcome?.kind).toBe("completed")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("corrupt run files are rejected with null", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dscode-h6-corrupt-"))
    try {
      const store = createFileHarnessStore({ root: join(cwd, ".deepseek-code", "harness") })
      mkdirSync(join(cwd, ".deepseek-code", "harness", "runs"), { recursive: true })
      writeFileSync(join(cwd, ".deepseek-code", "harness", "runs", "run-bad.json"), "{not json")
      expect(await store.loadRun("run-bad")).toBeNull()
      expect(await store.loadRun("run-missing")).toBeNull()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("workspace hash is stable and detects changes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dscode-h6-hash-"))
    try {
      mkdirSync(join(cwd, "src"), { recursive: true })
      mkdirSync(join(cwd, "node_modules"), { recursive: true })
      writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1\n")
      writeFileSync(join(cwd, "node_modules", "x.js"), "ignored")
      const first = computeWorkspaceHash(cwd)
      const second = computeWorkspaceHash(cwd)
      expect(first).toBe(second)
      // node_modules excluded — touching it changes nothing.
      writeFileSync(join(cwd, "node_modules", "x.js"), "changed")
      expect(computeWorkspaceHash(cwd)).toBe(first)
      // A source change flips the hash.
      writeFileSync(join(cwd, "src", "a.ts"), "export const a = 2\n")
      expect(computeWorkspaceHash(cwd)).not.toBe(first)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("serialize/restore round-trip keeps outcome, status and done node states", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dscode-h6-restore-"))
    try {
      const store = createFileHarnessStore({ root: join(cwd, ".deepseek-code", "harness") })
      const harness = createAgentHarness({
        deps: { provider: new ProbeThenTextProvider(), tools: probeTool() },
        sessionId: "sess-restore",
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
      expect(serializable!.status).toBe("completed")
      expect(serializable!.outcome?.kind).toBe("completed")
      expect(serializable!.eventSequence).toBe(events.length)

      const restored = restoreAgentRun({ serializable: serializable!, projectRoot: cwd })
      expect(restored.status).toBe("completed")
      expect(restored.outcome?.kind).toBe("completed")
      expect(restored.eventSequence).toBe(events.length)
      expect(restored.scope.planStore.current).toBeNull()
      expect(restored.budget.used.modelCalls).toBeGreaterThanOrEqual(0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("restored runs preserve done plan nodes (no repeated work)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dscode-h6-plan-"))
    try {
      const store = createFileHarnessStore({ root: join(cwd, ".deepseek-code", "harness") })
      const harness = createAgentHarness({
        deps: { provider: new ProbeThenTextProvider(), tools: probeTool() },
        sessionId: "sess-plan",
        projectRoot: cwd,
        store,
      })
      const session = await harness.createSession()
      // Drive a run that activates a master plan with two nodes.
      const events: HarnessEvent[] = []
      for await (const event of harness.run(session.sessionId, { prompt: "Read only: probe. Do not edit.", metadata: {} })) {
        events.push(event)
      }
      const runId = events[0]!.runId
      const serializable = await store.loadRun(runId)
      expect(serializable).not.toBeNull()

      // Mark a node done in the serialized plan, then restore — the status
      // must survive.
      const serialized = serializable!
      serialized.planState = {
        goal: "test goal",
        intent: "long_task",
        current: "2",
        nodes: [
          { id: "1", title: "one", status: "done", dependsOn: [], blockedBy: [], reactCount: 0 },
          { id: "2", title: "two", status: "pending", dependsOn: ["1"], blockedBy: [], reactCount: 0 },
        ],
      }
      const restored = restoreAgentRun({ serializable: serialized, projectRoot: cwd })
      expect(restored.scope.planStore.current).not.toBeNull()
      expect(restored.scope.planStore.current!.nodes[0]!.status).toBe("done")
      expect(restored.scope.planStore.current!.current).toBe("2")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("serialized runs carry workspace hash and mode/budget projections", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dscode-h6-proj-"))
    try {
      const store = createFileHarnessStore({ root: join(cwd, ".deepseek-code", "harness") })
      const harness = createAgentHarness({
        deps: { provider: new ProbeThenTextProvider(), tools: probeTool() },
        sessionId: "sess-proj",
        projectRoot: cwd,
        store,
        workspaceHash: () => "fixed-hash",
      })
      const session = await harness.createSession()
      const events: HarnessEvent[] = []
      for await (const event of harness.run(session.sessionId, { prompt: "Read only: probe. Do not edit.", metadata: {} })) {
        events.push(event)
      }
      const runId = events[0]!.runId
      const serialized = await store.loadRun(runId)
      expect(serialized).not.toBeNull()
      expect(serialized!.workspaceHash).toBe("fixed-hash")
      expect(serialized!.modeState.mode).toBe("coder")
      expect(serialized!.budgetState.limits.maxModelCalls).toBeGreaterThan(0)
      // Projection is JSON-safe (no scope instances leak).
      expect(JSON.stringify(serialized)).not.toContain("AbortController")
      expect(JSON.stringify(serialized)).not.toContain("planStore")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
