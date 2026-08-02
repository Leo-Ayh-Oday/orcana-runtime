import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentHarness } from "../src/harness/runtime/agent-harness"
import { createFileHarnessStore } from "../src/harness/persistence/file-harness-store"
import { computeWorkspaceHash } from "../src/harness/persistence/workspace-hash"
import { HarnessError } from "../src/harness/contracts/errors"
import type { HarnessEvent } from "../src/harness/contracts/events"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { buildTools, Result } from "../src/tools/registry"

// H7 acceptance: plan approval and clarification become persistent waits —
// resume validates (idempotent, schema, workspace), rejection is a formal
// branch, cross-instance resume works, and waiting runs hold no resources.

const SAVED_DEEPSEEK_FLASH_TRIAGE = process.env.DEEPSEEK_FLASH_TRIAGE
process.env.DEEPSEEK_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_DEEPSEEK_FLASH_TRIAGE === undefined) delete process.env.DEEPSEEK_FLASH_TRIAGE
  else process.env.DEEPSEEK_FLASH_TRIAGE = SAVED_DEEPSEEK_FLASH_TRIAGE
})

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

class PlanProvider implements LLMProvider {
  rounds = 0

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (options.purpose === "flash_triage") {
      yield {
        type: "text",
        data: JSON.stringify({
          mode: "full_complex",
          needsWeb: false,
          researchQueries: [],
          relevantSkillNames: [],
          planSteps: [
            { id: "foundation", title: "Create project foundation", deliverables: ["package.json"], verification: "typecheck" },
          ],
          requiredVerification: ["typecheck"],
          reasoning: "plan approval required",
          riskLevel: "medium",
        }),
      }
      return
    }
    const round = this.rounds++
    if (round === 0) {
      yield {
        type: "text",
        data: [
          "Problem model: build a complete small service.",
          "Assumptions and uncertainty: the repo may be empty.",
          "Risk and counter-argument: keep the first deliverable small.",
          "Selected approach: Bun TypeScript API.",
          "Execution checklist:",
          "- Create package.json and tsconfig.json.",
          "- Create server/index.ts.",
          "- Run external verification: bun run typecheck.",
        ].join("\n"),
      }
      return
    }
    if (round === 1) {
      // Continuation round after approval: execute a tool.
      yield { type: "tool_call", data: { id: "probe-2", name: "baseline_probe", input: {} } }
      return
    }
    // Final round: complete the run.
    yield { type: "text", data: "plan executed" }
  }
}

class ClarificationProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
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
      return
    }
    yield { type: "text", data: "clarified, proceeding" }
  }
}

async function drain(iterable: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

describe("Harness H7 interrupts", () => {
  test("plan approval pauses into waiting with a pending interrupt", async () => {
    const harness = createAgentHarness({
      deps: { provider: new PlanProvider(), tools: probeTool(), flashTriagePolicy: "always" },
      sessionId: "sess-int-plan",
    })
    const session = await harness.createSession()
    const events = await drain(harness.run(session.sessionId, {
      prompt: "Build a complete small service with package setup, API, typecheck verification, tests, and responsive design while preserving existing files.",
      metadata: {},
    }))
    const runId = events[0]!.runId
    const snapshot = await harness.inspect(runId)
    expect(snapshot.status).toBe("waiting")
    expect(snapshot.outcome?.kind).toBe("waiting")
    expect(snapshot.interrupt?.kind).toBe("plan_approval")
    expect(snapshot.interrupt?.status).toBe("pending")
    expect(events.some(e => e.type === "interrupt.created")).toBe(true)
  })

  test("resume with approval continues the run to completion", async () => {
    const harness = createAgentHarness({
      deps: { provider: new PlanProvider(), tools: probeTool(), flashTriagePolicy: "always" },
      sessionId: "sess-int-resume",
    })
    const session = await harness.createSession()
    const events = await drain(harness.run(session.sessionId, { prompt: "Build a complete small service with package setup, API, typecheck verification, tests, and responsive design while preserving existing files.", metadata: {} }))
    const runId = events[0]!.runId
    const snapshot = await harness.inspect(runId)
    const interrupt = snapshot.interrupt!

    const resumed = await drain(harness.resume(runId, {
      interruptId: interrupt.interruptId,
      payload: { accepted: true, planText: "plan text" },
      accepted: true,
      answeredAt: Date.now(),
    }))
    expect(resumed.length).toBeGreaterThan(0)

    const after = await harness.inspect(runId)
    // The continuation leaves waiting (mock runs lack verification evidence,
    // so the terminal may be completed or completion-gate blocked — both
    // prove the resumed run executed and terminated normally).
    expect(after.status).not.toBe("waiting")
    expect(after.interrupt?.status).toBe("answered")
  })

  test("repeated resume is refused once answered (idempotency)", async () => {
    const harness = createAgentHarness({
      deps: { provider: new PlanProvider(), tools: probeTool(), flashTriagePolicy: "always" },
      sessionId: "sess-int-idem",
    })
    const session = await harness.createSession()
    const events = await drain(harness.run(session.sessionId, { prompt: "Build a complete small service with package setup, API, typecheck verification, tests, and responsive design while preserving existing files.", metadata: {} }))
    const runId = events[0]!.runId
    const interrupt = (await harness.inspect(runId)).interrupt!
    await drain(harness.resume(runId, {
      interruptId: interrupt.interruptId,
      payload: { accepted: true },
      accepted: true,
      answeredAt: Date.now(),
    }))
    await expect(async () => {
      for await (const _e of harness.resume(runId, {
        interruptId: interrupt.interruptId,
        payload: { accepted: true },
        accepted: true,
        answeredAt: Date.now(),
      })) { /* no-op */ }
    }).toThrow(HarnessError)
  })

  test("schema-invalid responses are rejected", async () => {
    const harness = createAgentHarness({
      deps: { provider: new PlanProvider(), tools: probeTool(), flashTriagePolicy: "always" },
      sessionId: "sess-int-schema",
    })
    const session = await harness.createSession()
    const events = await drain(harness.run(session.sessionId, { prompt: "Build a complete small service with package setup, API, typecheck verification, tests, and responsive design while preserving existing files.", metadata: {} }))
    const runId = events[0]!.runId
    const interrupt = (await harness.inspect(runId)).interrupt!
    await expect(async () => {
      for await (const _e of harness.resume(runId, {
        interruptId: interrupt.interruptId,
        payload: { planText: 42 }, // accepted missing, wrong type
        accepted: true,
        answeredAt: Date.now(),
      })) { /* no-op */ }
    }).toThrow(/rejected/)
  })

  test("rejection is a formal cancelled branch", async () => {
    const harness = createAgentHarness({
      deps: { provider: new PlanProvider(), tools: probeTool(), flashTriagePolicy: "always" },
      sessionId: "sess-int-reject",
    })
    const session = await harness.createSession()
    const events = await drain(harness.run(session.sessionId, { prompt: "Build a complete small service with package setup, API, typecheck verification, tests, and responsive design while preserving existing files.", metadata: {} }))
    const runId = events[0]!.runId
    const interrupt = (await harness.inspect(runId)).interrupt!

    const resumed = await drain(harness.resume(runId, {
      interruptId: interrupt.interruptId,
      payload: { accepted: false },
      accepted: false,
      answeredAt: Date.now(),
    }))
    expect(resumed).toHaveLength(0)
    const after = await harness.inspect(runId)
    expect(after.status).toBe("cancelled")
    expect(after.outcome?.kind).toBe("cancelled")
    expect(after.interrupt?.status).toBe("rejected")
  })

  test("clarification pauses and resumes with answers injected", async () => {
    const harness = createAgentHarness({
      deps: { provider: new ClarificationProvider(), tools: [] },
      sessionId: "sess-int-clar",
    })
    const session = await harness.createSession()
    const events = await drain(harness.run(session.sessionId, { prompt: "做一个全栈项目", metadata: {} }))
    const runId = events[0]!.runId
    const snapshot = await harness.inspect(runId)
    expect(snapshot.status).toBe("waiting")
    expect(snapshot.interrupt?.kind).toBe("clarification")
    expect(events.some(e => "clarification" in e.payload)).toBe(true)

    const resumed = await drain(harness.resume(runId, {
      interruptId: snapshot.interrupt!.interruptId,
      payload: { answers: [{ questionId: "scope", answer: "B" }] },
      accepted: true,
      answeredAt: Date.now(),
    }))
    expect(resumed.length).toBeGreaterThan(0)
    const after = await harness.inspect(runId)
    // The clarification gate did not re-fire (history marker injected) and
    // the run left waiting.
    expect(after.status).not.toBe("waiting")
    expect(resumed.some(e => "clarification" in e.payload)).toBe(false)
  })

  test("cross-instance resume restores from the store", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dscode-h7-"))
    try {
      writeFileSync(join(cwd, "file.txt"), "stable")
      const store = createFileHarnessStore({ root: join(cwd, ".deepseek-code", "harness") })
      const hash = () => computeWorkspaceHash(cwd)
      const harness = createAgentHarness({
        deps: { provider: new PlanProvider(), tools: probeTool(), flashTriagePolicy: "always" },
        sessionId: "sess-int-cross",
        projectRoot: cwd,
        store,
        workspaceHash: hash,
      })
      const session = await harness.createSession()
      const events = await drain(harness.run(session.sessionId, { prompt: "Build a complete small service with package setup, API, typecheck verification, tests, and responsive design while preserving existing files.", metadata: {} }))
      const runId = events[0]!.runId
      const interrupt = (await harness.inspect(runId)).interrupt!

      // New harness instance (simulated process restart) resumes from store.
      const harnessB = createAgentHarness({
        deps: { provider: new PlanProvider(), tools: probeTool(), flashTriagePolicy: "always" },
        sessionId: "sess-int-cross",
        projectRoot: cwd,
        store,
        workspaceHash: hash,
      })
      const resumed = await drain(harnessB.resume(runId, {
        interruptId: interrupt.interruptId,
        payload: { accepted: true },
        accepted: true,
        answeredAt: Date.now(),
      }))
      expect(resumed.length).toBeGreaterThan(0)
      const after = await harnessB.inspect(runId)
      expect(after.status).not.toBe("waiting")
      expect(after.interrupt?.status).toBe("answered")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("workspace change rejects the resume", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dscode-h7-ws-"))
    try {
      writeFileSync(join(cwd, "file.txt"), "stable")
      const store = createFileHarnessStore({ root: join(cwd, ".deepseek-code", "harness") })
      const harness = createAgentHarness({
        deps: { provider: new PlanProvider(), tools: probeTool(), flashTriagePolicy: "always" },
        sessionId: "sess-int-ws",
        projectRoot: cwd,
        store,
        workspaceHash: () => computeWorkspaceHash(cwd),
      })
      const session = await harness.createSession()
      const events = await drain(harness.run(session.sessionId, { prompt: "Build a complete small service with package setup, API, typecheck verification, tests, and responsive design while preserving existing files.", metadata: {} }))
      const runId = events[0]!.runId
      const interrupt = (await harness.inspect(runId)).interrupt!

      // Mutate the workspace after the pause.
      writeFileSync(join(cwd, "file.txt"), "changed!")

      const harnessB = createAgentHarness({
        deps: { provider: new PlanProvider(), tools: probeTool(), flashTriagePolicy: "always" },
        sessionId: "sess-int-ws",
        projectRoot: cwd,
        store,
        workspaceHash: () => computeWorkspaceHash(cwd),
      })
      await expect(async () => {
        for await (const _e of harnessB.resume(runId, {
          interruptId: interrupt.interruptId,
          payload: { accepted: true },
          accepted: true,
          answeredAt: Date.now(),
        })) { /* no-op */ }
      }).toThrow(/workspace/i)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
