import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assembleRunScope } from "../../src/harness/runtime/run-scope"
import { createBudgetLedger, mergeRunBudget } from "../../src/harness/runtime/budget-ledger"
import { createCapabilityRegistry } from "../../src/harness/capabilities/registry"
import { executeCapability } from "../../src/harness/capabilities/executor"
import { createCapabilityDescriptor } from "../../src/harness/capabilities/descriptor"
import { contextFromRunScope } from "../../src/harness/capabilities/execution-context"

// RT-3: two run scopes executing concurrently never share run state — each
// capability invocation carries its own artifact store / evidence ledger.

function storeProbeCapability(registry: ReturnType<typeof createCapabilityRegistry>) {
  registry.register(
    createCapabilityDescriptor({
      id: "probe_store",
      kind: "tool",
      inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
      outputSchema: { type: "object", properties: { success: { type: "boolean" }, content: { type: "string" } }, required: ["success", "content"] },
      source: "native",
    }),
    {
      async execute(input, meta) {
        const runContext = (meta?.metadata as { runContext?: { artifactStore: { put(artifact: { artifactId: string }): Promise<void> }; runId: string } }).runContext!
        // Write a run-specific artifact — must land only in this run's store.
        await runContext.artifactStore.put({ artifactId: `artifact-${runContext.runId}` } as never)
        return { ok: true, output: { ok: true } }
      },
    },
  )
}

describe("RT-3 parallel run isolation", () => {
  test("concurrent runs keep artifact stores disjoint", async () => {
    const cwdA = mkdtempSync(join(tmpdir(), "rt3-iso-a-"))
    const cwdB = mkdtempSync(join(tmpdir(), "rt3-iso-b-"))
    try {
      const scopeA = assembleRunScope({ runId: "run-A", sessionId: "sess-A", projectRoot: cwdA, controller: new AbortController() })
      const scopeB = assembleRunScope({ runId: "run-B", sessionId: "sess-B", projectRoot: cwdB, controller: new AbortController() })

      const registryA = createCapabilityRegistry()
      const registryB = createCapabilityRegistry()
      storeProbeCapability(registryA)
      storeProbeCapability(registryB)

      const ctxA = contextFromRunScope(scopeA, { budget: createBudgetLedger(mergeRunBudget({})), signal: new AbortController().signal, approvalMode: "strict" })
      const ctxB = contextFromRunScope(scopeB, { budget: createBudgetLedger(mergeRunBudget({})), signal: new AbortController().signal, approvalMode: "strict" })

      const policyDecision = { allowed: true, reason: "", source: "test", priority: 0, blockMessage: "" } as never
      const [ra, rb] = await Promise.all([
        executeCapability(registryA, { capabilityId: "probe_store", params: {}, budget: createBudgetLedger(mergeRunBudget({})), policyDecision, context: ctxA }),
        executeCapability(registryB, { capabilityId: "probe_store", params: {}, budget: createBudgetLedger(mergeRunBudget({})), policyDecision, context: ctxB }),
      ])

      expect(ra.result.success).toBe(true)
      expect(rb.result.success).toBe(true)
      // Each store holds ONLY its own run's artifact.
      expect((await scopeA.artifactStore.entries()).map((a) => a.artifactId)).toEqual(["artifact-run-A"])
      expect((await scopeB.artifactStore.entries()).map((a) => a.artifactId)).toEqual(["artifact-run-B"])
    } finally {
      rmSync(cwdA, { recursive: true, force: true })
      rmSync(cwdB, { recursive: true, force: true })
    }
  })

  test("cancelling one run's signal does not abort the other", async () => {
    const cwdA = mkdtempSync(join(tmpdir(), "rt3-iso-a2-"))
    const cwdB = mkdtempSync(join(tmpdir(), "rt3-iso-b2-"))
    try {
      const scopeA = assembleRunScope({ runId: "run-A2", sessionId: "s", projectRoot: cwdA, controller: new AbortController() })
      const scopeB = assembleRunScope({ runId: "run-B2", sessionId: "s", projectRoot: cwdB, controller: new AbortController() })
      const signalA = new AbortController()
      const signalB = new AbortController()

      signalA.abort("cancel A")
      const ctxA = contextFromRunScope(scopeA, { budget: createBudgetLedger(mergeRunBudget({})), signal: signalA.signal })
      const ctxB = contextFromRunScope(scopeB, { budget: createBudgetLedger(mergeRunBudget({})), signal: signalB.signal })

      expect(ctxA.signal.aborted).toBe(true)
      expect(ctxB.signal.aborted).toBe(false)
      // The run scopes' own cancellation stays independent of the context signal.
      expect(scopeB.cancellation.cancelled).toBe(false)
    } finally {
      rmSync(cwdA, { recursive: true, force: true })
      rmSync(cwdB, { recursive: true, force: true })
    }
  })
})
