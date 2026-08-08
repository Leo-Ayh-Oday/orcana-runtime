import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createArtifactStore } from "../../src/harness/artifacts/artifact-store"
import { putPatchArtifact } from "../../src/harness/artifacts/evidence-adapter"
import { serializeRun, restoreAgentRun } from "../../src/harness/persistence/serialization"
import { createFileHarnessStore } from "../../src/harness/persistence/file-harness-store"
import { createRetryLedger } from "../../src/runtime/retry-ledger"
import { createAgentHarness } from "../../src/harness/runtime/agent-harness"
import type { AgentRun } from "../../src/harness/contracts/run"
import type { HarnessEvent } from "../../src/harness/contracts/events"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../../src/provider/types"
import { buildTools, Result } from "../../src/tools/registry"

// G0-3: artifact entities + content persist with the run and restore readably —
// a restored run can prove its evidence chain (was "content is not restored, refs are").

const SAVED_ORCANA_FLASH_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
process.env.ORCANA_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_ORCANA_FLASH_TRIAGE === undefined) delete process.env.ORCANA_FLASH_TRIAGE
  else process.env.ORCANA_FLASH_TRIAGE = SAVED_ORCANA_FLASH_TRIAGE
})

/** Minimal run — scope only (serializeRun needs nothing else). */
function minimalRun(projectRoot: string): AgentRun {
  return {
    runId: "run-g03",
    sessionId: "sess-g03",
    status: "completed",
    input: { prompt: "x", metadata: {} },
    scope: {
      runId: "run-g03",
      sessionId: "sess-g03",
      projectRoot,
      planStore: { current: null, revision: 0 } as never,
      modeStore: { mode: "coder" } as never,
      patchContext: null,
      sandbox: null as never,
      rippleSession: { obligations: [], cascadeFiles: [] },
      evidenceLedger: { entries: [] } as never,
      artifactStore: createArtifactStore(),
      cancellation: {} as never,
      trace: { append: async () => {}, flush: async () => {}, close: async () => {}, writeFailures: () => 0, pendingEvents: () => 0 },
      retryLedger: createRetryLedger(),
    },
    budget: { limits: {}, used: { modelCalls: 0, toolCalls: 0, tokens: 0 }, remaining: () => 0 } as never,
    createdAt: 1,
    eventSequence: 5,
    schemaVersion: 1,
  }
}

describe("G0-3 artifact persistence round-trip", () => {
  test("serialize → restore keeps artifact metadata AND content readable", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "g03-serde-"))
    try {
      const run = minimalRun(cwd)
      // Produce a patch artifact with real content.
      const patch = await putPatchArtifact({
        store: run.scope.artifactStore,
        runId: run.runId,
        txId: "tx-1",
        diff: "--- a\n+++ b\n+added line\n",
        files: ["b"],
        producedBy: "test",
      })
      const serialized = serializeRun({
        run,
        artifactRefs: [patch.artifactId],
        artifactState: {
          artifacts: await run.scope.artifactStore.entries(),
          contents: [{ ref: patch.contentRef, value: "--- a\n+++ b\n+added line\n" }],
        },
      })
      expect(serialized.artifactState!.artifacts).toHaveLength(1)
      expect(serialized.artifactState!.contents).toHaveLength(1)

      const restored = restoreAgentRun({ serializable: serialized, projectRoot: cwd })
      const artifact = await restored.scope.artifactStore.get(patch.artifactId)
      expect(artifact).not.toBeNull()
      expect(artifact!.kind).toBe("patch")
      expect(artifact!.txId).toBe("tx-1")
      // G0-3: the content is readable after restore — not just the ref.
      const content = await restored.scope.artifactStore.getContent(patch.contentRef)
      expect(content).toBe("--- a\n+++ b\n+added line\n")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("old files without artifactState hydrate an empty store (no crash)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "g03-old-"))
    try {
      const serialized = serializeRun({ run: minimalRun(cwd) })
      delete (serialized as { artifactState?: unknown }).artifactState // simulate pre-G0-3 file
      const restored = restoreAgentRun({ serializable: serialized, projectRoot: cwd })
      expect(await restored.scope.artifactStore.entries()).toEqual([])
      expect(await restored.scope.artifactStore.getContent("content:missing")).toBeNull()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

// ── End-to-end: a real run persists artifacts and a restored inspect can read them ──
// Writing a .ts file triggers the batch typecheck, which ingests a
// typecheck_result artifact (content = tsc output) into the run's store.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

class WriteTsThenDoneProvider implements LLMProvider {
  rounds = 0
  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      // Name must be write_file/edit_file/edit_fim for the batch executor to
      // record it in modifiedFilesThisRound → batch typecheck → artifact.
      yield { type: "tool_call", data: { id: "w-1", name: "write_file", input: { path: "src/a.ts", content: "export const a: number = 1\n" } } }
      return
    }
    yield { type: "text", data: "done" }
  }
}

function writeTsTool(projectRoot: string) {
  return buildTools({
    name: "write_file",
    description: "write a file",
    isReadonly: false,
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    execute(params) {
      const target = join(projectRoot, String(params["path"]))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, String(params["content"]), "utf-8")
      return Result.ok(`wrote ${params["path"]}`)
    },
  })
}

describe("G0-3 persisted run restores artifact content end-to-end", () => {
  // The batch typecheck runs a real tsc over the repo root (~seconds).
  // Real tsc over the repo root takes seconds — widen the window (bun default 5s).
  test("saveRun stores artifactState; historical inspect reads content", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "g03-e2e-"))
    try {
      const store = createFileHarnessStore({ root: join(cwd, ".orcana", "harness") })
      const harness = createAgentHarness({
        deps: { provider: new WriteTsThenDoneProvider(), tools: writeTsTool(cwd) },
        sessionId: "sess-g03-e2e",
        projectRoot: cwd,
        store,
      })
      const session = await harness.createSession()
      const events: HarnessEvent[] = []
      for await (const event of harness.run(session.sessionId, { prompt: "write a file then summarize", maxRounds: 2, metadata: {} })) {
        events.push(event)
      }
      const runId = events[0]!.runId

      const serializable = await store.loadRun(runId)
      expect(serializable).not.toBeNull()
      expect(serializable!.artifactRefs.length).toBeGreaterThan(0)
      // G0-3: artifact content persisted with the run.
      expect(serializable!.artifactState).toBeDefined()
      expect(serializable!.artifactState!.artifacts.length).toBeGreaterThan(0)
      expect(serializable!.artifactState!.contents.length).toBeGreaterThan(0)
      // Every artifact's contentRef resolves inside the persisted content map
      // (tsc may be unavailable in the sandbox — the value is then "").
      for (const artifact of serializable!.artifactState!.artifacts) {
        const entry = serializable!.artifactState!.contents.find((c) => c.ref === artifact.contentRef)
        expect(entry).toBeDefined()
        expect(typeof entry!.value).toBe("string")
      }

      // Historical restore (fresh harness, no in-memory registry) brings back
      // the artifact entities AND their content.
      const restored = restoreAgentRun({ serializable: serializable!, projectRoot: cwd })
      const ref = serializable!.artifactRefs[0]!
      const artifact = await restored.scope.artifactStore.get(ref)
      expect(artifact).not.toBeNull()
      // G0-3: the content is READABLE after restore — resolved by the same
      // hash ref the artifact carries (was: refs only, getContent → null).
      const content = await restored.scope.artifactStore.getContent(artifact!.contentRef)
      expect(content).not.toBeNull()
      // inspect still works on the restored path (no crash, status intact).
      // NOTE: the write-then-claim run ends blocked under G0-4 (write without
      // verification evidence) — the artifact persistence is what's under test.
      const harness2 = createAgentHarness({
        deps: { provider: new WriteTsThenDoneProvider(), tools: writeTsTool(cwd) },
        sessionId: "sess-g03-e2e",
        projectRoot: cwd,
        store,
      })
      const snapshot = await harness2.inspect(runId)
      expect(["blocked", "completed"]).toContain(snapshot.status)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 60_000)
})
