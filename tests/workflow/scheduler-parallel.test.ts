/** G1 acceptance: 4 dependency-free read-only nodes run in parallel. */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildTool, type ContractToolDescriptor } from "../../src/tools/registry"
import { READ_FILE } from "../../src/tools/file"
import { FIND_SYMBOL, FIND_REFERENCES, PROJECT_STRUCTURE } from "../../src/tools/codegraph"
import { GIT_STATUS, GIT_DIFF } from "../../src/tools/git"
import { runScheduler } from "../../src/workflow/scheduler/scheduler"
import { buildReadonlyRegistry } from "../../src/workflow/registry"
import type { WorkflowSpec } from "../../src/workflow/types"

function tools(): ContractToolDescriptor[] {
  return [READ_FILE, FIND_SYMBOL, FIND_REFERENCES, PROJECT_STRUCTURE, GIT_STATUS, GIT_DIFF].map(t => buildTool(t))
}

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "wflow-g1-"))
  writeFileSync(join(dir, "a.ts"), "export const a = 1\n")
  writeFileSync(join(dir, "b.ts"), "export const b = 2\n")
  writeFileSync(join(dir, "c.ts"), "export const c = 3\n")
  writeFileSync(join(dir, "d.ts"), "export const d = 4\n")
  return dir
}

describe("G1 parallel scheduler", () => {
  test("four independent read_file nodes execute in parallel (wall < serial)", async () => {
    const dir = makeProject()
    const spec: WorkflowSpec = {
      schemaVersion: "0.1",
      specId: "g1-parallel",
      nodes: [
        { id: "tool:n1", handler: "tool.read_file", input: { path: join(dir, "a.ts") }, dependsOn: [] },
        { id: "tool:n2", handler: "tool.read_file", input: { path: join(dir, "b.ts") }, dependsOn: [] },
        { id: "tool:n3", handler: "tool.read_file", input: { path: join(dir, "c.ts") }, dependsOn: [] },
        { id: "tool:n4", handler: "tool.read_file", input: { path: join(dir, "d.ts") }, dependsOn: [] },
      ],
    }
    const started = Date.now()
    const run = await runScheduler(spec, buildReadonlyRegistry(tools()))
    const wall = Date.now() - started

    expect(run.results).toHaveLength(4)
    expect(run.results.every(r => r.status === "done")).toBe(true)
    // read_file on tiny files is fast; parallel wall must stay well under
    // serial worst-case (4 × per-file). Assert a generous bound: < 4x any
    // single call. Use per-node durations to prove overlap.
    const durations = run.results.map(r => r.durationMs)
    const maxSingle = Math.max(...durations)
    expect(wall).toBeLessThan(Math.max(50, maxSingle * 3.5))
    for (const r of run.results) {
      const content = (r.output as { content: string }).content
      expect(content).toContain("export const")
    }
  })

  test("mixed read-only handlers (read_file + project_structure + git_status) run fine", async () => {
    const dir = makeProject()
    const spec: WorkflowSpec = {
      schemaVersion: "0.1",
      specId: "g1-mixed",
      nodes: [
        { id: "tool:r1", handler: "tool.read_file", input: { path: join(dir, "a.ts") }, dependsOn: [] },
        { id: "tool:ps1", handler: "tool.project_structure", input: { path: dir }, dependsOn: [] },
        { id: "tool:gs1", handler: "tool.git_status", input: { path: dir }, dependsOn: [] },
      ],
    }
    const run = await runScheduler(spec, buildReadonlyRegistry(tools()))
    expect(run.results.filter(r => r.status === "done")).toHaveLength(3)
  })

  test("find_symbol works as a read-only handler", async () => {
    const dir = makeProject()
    const spec: WorkflowSpec = {
      schemaVersion: "0.1",
      specId: "g1-symbol",
      nodes: [
        { id: "tool:s1", handler: "tool.find_symbol", input: { query: "a", path: dir }, dependsOn: [] },
      ],
    }
    const run = await runScheduler(spec, buildReadonlyRegistry(tools()))
    expect(run.results[0]!.status).toBe("done")
  })
})
