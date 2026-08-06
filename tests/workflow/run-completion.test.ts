/** M6 acceptance: FAILED_WORKFLOW_NODE_NEVER_DONE.
 *
 *  A run with any failed or blocked node never reports "done" — read-only
 *  handler errors, dependency-blocked nodes and H11 harness node failures
 *  all aggregate into a failed/blocked run status (previously masked).
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

function registry(opts: { throwOn?: string } = {}): HandlerRegistry {
  const reg = new RegistryImpl()
  reg.register("test.ok", "ok", async () => ({ content: "fine" }))
  reg.register("test.boom", "boom", async () => {
    throw new Error("read handler exploded")
  })
  reg.register("test.noop", "noop", async () => ({ content: "noop" }))
  return reg
}

function spec(nodes: WorkflowNodeSpec[], specId = "m6-spec"): WorkflowSpec {
  return { schemaVersion: "0.2", specId, nodes }
}

function harnessEnv(): { env: WorkflowHarnessEnvironment; projectRoot: string } {
  const projectRoot = mkdtempSync(join(tmpdir(), "m6-"))
  const controller = new AbortController()
  const scope = assembleRunScope({ runId: "m6-run", sessionId: "m6", projectRoot, controller })
  const env: WorkflowHarnessEnvironment = {
    scope,
    budgetLimits: mergeRunBudget(undefined),
    capabilities: createCapabilityRegistry(),
  }
  return { env, projectRoot }
}

describe("M6: failed/blocked nodes never complete the run", () => {
  test("read-only handler throwing ⇒ run failed", async () => {
    const run = await runScheduler(
      spec([
        { id: "r:1", handler: "test.ok", input: {}, dependsOn: [] },
        { id: "r:2", handler: "test.boom", input: {}, dependsOn: [] },
      ]),
      registry(),
    )
    expect(run.results.find(r => r.nodeId === "r:2")?.status).toBe("failed")
    expect(run.status).toBe("failed")
  })

  test("dependency-blocked node ⇒ run blocked", async () => {
    // p:1 succeeds but c:1 requires when:"failed" — the condition is
    // unsatisfied, so c:1 blocks while no node failed.
    const run = await runScheduler(
      spec(
        [
          { id: "p:1", handler: "test.ok", input: {}, dependsOn: [] },
          { id: "c:1", handler: "test.noop", input: {}, dependsOn: [{ nodeId: "p:1", when: "failed" }] },
        ],
        "m6-blocked",
      ),
      registry(),
    )
    expect(run.results.find(r => r.nodeId === "p:1")?.status).toBe("done")
    expect(run.results.find(r => r.nodeId === "c:1")?.status).toBe("blocked")
    expect(run.status).toBe("blocked")
  })

  test("H11 LLM node failure (no model path) ⇒ run failed", async () => {
    const { env, projectRoot } = harnessEnv()
    try {
      const run = await runScheduler(
        spec([
          {
            id: "agent:1",
            handler: "test.noop",
            input: {},
            dependsOn: [],
            execution: { kind: "llm_agent", prompt: "do it", maxRounds: 2 },
          },
        ]),
        registry(),
        { harness: env },
      )
      const result = run.results.find(r => r.nodeId === "agent:1")!
      expect(result.status).toBe("failed")
      expect(result.error).toContain("loopDeps") // fail closed without a model path
      expect(run.status).toBe("failed")
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test("all nodes done ⇒ run done", async () => {
    const run = await runScheduler(
      spec([{ id: "r:1", handler: "test.ok", input: {}, dependsOn: [] }], "m6-ok"),
      registry(),
    )
    expect(run.status).toBe("done")
  })

  test("failed node still blocks an otherwise-evidenced write run", async () => {
    const run = await runScheduler(
      spec(
        [
          { id: "r:1", handler: "test.ok", input: {}, dependsOn: [] },
          { id: "r:2", handler: "test.boom", input: {}, dependsOn: [] },
        ],
        "m6-write",
      ),
      registry(),
    )
    // failed takes precedence over blocked_no_evidence/blocked — never done.
    expect(run.status).toBe("failed")
  })
})
