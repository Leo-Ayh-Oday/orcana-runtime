/** G6 acceptance: PermissionGate — the model cannot bypass approval
 *  and dynamic graphs share the scheduler (PR-G6). */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { buildTool, type ContractToolDescriptor } from "../../src/tools/registry"
import { FIND_SYMBOL, FIND_REFERENCES, PROJECT_STRUCTURE } from "../../src/tools/codegraph"
import { GIT_STATUS, GIT_DIFF } from "../../src/tools/git"
import { RUN_PROCESS_TOOL } from "../../src/tools/process"
import { RUN_TARGETED_VERIFICATION_TOOL } from "../../src/tools/verification"
import { READ_FILE } from "../../src/tools/file"
import { APPLY_PATCH_TRANSACTION_TOOL } from "../../src/tools/apply-patch"
import { buildReadWriteRegistry } from "../../src/workflow/registry"
import { PermissionGate } from "../../src/workflow/dynamic/permission-gate"
import { runScheduler } from "../../src/workflow/scheduler/scheduler"

const PROJECT = resolve("tmp-g6-gate")
const A = join(PROJECT, "a.ts")

beforeAll(() => {
  mkdirSync(PROJECT, { recursive: true })
  writeFileSync(A, "export const a = 1\n")
})

afterAll(() => {
  rmSync(PROJECT, { recursive: true, force: true })
})

function tools(): ContractToolDescriptor[] {
  return [
    buildTool(READ_FILE),
    buildTool(FIND_SYMBOL),
    buildTool(FIND_REFERENCES),
    buildTool(PROJECT_STRUCTURE),
    buildTool(GIT_STATUS),
    buildTool(GIT_DIFF),
    buildTool(APPLY_PATCH_TRANSACTION_TOOL),
    buildTool(RUN_PROCESS_TOOL),
    buildTool(RUN_TARGETED_VERIFICATION_TOOL),
  ]
}

const READ_GRAPH = {
  schemaVersion: "0.1",
  specId: "dyn-gate-read",
  nodes: [{ id: "r:read", type: "read", handler: "tool.read_file", input: { path: "tmp-g6-gate/a.ts" }, dependsOn: [] }],
}

const WRITE_GRAPH = {
  schemaVersion: "0.1",
  specId: "dyn-gate-write",
  mode: "read-write",
  nodes: [
    {
      id: "w:patch",
      type: "write",
      handler: "tool.apply_patch",
      input: { patches: [{ diff: "--- a/tmp-g6-gate/a.ts\n+++ b/tmp-g6-gate/a.ts\n@@ -1 +1 @@\n-export const a = 1\n+export const a = 2\n" }] },
      dependsOn: [],
    },
    { id: "v:verify", type: "verify", handler: "tool.run_targeted_verification", input: { files: [] }, dependsOn: ["w:patch"] },
  ],
}

describe("G6 permission gate", () => {
  test("read-only graphs are approved without human approval", () => {
    const gate = new PermissionGate(buildReadWriteRegistry(tools()))
    const result = gate.evaluate(READ_GRAPH)
    expect(result.decision).toBe("approved")
    expect(result.spec).not.toBeNull()
  })

  test("write graphs need approval; no spec before approve()", () => {
    const gate = new PermissionGate(buildReadWriteRegistry(tools()))
    const result = gate.evaluate(WRITE_GRAPH)
    expect(result.decision).toBe("needs_approval")
    expect(result.spec).toBeNull()
    expect(result.rationale).toContain("w:patch")
    expect(gate.approve()).not.toBeNull()
    expect(gate.wasApproved()).toBe(true)
  })

  test("malicious payloads are rejected — no spec, no approval path", () => {
    const gate = new PermissionGate(buildReadWriteRegistry(tools()))
    const evil = {
      ...WRITE_GRAPH,
      specId: "dyn-evil",
      nodes: [{ id: "w:patch", type: "write", handler: "tool.not_registered", input: {}, dependsOn: [] }],
    }
    const result = gate.evaluate(evil)
    expect(result.decision).toBe("rejected")
    expect(result.spec).toBeNull()
    expect(gate.approve()).toBeNull()
  })

  test("approved write graph executes through the shared scheduler", async () => {
    const gate = new PermissionGate(buildReadWriteRegistry(tools()))
    const result = gate.evaluate(WRITE_GRAPH)
    expect(result.decision).toBe("needs_approval")
    const spec = gate.approve()
    expect(spec).not.toBeNull()
    const run = await runScheduler(spec!, buildReadWriteRegistry(tools()), { projectRoot: PROJECT })
    // M6: the verification node fails (empty files) — a failed node surfaces
    // as run "failed", never masked as blocked_no_evidence or done.
    expect(run.status).toBe("failed")
    expect(run.results[0]!.status).toBe("done")
    expect((run.results[0]!.output as { content: string }).content).toContain("committed")
  })
})
