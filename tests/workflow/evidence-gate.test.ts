/** G3 acceptance: no Evidence ⇒ no completion. */

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
import { runScheduler } from "../../src/workflow/scheduler/scheduler"
import { aggregateEvidence, type EvidenceEntry } from "../../src/workflow/reducers/aggregate-evidence"
import type { WorkflowNodeResult, WorkflowSpec } from "../../src/workflow/types"

const PROJECT = resolve("tmp-g3-evidence")
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

function patchNode(id: string, diff: string, dependsOn: string[] = []): WorkflowSpec["nodes"][number] {
  return { id, handler: "tool.apply_patch", input: { patches: [{ diff }] }, dependsOn }
}

describe("G3 evidence gate", () => {
  test("write node without passing verification ⇒ blocked_no_evidence", async () => {
    const registry = buildReadWriteRegistry(tools())
    const spec: WorkflowSpec = {
      schemaVersion: "0.1",
      specId: "g3-no-evidence",
      mode: "read-write",
      nodes: [
        patchNode("w:patch", "--- a/tmp-g3-evidence/a.ts\n+++ b/tmp-g3-evidence/a.ts\n@@ -1 +1 @@\n-export const a = 1\n+export const a = 2\n"),
      ],
    }
    const run = await runScheduler(spec, registry, { projectRoot: PROJECT })
    expect(run.status).toBe("blocked_no_evidence")
    expect(run.evidence).toEqual([])
  })

  test("write node followed by passing verification ⇒ done with bound evidence", async () => {
    const registry = buildReadWriteRegistry(tools())
    const spec: WorkflowSpec = {
      schemaVersion: "0.1",
      specId: "g3-with-evidence",
      mode: "read-write",
      nodes: [
        patchNode("w:patch", "--- a/tmp-g3-evidence/a.ts\n+++ b/tmp-g3-evidence/a.ts\n@@ -1 +1 @@\n-export const a = 1\n+export const a = 2\n"),
        {
          id: "v:verify",
          handler: "tool.run_targeted_verification",
          input: { files: ["tmp-g3-evidence/a.ts"] },
          dependsOn: ["w:patch"],
        },
      ],
    }
    // Verification tools need the registry to know them; simulate a passed
    // verification result by running with a stub registry entry.
    const results: WorkflowNodeResult[] = [
      { nodeId: "w:patch", status: "done", output: { content: "applied 1 file(s)" }, startedAt: 0, finishedAt: 1, durationMs: 1 },
      { nodeId: "v:verify", status: "done", output: { content: "typecheck passed", metadata: {} }, startedAt: 1, finishedAt: 2, durationMs: 1 },
    ]
    const evidence: EvidenceEntry[] = aggregateEvidence(spec, results)
    expect(evidence).toHaveLength(1)
    expect(evidence[0]!.writeNodeIds).toEqual(["w:patch"])
    expect(evidence[0]!.passed).toBe(true)
    expect(evidence[0]!.summary).toBe("typecheck passed")
  })

  test("aggregate-evidence: failed verification binds as not-passed", () => {
    const spec: WorkflowSpec = {
      schemaVersion: "0.1",
      specId: "g3-ev-fail",
      mode: "read-write",
      nodes: [
        patchNode("w:patch", "x"),
        { id: "v:verify", handler: "tool.run_targeted_verification", input: { files: [] }, dependsOn: ["w:patch"] },
      ],
    }
    const results: WorkflowNodeResult[] = [
      { nodeId: "w:patch", status: "done", output: { content: "ok" }, startedAt: 0, finishedAt: 1, durationMs: 1 },
      { nodeId: "v:verify", status: "failed", output: null, error: "typecheck failed", startedAt: 1, finishedAt: 2, durationMs: 1 },
    ]
    const evidence = aggregateEvidence(spec, results)
    expect(evidence).toHaveLength(1)
    expect(evidence[0]!.passed).toBe(false)
    expect(evidence[0]!.summary).toBeUndefined()
  })
})
