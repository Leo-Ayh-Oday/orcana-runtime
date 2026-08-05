import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { contextFromRunScope, buildExecutionContext, systemClock } from "../../src/harness/capabilities/execution-context"
import { assembleRunScope } from "../../src/harness/runtime/run-scope"
import { createBudgetLedger, mergeRunBudget } from "../../src/harness/runtime/budget-ledger"
import { createCapabilityRegistry } from "../../src/harness/capabilities/registry"
import { executeCapability } from "../../src/harness/capabilities/executor"
import { createCapabilityDescriptor } from "../../src/harness/capabilities/descriptor"
import { PermissionGate } from "../../src/agent/permission"
import type { AgentRunScope } from "../../src/harness/contracts/run"

function budget() {
  return createBudgetLedger(mergeRunBudget({}))
}

/** R1 pattern: permissive policy context so tests exercise execution, not gates. */
function allowGate(name: string) {
  const gate = new PermissionGate()
  gate.allow(name)
  return { permissionGate: gate, input: {} }
}

// RT-3: explicit run-scoped ToolExecutionContext — scope-derived, strict
// approval in node mode, threaded into capability handlers.

function makeScope(projectRoot: string): AgentRunScope {
  return assembleRunScope({
    runId: "run-ctx",
    sessionId: "sess-ctx",
    projectRoot,
    controller: new AbortController(),
  })
}

describe("RT-3 execution context construction", () => {
  test("contextFromRunScope carries run identity and project root", () => {
    const cwd = mkdtempSync(join(tmpdir(), "rt3-"))
    try {
      const scope = makeScope(cwd)
      const ctx = contextFromRunScope(scope, {
        budget: budget(),
        signal: new AbortController().signal,
      })
      expect(ctx.runId).toBe("run-ctx")
      expect(ctx.sessionId).toBe("sess-ctx")
      expect(ctx.projectRoot).toBe(cwd)
      expect(ctx.readableRoots).toEqual([cwd])
      expect(ctx.writableRoots).toEqual([cwd])
      expect(ctx.artifactStore).toBe(scope.artifactStore)
      expect(ctx.evidenceLedger).toBe(scope.evidenceLedger)
      expect(ctx.trace).toBe(scope.trace)
      expect(ctx.clock.now()).toBeGreaterThan(0)
      expect(ctx.clock).toBe(systemClock)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("node mode approval is strict (fail closed, no interactive channel)", async () => {
    const ctx = buildExecutionContext({
      runId: "r",
      sessionId: "s",
      projectRoot: "/tmp",
      signal: new AbortController().signal,
      budget: budget(),
      approvalMode: "strict",
    })
    expect(ctx.approval.mode).toBe("strict")
    expect(await ctx.approval.request("shell:any")).toBe(false)
  })

  test("auto approval grants once and remembers", async () => {
    const ctx = buildExecutionContext({
      runId: "r",
      sessionId: "s",
      projectRoot: "/tmp",
      signal: new AbortController().signal,
      budget: budget(),
    })
    expect(await ctx.approval.request("read:a.ts")).toBe(true)
    expect(await ctx.approval.request("read:a.ts")).toBe(true)
    expect(ctx.approval.granted.has("read:a.ts")).toBe(true)
  })
})

describe("RT-3 context reaches capability handlers", () => {
  test("executor threads runContext into the handler metadata", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rt3-handler-"))
    try {
      const scope = makeScope(cwd)
      const registry = createCapabilityRegistry()
      let seenContext: unknown = null
      registry.register(
        createCapabilityDescriptor({
          id: "ctx_probe",
          kind: "tool",
          inputSchema: { type: "object", properties: {}, required: [] },
          outputSchema: { type: "object", properties: { success: { type: "boolean" }, content: { type: "string" } }, required: ["success", "content"] },
          source: "native",
        }),
        {
          async execute(_input, meta) {
            seenContext = (meta?.metadata as { runContext?: unknown })?.runContext ?? null
            return { ok: true, output: { ok: true } }
          },
        },
      )
      const ctx = contextFromRunScope(scope, {
        budget: budget(),
        signal: new AbortController().signal,
        approvalMode: "strict",
      })
      const result = await executeCapability(registry, {
        capabilityId: "ctx_probe",
        params: {},
        budget: budget(),
        policyContext: allowGate("ctx_probe") as never,
        context: ctx,
      })
      expect(result.result.success).toBe(true)
      expect(seenContext).not.toBeNull()
      expect((seenContext as { runId: string }).runId).toBe("run-ctx")
      expect((seenContext as { projectRoot: string }).projectRoot).toBe(cwd)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
