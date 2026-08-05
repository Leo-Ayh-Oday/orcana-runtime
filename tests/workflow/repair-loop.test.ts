/** G4 acceptance: Convergent Repair Loop — provable convergence (PR-G4). */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { buildTool, Result, type ContractToolDescriptor } from "../../src/tools/registry"
import { FIND_SYMBOL, FIND_REFERENCES, PROJECT_STRUCTURE } from "../../src/tools/codegraph"
import { GIT_STATUS, GIT_DIFF } from "../../src/tools/git"
import { RUN_PROCESS_TOOL } from "../../src/tools/process"
import { RUN_TARGETED_VERIFICATION_TOOL } from "../../src/tools/verification"
import { READ_FILE } from "../../src/tools/file"
import { APPLY_PATCH_TRANSACTION_TOOL } from "../../src/tools/apply-patch"
import { buildReadWriteRegistry } from "../../src/workflow/registry"
import { RepairLoop, type ConvergenceReport } from "../../src/workflow/convergence/repair-loop"
import type { WorkflowSpec } from "../../src/workflow/types"

const PROJECT = resolve("tmp-g4-repair")
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

const BAD_DIFF = "--- a/tmp-g4-repair/a.ts\n+++ b/tmp-g4-repair/a.ts\n@@ -99 +99 @@\n-export const a = 999\n+export const a = 2\n"
const GOOD_DIFF = "--- a/tmp-g4-repair/a.ts\n+++ b/tmp-g4-repair/a.ts\n@@ -1 +1 @@\n-export const a = 1\n+export const a = 2\n"

function repairSpec(round: number, diff: string): WorkflowSpec {
  return {
    schemaVersion: "0.1",
    specId: `g4-repair-${round}`,
    mode: "read-write",
    nodes: [
      { id: "w:patch", handler: "tool.apply_patch", input: { patches: [{ diff }] }, dependsOn: [] },
      { id: "v:verify", handler: "tool.run_targeted_verification", input: { files: [] }, dependsOn: ["w:patch"] },
    ],
  }
}

describe("G4 convergent repair loop", () => {
  test("repeated failure never retries forever (maxAttempts hard cap)", async () => {
    const registry = buildReadWriteRegistry(tools())
    const loop = new RepairLoop({
      registry,
      maxAttempts: 3,
      maxDryRounds: 99,
      specFactory: ({ round }) => (round === 1 ? repairSpec(1, BAD_DIFF) : null),
    })
    const report = await loop.run()
    expect(report.outcome).toBe("max_attempts")
    expect(report.attempts).toBe(3)
    expect(report.seen).toContain("w:patch|patch_conflict")
  })

  test("seen and confirmed stay separated", async () => {
    const registry = buildReadWriteRegistry(tools())
    const loop = new RepairLoop({
      registry,
      maxAttempts: 3,
      maxDryRounds: 99,
      specFactory: ({ round }) => (round === 1 ? repairSpec(1, BAD_DIFF) : null),
    })
    const report = await loop.run()
    expect(report.seen.length).toBe(1)
    expect(report.confirmed).toEqual([])
    expect(report.blocked.some(b => b.nodeId === "w:patch" && b.signature === "w:patch|patch_conflict")).toBe(true)
  })

  test("two dry rounds exit with dry", async () => {
    const registry = buildReadWriteRegistry(tools())
    const loop = new RepairLoop({
      registry,
      maxDryRounds: 2,
      specFactory: ({ round }) => (round === 1 ? repairSpec(1, BAD_DIFF) : null),
    })
    const report = await loop.run()
    expect(report.outcome).toBe("dry")
    expect(report.dryRounds).toBe(2)
    expect(report.attempts).toBe(3)
  })

  test("metric gain continues the loop (repair converges to done)", async () => {
    const registry = buildReadWriteRegistry(tools())
    registry.registerWriteTool("tool.run_targeted_verification", buildTool({
      name: "run_targeted_verification",
      description: "stub",
      isReadonly: false,
      category: "shell",
      inputSchema: {},
      requiresConfirmation: true,
      execute: async () => Result.ok("typecheck passed"),
    }))
    let round = 0
    const loop = new RepairLoop({
      registry,
      maxAttempts: 4,
      specFactory: () => {
        round++
        return round === 1 ? repairSpec(1, BAD_DIFF) : repairSpec(2, GOOD_DIFF)
      },
    })
    const report: ConvergenceReport = await loop.run()
    expect(report.outcome).toBe("done")
    expect(report.attempts).toBe(2)
    expect(report.dryRounds).toBe(0)
    expect(report.confirmed).toEqual([{ nodeId: "w:patch", evidenceCount: 1 }])
    expect(report.blocked).toEqual([])
  })

  test("budget exhaustion emits a structured blocked report", async () => {
    const registry = buildReadWriteRegistry(tools())
    const loop = new RepairLoop({
      registry,
      budget: 1,
      specFactory: () => repairSpec(1, BAD_DIFF),
    })
    const report = await loop.run()
    expect(report.outcome).toBe("budget_exhausted")
    expect(report.attempts).toBe(1)
    expect(report.seen).toContain("w:patch|patch_conflict")
    expect(report.blocked.length).toBeGreaterThan(0)
    expect(report.blocked[0]!.nodeId).toBe("w:patch")
    expect(report.blocked[0]!.attempts).toBe(1)
  })

  test("same signature in a later round is not a new fix (no rewording bypass)", async () => {
    const registry = buildReadWriteRegistry(tools())
    const loop = new RepairLoop({
      registry,
      maxDryRounds: 2,
      specFactory: ({ round }) => (round <= 2 ? repairSpec(round, BAD_DIFF) : null),
    })
    const report = await loop.run()
    const executedRounds = report.rounds.filter(r => r.run !== null)
    expect(executedRounds).toHaveLength(2)
    expect(executedRounds[1]!.newSignatures).toEqual([])
    expect(report.seen).toEqual(["w:patch|patch_conflict"])
    expect(report.outcome).toBe("dry")
  })
})
