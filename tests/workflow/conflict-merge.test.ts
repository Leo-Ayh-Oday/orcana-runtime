/** G7 acceptance: conflict detection + merge node (PR-G7). */

import { describe, expect, test } from "bun:test"
import { detectConflicts, agentOfNode } from "../../src/workflow/agents/conflict-detect"
import { mergeAgentArtifacts } from "../../src/workflow/agents/merge"

describe("G7 conflict detection", () => {
  test("agent ids are extracted from node ids", () => {
    expect(agentOfNode("a1:w:patch")).toBe("a1")
    expect(agentOfNode("r:read")).toBe("r")
    expect(agentOfNode("merge")).toBeNull()
  })

  test("two agents writing the same file produce a conflict report", () => {
    const results = [
      { nodeId: "a1:w:patch", status: "done" as const, output: { content: "x", metadata: { paths: ["src/shared.ts"] } }, startedAt: 0, finishedAt: 1, durationMs: 1 },
      { nodeId: "a2:w:patch", status: "done" as const, output: { content: "y", metadata: { paths: ["src/shared.ts"] } }, startedAt: 0, finishedAt: 1, durationMs: 1 },
    ]
    const report = detectConflicts(results)
    expect(report.conflicts).toHaveLength(1)
    expect(report.conflicts[0]!.file).toBe("src/shared.ts")
    expect(report.conflicts[0]!.agents.sort()).toEqual(["a1", "a2"])
    expect(report.conflicts[0]!.fingerprints).toHaveLength(2)
  })

  test("disjoint writes are conflict-free", () => {
    const results = [
      { nodeId: "a1:w:patch", status: "done" as const, output: { content: "x", metadata: { paths: ["src/a.ts"] } }, startedAt: 0, finishedAt: 1, durationMs: 1 },
      { nodeId: "a2:w:patch", status: "done" as const, output: { content: "y", metadata: { paths: ["src/b.ts"] } }, startedAt: 0, finishedAt: 1, durationMs: 1 },
    ]
    expect(detectConflicts(results).conflicts).toEqual([])
  })

  test("failed writes never count as conflicts", () => {
    const results = [
      { nodeId: "a1:w:patch", status: "failed" as const, output: null, error: "boom", startedAt: 0, finishedAt: 1, durationMs: 1 },
      { nodeId: "a2:w:patch", status: "done" as const, output: { content: "y", metadata: { paths: ["src/shared.ts"] } }, startedAt: 0, finishedAt: 1, durationMs: 1 },
    ]
    expect(detectConflicts(results).conflicts).toEqual([])
  })
})

describe("G7 merge node", () => {
  test("identical values dedupe; differing values conflict — never overwritten (M5)", () => {
    const result = mergeAgentArtifacts({
      agents: [
        { agentId: "a1", artifact: { goal: "fix a", status: "done" }, files: ["src/a.ts"] },
        { agentId: "a2", artifact: { goal: "fix b", status: "done" }, files: ["src/b.ts"] },
      ],
    })
    // 相同值 status 去重保留；不同值 goal 进入 valueConflicts（无 later-wins）
    expect(result.merged).toEqual({ status: "done" })
    expect(result.valueConflicts).toHaveLength(1)
    expect(result.valueConflicts[0]!.key).toBe("goal")
    expect(result.valueConflicts[0]!.agents).toEqual(["a1", "a2"])
    expect(result.conflicts).toEqual([])
  })

  test("differing values for multiple keys are all reported (M5)", () => {
    const result = mergeAgentArtifacts({
      agents: [
        { agentId: "a1", artifact: { goal: "fix a", version: 1 }, files: ["src/a.ts"] },
        { agentId: "a2", artifact: { goal: "fix b", version: 2 }, files: ["src/b.ts"] },
      ],
    })
    expect(result.valueConflicts).toHaveLength(2)
    expect(result.valueConflicts.map(c => c.key).sort()).toEqual(["goal", "version"])
    expect(result.merged).toEqual({})
  })

  test("same-file touches are reported as merge conflicts", () => {
    const result = mergeAgentArtifacts({
      agents: [
        { agentId: "a1", artifact: { note: "x" }, files: ["src/shared.ts"] },
        { agentId: "a2", artifact: { note: "y" }, files: ["src/shared.ts"] },
      ],
    })
    expect(result.conflicts).toEqual([{ file: "src/shared.ts", agents: ["a1", "a2"] }])
  })

  test("missing input is a no-op", () => {
    const result = mergeAgentArtifacts({})
    expect(result.merged).toEqual({})
    expect(result.conflicts).toEqual([])
    expect(result.valueConflicts).toEqual([])
  })
})
