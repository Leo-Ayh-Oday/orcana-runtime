/** Batch 3 acceptance: completion semantics.
 *
 *  M7  — an H11 write-capability node without passing verification evidence
 *        blocks the run (the completion gate uses the same write
 *        classification as single-writer enforcement);
 *  M20 — a verification node that ingested failing results is rewritten to
 *        failed — the run can never complete on it;
 *  M22 — declared completion criteria are enforced by the production
 *        scheduler: sandbox_execution failed / host-audit / degraded /
 *        cleanup=false each fail their hard criterion and block the run.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runScheduler } from "../../src/workflow/scheduler/scheduler"
import type { WorkflowSpec, WorkflowNodeSpec } from "../../src/workflow/types"
import type { HandlerRegistry } from "../../src/workflow/execution/handler-registry"
import { HandlerRegistry as RegistryImpl } from "../../src/workflow/execution/handler-registry"
import type { WorkflowHarnessEnvironment } from "../../src/workflow/harness/environment"
import { assembleRunScope } from "../../src/harness/runtime/run-scope"
import { mergeRunBudget } from "../../src/harness/runtime/budget-ledger"
import { createCapabilityRegistry } from "../../src/harness/capabilities/registry"
import { createCapabilityDescriptor } from "../../src/harness/capabilities/descriptor"
import { evaluateCriterion } from "../../src/workflow/reducers/criterion-evaluator"
import {
  SANDBOX_EXECUTION_CRITERION,
  SANDBOX_BACKEND_CRITERION,
  SANDBOX_NO_DEGRADATION_CRITERION,
  SANDBOX_CLEANUP_CRITERION,
} from "../../src/workflow/contracts/criteria"

function registerWriteCap(env: WorkflowHarnessEnvironment): void {
  env.capabilities.register(
    createCapabilityDescriptor({
      id: "mock_write",
      kind: "tool",
      inputSchema: { type: "object", properties: {}, required: [] },
      sideEffect: "write",
    }),
    {
      async execute() {
        return { ok: true, output: { success: true, content: "written", metadata: { paths: [] } } }
      },
    },
  )
}

function buildEnv(): { env: WorkflowHarnessEnvironment; projectRoot: string } {
  const projectRoot = mkdtempSync(join(tmpdir(), "mw-completion-"))
  const controller = new AbortController()
  const scope = assembleRunScope({ runId: "mw-completion", sessionId: "mw-completion", projectRoot, controller })
  const capabilities = createCapabilityRegistry()
  const env: WorkflowHarnessEnvironment = {
    scope,
    budgetLimits: mergeRunBudget(undefined),
    capabilities,
    policy: { allowCapabilities: ["mock_write"] },
  }
  registerWriteCap(env)
  return { env, projectRoot }
}

function reg(): HandlerRegistry {
  const registry = new RegistryImpl()
  registry.register("test.noop", "noop", async () => ({ content: "noop" }))
  return registry
}

/** tool.run_targeted_verification 形状的 handler —— metadata 声明证据属性
 *  （M22 接线：scheduler 从 verification 节点 output.metadata 提取）。 */
function verificationHandler(meta: Record<string, unknown>) {
  return async () => ({ content: "verified", metadata: meta })
}

function spec(nodes: WorkflowNodeSpec[], criteria?: import("../../src/workflow/contracts/criteria").CompletionCriterion[], specId = "mw-completion"): WorkflowSpec {
  return { schemaVersion: "0.2", specId, mode: "read-write", nodes, completionCriteria: criteria }
}

describe("M7: H11 write without evidence blocks the run", () => {
  test("write-capability node completed, no verification ⇒ blocked_no_evidence", async () => {
    const { env, projectRoot } = buildEnv()
    try {
      const run = await runScheduler(
        spec([{
          id: "w:1",
          handler: "test.noop",
          input: { path: "x.txt" },
          dependsOn: [],
          execution: { kind: "tool", capabilityId: "mock_write", params: { path: "x.txt" } },
        }]),
        reg(),
        { harness: env },
      )
      expect(run.results.find(r => r.nodeId === "w:1")!.status).toBe("done")
      expect(run.status).toBe("blocked_no_evidence") // 写节点完成但没有验证证据
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test("with a passing verification node the same write run completes", async () => {
    const { env, projectRoot } = buildEnv()
    try {
      const registry = reg()
      registry.register("tool.run_targeted_verification", "verify", verificationHandler({ evidenceKind: "test" }))
      const run = await runScheduler(
        spec([
          {
            id: "w:1",
            handler: "test.noop",
            input: { path: "x.txt" },
            dependsOn: [],
            execution: { kind: "tool", capabilityId: "mock_write", params: { path: "x.txt" } },
          },
          { id: "v:1", handler: "tool.run_targeted_verification", input: {}, dependsOn: ["w:1"] },
        ]),
        registry,
        { harness: env },
      )
      expect(run.status).toBe("done") // 证据门未被锁死：合法路径仍完成
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

describe("M20: failed verification never succeeds", () => {
  test("verification node ingesting failures ⇒ rewritten failed, run not done", async () => {
    const registry = reg()
    registry.register("test.verify", "verify", async () => ({ ingested: [], passedCount: 0, failedCount: 2 }))
    const run = await runScheduler(
      spec([{ id: "v:1", handler: "test.verify", input: {}, dependsOn: [] }]),
      registry,
    )
    const result = run.results.find(r => r.nodeId === "v:1")!
    expect(result.status).toBe("failed")
    expect(result.errorKind).toBe("verification_failed")
    expect(run.status).toBe("failed") // 不得 done
  })

  test("verification node with zero failures keeps done", async () => {
    const registry = reg()
    registry.register("test.verify", "verify", async () => ({ ingested: [], passedCount: 3, failedCount: 0 }))
    const run = await runScheduler(
      spec([{ id: "v:1", handler: "test.verify", input: {}, dependsOn: [] }]),
      registry,
    )
    expect(run.results.find(r => r.nodeId === "v:1")!.status).toBe("done")
    expect(run.status).toBe("done")
  })
})

describe("M22: completion criteria enforced by the production scheduler", () => {
  test("criterion level: passed=false / host-audit / degraded / cleanup=false each fail their hard criterion", async () => {
    const base = { cwd: "/tmp" }
    expect((await evaluateCriterion(SANDBOX_EXECUTION_CRITERION, { ...base, evidence: [{ kind: "sandbox_execution", passed: false }] })).passed).toBe(false)
    expect((await evaluateCriterion(SANDBOX_BACKEND_CRITERION, { ...base, evidence: [{ kind: "sandbox_execution", passed: true, backend: "host-audit" }] })).passed).toBe(false)
    expect((await evaluateCriterion(SANDBOX_NO_DEGRADATION_CRITERION, { ...base, evidence: [{ kind: "sandbox_execution", passed: true, degraded: true }] })).passed).toBe(false)
    expect((await evaluateCriterion(SANDBOX_CLEANUP_CRITERION, { ...base, evidence: [{ kind: "sandbox_cleanup", passed: true, cleanupVerified: false }] })).passed).toBe(false)
    // 满足全部属性时通过
    expect((await evaluateCriterion(SANDBOX_BACKEND_CRITERION, { ...base, evidence: [{ kind: "sandbox_execution", passed: true, backend: "bubblewrap", degraded: false }] })).passed).toBe(true)
  })

  test("host-audit backend ⇒ hard criterion fails ⇒ run blocked", async () => {
    const registry = reg()
    registry.register("tool.run_targeted_verification", "verify", verificationHandler({ evidenceKind: "sandbox_execution", backend: "host-audit" }))
    const run = await runScheduler(
      spec(
        [{ id: "v:1", handler: "tool.run_targeted_verification", input: {}, dependsOn: [] }],
        [SANDBOX_BACKEND_CRITERION],
        "mw22-backend",
      ),
      registry,
    )
    expect(run.status).toBe("blocked")
    expect(run.criteria?.find(c => c.criterionId === "sys.sandbox_backend")?.passed).toBe(false)
  })

  test("degraded evidence ⇒ hard criterion fails ⇒ run blocked", async () => {
    const registry = reg()
    registry.register("tool.run_targeted_verification", "verify", verificationHandler({ evidenceKind: "sandbox_execution", degraded: true }))
    const run = await runScheduler(
      spec(
        [{ id: "v:1", handler: "tool.run_targeted_verification", input: {}, dependsOn: [] }],
        [SANDBOX_NO_DEGRADATION_CRITERION],
        "mw22-degraded",
      ),
      registry,
    )
    expect(run.status).toBe("blocked")
    expect(run.criteria?.find(c => c.criterionId === "sys.sandbox_no_degradation")?.passed).toBe(false)
  })

  test("cleanup=false evidence ⇒ hard criterion fails ⇒ run blocked", async () => {
    const registry = reg()
    registry.register("tool.run_targeted_verification", "verify", verificationHandler({ evidenceKind: "sandbox_cleanup", cleanupVerified: false }))
    const run = await runScheduler(
      spec(
        [{ id: "v:1", handler: "tool.run_targeted_verification", input: {}, dependsOn: [] }],
        [SANDBOX_CLEANUP_CRITERION],
        "mw22-cleanup",
      ),
      registry,
    )
    expect(run.status).toBe("blocked")
    expect(run.criteria?.find(c => c.criterionId === "sys.sandbox_cleanup_verified")?.passed).toBe(false)
  })

  test("all attributes satisfied ⇒ run done", async () => {
    const registry = reg()
    registry.register("tool.run_targeted_verification", "verify", verificationHandler({ evidenceKind: "sandbox_execution", backend: "bubblewrap", degraded: false }))
    const run = await runScheduler(
      spec(
        [{ id: "v:1", handler: "tool.run_targeted_verification", input: {}, dependsOn: [] }],
        [SANDBOX_BACKEND_CRITERION, SANDBOX_NO_DEGRADATION_CRITERION],
        "mw22-ok",
      ),
      registry,
    )
    expect(run.status).toBe("done")
    expect(run.criteria?.every(c => c.passed)).toBe(true)
  })

  test("no evidence at all for a declared criterion ⇒ run blocked", async () => {
    const registry = reg()
    const run = await runScheduler(
      spec([{ id: "r:1", handler: "test.noop", input: {}, dependsOn: [] }], [SANDBOX_EXECUTION_CRITERION], "mw22-none"),
      registry,
    )
    expect(run.status).toBe("blocked")
  })
})
