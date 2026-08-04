import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildTools } from "../../src/tools/registry"
import { createCapabilityRegistry } from "../../src/harness/capabilities/registry"
import { registerToolCapabilities } from "../../src/harness/capabilities/tool-adapter"
import { createCapabilityDescriptor } from "../../src/harness/capabilities/descriptor"
import { assembleRunScope } from "../../src/harness/runtime/run-scope"
import { createBudgetLedger, mergeRunBudget } from "../../src/harness/runtime/budget-ledger"
import { createNodeExecutionContext } from "../../src/harness/nodes/context"
import { createToolNode } from "../../src/harness/nodes/tool-node"
import { runNodeToResult } from "../../src/harness/nodes/run"
import { PermissionGate } from "../../src/agent/permission"
import type { AgentRun } from "../../src/harness/contracts/run"
import type { NodeExecutionContext } from "../../src/harness/contracts/nodes"

// R1 (Harness Closure): the hr-dual scenarios are independent-harness sanity
// checks (static probes). THIS file is the real shared-process dual-run test:
// two run scopes in ONE process sharing ONE projectRoot permission file —
// the R1 node-mode policy gate (createNodePolicyContextFromRunScope) must
// load the shared config for both runs, and per-run policy contexts must not
// leak across runs. (H3 tests/harness_run_isolation covers the loop's
// plan/mode/patch/sandbox isolation; this covers the R1 policy surface.)

function makeNodeContext(projectRoot: string, runTag: string): NodeExecutionContext {
  const runId = `run-shared-${runTag}`
  const controller = new AbortController()
  const scope = assembleRunScope({ runId, sessionId: `sess-shared-${runTag}`, projectRoot, controller })
  const run: AgentRun = {
    runId,
    sessionId: `sess-shared-${runTag}`,
    status: "running",
    input: { prompt: "shared", maxRounds: 2 },
    scope,
    budget: createBudgetLedger(mergeRunBudget(undefined)),
    createdAt: Date.now(),
    eventSequence: 0,
    schemaVersion: 1,
  }
  const capabilities = createCapabilityRegistry()
  capabilities.register(
    createCapabilityDescriptor({
      id: "mock_write",
      kind: "tool",
      inputSchema: { type: "object", properties: {}, required: [] },
      sideEffect: "write",
    }),
    { execute: async () => ({ ok: true, output: { success: true, content: "written" } }) },
  )
  registerToolCapabilities(capabilities, buildTools({
    name: "read_probe",
    description: "probe",
    isReadonly: true,
    isConcurrencySafe: true,
    inputSchema: { type: "object", properties: {}, required: [] },
    execute: () => ({ success: true, content: "ok" } as never),
  }))
  return createNodeExecutionContext({ run, capabilities })
}

describe("R1 shared-process dual-run policy isolation", () => {
  test("shared project permission file applies to both runs; per-run allow does not leak", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "r1-shared-"))
    try {
      // ONE shared permission surface, read by both run scopes.
      const dir = join(projectRoot, ".orcana")
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, "permissions.json"),
        JSON.stringify({ rules: [{ toolName: "mock_write", level: "deny" }] }),
      )

      const ctxA = makeNodeContext(projectRoot, "a")
      const ctxB = makeNodeContext(projectRoot, "b")

      // Both runs, no explicit policyContext → the run-scope-derived gate
      // honors the shared deny rule for both.
      const nodeA = createToolNode({ id: "write-a" })
      const a = await runNodeToResult(nodeA, ctxA, { capabilityId: "mock_write", params: {} })
      expect(a.result.status).toBe("blocked")
      expect(a.result.error?.kind).toBe("policy_blocked")

      const nodeB = createToolNode({ id: "write-b" })
      const b = await runNodeToResult(nodeB, ctxB, { capabilityId: "mock_write", params: {} })
      expect(b.result.status).toBe("blocked")
      expect(b.result.error?.kind).toBe("policy_blocked")

      // Run B explicitly allows the tool — run A's gate is untouched.
      const allowGate = new PermissionGate()
      allowGate.allow("mock_write")
      const nodeB2 = createToolNode({ id: "write-b2", policyContext: { permissionGate: allowGate, input: {} } })
      const b2 = await runNodeToResult(nodeB2, ctxB, { capabilityId: "mock_write", params: {} })
      expect(b2.result.status).toBe("succeeded")

      // Run A STILL blocked — the B-side allow did not leak.
      const nodeA2 = createToolNode({ id: "write-a2" })
      const a2 = await runNodeToResult(nodeA2, ctxA, { capabilityId: "mock_write", params: {} })
      expect(a2.result.status).toBe("blocked")
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test("per-run project roots load DIFFERENT permission files (no cross-run config bleed)", async () => {
    const rootA = mkdtempSync(join(tmpdir(), "r1-roota-"))
    const rootB = mkdtempSync(join(tmpdir(), "r1-rootb-"))
    try {
      mkdirSync(join(rootA, ".orcana"), { recursive: true })
      mkdirSync(join(rootB, ".orcana"), { recursive: true })
      writeFileSync(join(rootA, ".orcana", "permissions.json"), JSON.stringify({ rules: [{ toolName: "mock_write", level: "deny" }] }))
      writeFileSync(join(rootB, ".orcana", "permissions.json"), JSON.stringify({ rules: [{ toolName: "mock_write", level: "allow" }] }))

      const ctxA = makeNodeContext(rootA, "a2")
      const ctxB = makeNodeContext(rootB, "b2")
      const nodeA = createToolNode({ id: "write-a3" })
      const nodeB = createToolNode({ id: "write-b3" })

      const [a, b] = await Promise.all([
        runNodeToResult(nodeA, ctxA, { capabilityId: "mock_write", params: {} }),
        runNodeToResult(nodeB, ctxB, { capabilityId: "mock_write", params: {} }),
      ])
      expect(a.result.status).toBe("blocked")
      expect(b.result.status).toBe("succeeded")
    } finally {
      rmSync(rootA, { recursive: true, force: true })
      rmSync(rootB, { recursive: true, force: true })
    }
  })
})
