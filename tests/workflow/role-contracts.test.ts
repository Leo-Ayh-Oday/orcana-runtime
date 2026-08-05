/** MACP-M7 acceptance: 角色与输出契约.
 *
 *  Gates: ROLE_OUTPUT_SCHEMA / SELF_APPROVAL / ROLE_AUTHORITY_LEAK.
 */

import { describe, expect, test } from "bun:test"
import { validateRoleOutput } from "../../src/workflow/coordination/role-output-validator"
import {
  roleOfNode,
  collectRoleAssignments,
  validateRoleSeparation,
  ROLE_AUTHORITY,
  roleAuthorityViolation,
} from "../../src/workflow/coordination/assignments"
import { reviewerReadContext, reviewerSeesHiddenReasoning, persistRoleOutput } from "../../src/workflow/coordination/role-output-validator"
import type { WorkflowNodeSpec } from "../../src/workflow/types"

const BINDING = { runId: "r1", nodeRunId: "r1:n1", planVersion: "1.0.0", workspaceDigest: "abc" }

const PLANNER_OK = {
  planText: "fix the bug",
  taskAssignments: [{ agentId: "c1", taskIds: ["t1"] }],
  dependencies: [{ from: "t1", to: "t2" }],
  approvals: ["t1"],
}

const CODER_OK = {
  changes: [{ file: "src/a.ts", summary: "fixed" }],
  deviations: [],
  evidenceIds: ["ev1"],
}

const REVIEWER_OK = {
  verdict: "approved",
  comments: ["lgtm"],
  evidenceIds: ["ev1"],
}

describe("M7: role output schemas", () => {
  test("valid planner output passes", () => {
    const v = validateRoleOutput({ role: "planner", raw: PLANNER_OK, ...BINDING })
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.envelope.role).toBe("planner")
      expect(v.envelope.runId).toBe("r1")
      expect(v.envelope.planVersion).toBe("1.0.0")
      expect(v.envelope.workspaceDigest).toBe("abc")
    }
  })

  test("valid coder output passes", () => {
    expect(validateRoleOutput({ role: "coder", raw: CODER_OK, ...BINDING }).ok).toBe(true)
  })

  test("valid reviewer output passes", () => {
    expect(validateRoleOutput({ role: "reviewer", raw: REVIEWER_OK, ...BINDING }).ok).toBe(true)
  })

  test("invalid planner output → structured failure (task 3)", () => {
    const v = validateRoleOutput({ role: "planner", raw: { planText: 42, taskAssignments: [] }, ...BINDING })
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.errorKind).toBe("invalid_role_output")
      expect(v.errors.length).toBeGreaterThan(0)
    }
  })

  test("invalid reviewer verdict → rejected", () => {
    const v = validateRoleOutput({ role: "reviewer", raw: { verdict: "maybe", comments: [] }, ...BINDING })
    expect(v.ok).toBe(false)
  })

  test("coder silent deviation (missing deviation reason) → rejected (ROLE_AUTHORITY_LEAK)", () => {
    const v = validateRoleOutput({
      role: "coder",
      raw: { changes: [], deviations: [{ from: "t1", reason: "" }], evidenceIds: [] },
      ...BINDING,
    })
    expect(v.ok).toBe(false)
  })

  test("role outputs persist to ArtifactStore when provided (task 5)", async () => {
    const { createArtifactStore } = await import("../../src/harness/artifacts/artifact-store")
    const store = createArtifactStore()
    const v = validateRoleOutput({ role: "planner", raw: PLANNER_OK, ...BINDING })
    expect(v.ok).toBe(true)
    if (v.ok) {
      await persistRoleOutput({ role: "planner", raw: PLANNER_OK, ...BINDING, artifacts: store }, v.envelope)
      const artifact = await store.get(`role_planner_${BINDING.nodeRunId}`)
      expect(artifact?.kind).toBe("plan")
      expect(artifact?.workspaceHash).toBe("abc")
      expect(artifact?.runId).toBe("r1")
    }
  })
})

describe("M7: role assignments & separation", () => {
  const node = (id: string, overrides: Partial<WorkflowNodeSpec> = {}): WorkflowNodeSpec => ({
    id,
    handler: "tool.read",
    input: {},
    dependsOn: [],
    ...overrides,
  })

  test("roles are derived from handlers and input", () => {
    expect(roleOfNode(node("p:1", { handler: "planner.build_plan" }))).toBe("planner")
    expect(roleOfNode(node("c:1", { input: { role: "coder" } }))).toBe("coder")
    expect(roleOfNode(node("v:1", { execution: { kind: "verification" } }))).toBe("reviewer")
    expect(roleOfNode(node("m:1", { handler: "reduce.merge_agents" }))).toBe("reviewer")
    expect(roleOfNode(node("x:1", { handler: "tool.apply_patch" }))).toBe("coder")
  })

  test("coder cannot be its own only reviewer (SELF_APPROVAL: 0)", () => {
    const assignments = collectRoleAssignments([
      node("c1:plan:1", { handler: "planner.build_plan", assignment: "alice" }),
      node("c1:work:1", { assignment: "alice" }),
      node("c1:verify:1", { execution: { kind: "verification" }, assignment: "alice" }),
    ])
    const result = validateRoleSeparation(assignments)
    expect(result.ok).toBe(false)
    expect(result.violations[0]!.reason).toContain("also a reviewer")
  })

  test("separate reviewer is fine", () => {
    const assignments = collectRoleAssignments([
      node("c1:work:1", { assignment: "alice" }),
      node("v1:verify:1", { execution: { kind: "verification" }, assignment: "bob" }),
    ])
    expect(validateRoleSeparation(assignments).ok).toBe(true)
  })

  test("authority baseline: planner/reviewer cannot write, nobody can merge except none", () => {
    expect(ROLE_AUTHORITY.planner).toEqual({ canWrite: false, canMerge: false, canApproveOwn: false })
    expect(ROLE_AUTHORITY.reviewer).toEqual({ canWrite: false, canMerge: false, canApproveOwn: false })
    expect(ROLE_AUTHORITY.coder.canWrite).toBe(true)
    expect(ROLE_AUTHORITY.coder.canApproveOwn).toBe(false)
  })

  test("role authority violation: reviewer writing is denied (ROLE_AUTHORITY_LEAK)", () => {
    expect(roleAuthorityViolation("reviewer", node("v1:w:1", { handler: "tool.write" }), true)).toContain("cannot write")
    expect(roleAuthorityViolation("planner", node("p1:m:1", { handler: "reduce.merge_agents" }), false)).toContain("cannot merge")
    expect(roleAuthorityViolation("coder", node("c1:w:1", { handler: "tool.write" }), true)).toBeUndefined()
  })
})

describe("M7: reviewer read surface (tasks 7/8)", () => {
  test("hidden reasoning is excluded from the reviewer context", () => {
    const context = {
      plan: "the plan",
      planVersion: "1.0.0",
      finalDiff: "diff...",
      sources: ["src/a.ts"],
      evidence: ["ev1"],
      hiddenReasoning: "secret scratchpad",
      thinking: "internal chain",
    }
    const filtered = reviewerReadContext(context)
    expect(filtered.hiddenReasoning).toBeUndefined()
    expect(filtered.thinking).toBeUndefined()
    expect(filtered.plan).toBe("the plan")
    expect(reviewerSeesHiddenReasoning(context)).toEqual(["hiddenReasoning", "thinking"])
    expect(reviewerSeesHiddenReasoning(filtered)).toEqual([])
  })
})
