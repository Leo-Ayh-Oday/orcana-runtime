/** G2 acceptance: run results project back onto MasterPlan status. */

import { describe, expect, test } from "bun:test"
import { projectResultsToPlan } from "../../src/workflow/projection/plan-projection"
import type { WorkflowRunResult } from "../../src/workflow/types"

const RUN: WorkflowRunResult = {
  specId: "plan-abc",
  finishedAt: 1,
  results: [
    { nodeId: "plan:1", status: "done", output: { content: "payment module analyzed: 3 files, 2 services", metadata: {} }, startedAt: 0, finishedAt: 1, durationMs: 1 },
    { nodeId: "plan:2", status: "done", output: { content: "3 commits since last release", metadata: {} }, startedAt: 0, finishedAt: 1, durationMs: 1 },
    { nodeId: "plan:3", status: "failed", output: null, error: "symbol not found", startedAt: 0, finishedAt: 1, durationMs: 1 },
  ],
}

describe("G2 plan projection", () => {
  test("done → done, failed → blocked, in original node order", () => {
    const projection = projectResultsToPlan(RUN, ["1", "2", "3"])
    expect(projection).toEqual([
      { nodeId: "1", status: "done", evidence: "payment module analyzed: 3 files, 2 services" },
      { nodeId: "2", status: "done", evidence: "3 commits since last release" },
      { nodeId: "3", status: "blocked", evidence: undefined },
    ])
  })

  test("missing result ⇒ blocked (no silent success)", () => {
    const projection = projectResultsToPlan(RUN, ["1", "ghost"])
    expect(projection[1]).toEqual({ nodeId: "ghost", status: "blocked", evidence: undefined })
  })

  test("evidence is a whitespace-normalized head summary", () => {
    const projection = projectResultsToPlan(RUN, ["1"])
    expect(projection[0]!.evidence!.length).toBeLessThanOrEqual(80)
    expect(projection[0]!.evidence).not.toContain("\n")
  })
})
