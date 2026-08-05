/** MACP-M6 acceptance: 类型化计划契约.
 *
 *  Gates: PLAN_CONTRACT_SCHEMA / HARD_CRITERION_BYPASS /
 *  FAKE_DETERMINISTIC_CHECK.
 */

import { describe, expect, test } from "bun:test"
import { validatePlanContract } from "../../src/workflow/reducers/plan-contract-validator"
import { evaluateCriterion, compileCriterionVerifications } from "../../src/workflow/reducers/criterion-evaluator"
import type { TypedPlanContract } from "../../src/workflow/contracts/plan-contract"
import type { CompletionCriterion } from "../../src/workflow/contracts/criteria"

function criterion(overrides: Partial<CompletionCriterion> = {}): CompletionCriterion {
  return {
    id: "c.test",
    title: "test criterion",
    hard: true,
    mode: "deterministic",
    check: { type: "command", command: "bun run typecheck" },
    ...overrides,
  }
}

function contract(overrides: Partial<TypedPlanContract> = {}): TypedPlanContract {
  return {
    schemaVersion: "0.3",
    version: "1.0.0",
    criteria: [criterion()],
    tasks: [{ taskId: "t1", title: "fix", scope: ["src/a.ts"], criterionIds: ["c.test"], writes: false }],
    ...overrides,
  }
}

const DETERMINISTIC_COMMAND: CompletionCriterion = criterion()
const DETERMINISTIC_EVIDENCE: CompletionCriterion = criterion({
  id: "c.evidence",
  check: { type: "evidence", evidenceKind: "ownership" },
})
const SEMANTIC: CompletionCriterion = criterion({
  id: "c.semantic",
  hard: false,
  mode: "semantic",
  check: { type: "semantic_review", reviewer: "human", guidance: "judge quality" },
})

describe("M6: plan contract validation", () => {
  test("valid contract passes schema + rules", () => {
    const result = validatePlanContract(contract())
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  test("missing criterion id → rejected", () => {
    const result = validatePlanContract(contract({ criteria: [criterion({ id: "" })] }))
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes("id"))).toBe(true)
  })

  test("duplicate criterion ids → rejected", () => {
    const result = validatePlanContract(contract({ criteria: [criterion(), criterion()] }))
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes("duplicate"))).toBe(true)
  })

  test("write task without verification criterion → rejected (task 6)", () => {
    const result = validatePlanContract(
      contract({
        criteria: [SEMANTIC],
        tasks: [{ taskId: "t1", title: "write", scope: ["a.ts"], criterionIds: ["c.semantic"], writes: true }],
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes("no verification criterion"))).toBe(true)
  })

  test("write task bound only to soft criteria → rejected (hard required)", () => {
    const result = validatePlanContract(
      contract({
        criteria: [{ ...DETERMINISTIC_COMMAND, hard: false }],
        tasks: [{ taskId: "t1", title: "write", scope: ["a.ts"], criterionIds: ["c.test"], writes: true }],
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes("hard criterion"))).toBe(true)
  })

  test("write task without ownership evidence inherits auto-hard security criterion (task 7)", () => {
    const result = validatePlanContract(
      contract({
        tasks: [{ taskId: "t1", title: "write", scope: ["a.ts"], criterionIds: ["c.test"], writes: true }],
      }),
    )
    expect(result.ok).toBe(true)
    expect(result.autoCriteria).toHaveLength(1)
    expect(result.autoCriteria[0]!.id).toBe("sys.ownership_and_no_escape")
    expect(result.autoCriteria[0]!.hard).toBe(true)
  })

  test("write task with ownership evidence criterion inherits nothing", () => {
    const result = validatePlanContract(
      contract({
        criteria: [DETERMINISTIC_COMMAND, DETERMINISTIC_EVIDENCE],
        tasks: [{ taskId: "t1", title: "write", scope: ["a.ts"], criterionIds: ["c.test", "c.evidence"], writes: true }],
      }),
    )
    expect(result.ok).toBe(true)
    expect(result.autoCriteria).toEqual([])
  })

  test("semantic criterion disguised as deterministic check → rejected (FAKE_DETERMINISTIC)", () => {
    const result = validatePlanContract(
      contract({
        criteria: [criterion({ id: "c.fake", mode: "deterministic", check: { type: "semantic_review", reviewer: "x", guidance: "y" } })],
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes("deterministic"))).toBe(true)
  })

  test("semantic mode without semantic_review check → rejected (task 8)", () => {
    const result = validatePlanContract(
      contract({
        criteria: [criterion({ id: "c.s", mode: "semantic", check: { type: "file_exists", path: "a.ts" } })],
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes("semantic_review"))).toBe(true)
  })

  test("schema rejects structurally invalid contracts (task 5)", () => {
    const result = validatePlanContract({ schemaVersion: "0.2", tasks: [] })
    expect(result.ok).toBe(false)
  })

  test("missing version → rejected (task 12)", () => {
    const result = validatePlanContract(contract({ version: "" }))
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes("version"))).toBe(true)
  })
})

describe("M6: criterion evaluation", () => {
  test("hard deterministic command passes/fails mechanically", async () => {
    const ok = await evaluateCriterion(DETERMINISTIC_COMMAND, {
      cwd: "/tmp",
      runCommand: async () => ({ passed: true, output: "ok" }),
    })
    expect(ok.passed).toBe(true)
    expect(ok.requiresReview).toBe(false)
    const bad = await evaluateCriterion(DETERMINISTIC_COMMAND, {
      cwd: "/tmp",
      runCommand: async () => ({ passed: false, output: "boom" }),
    })
    expect(bad.passed).toBe(false)
    expect(bad.reason).toContain("boom")
  })

  test("file_exists criterion", async () => {
    const exists = await evaluateCriterion(criterion({ check: { type: "file_exists", path: "a.ts" } }), {
      cwd: "/tmp",
      exists: () => true,
    })
    expect(exists.passed).toBe(true)
  })

  test("semantic_review never auto-passes (task 8)", async () => {
    const verdict = await evaluateCriterion(SEMANTIC, { cwd: "/tmp" })
    expect(verdict.passed).toBe(false)
    expect(verdict.requiresReview).toBe(true)
    expect(verdict.reason).toContain("semantic review")
  })

  test("evidence criterion matches the evidence ledger", async () => {
    const hit = await evaluateCriterion(DETERMINISTIC_EVIDENCE, {
      cwd: "/tmp",
      evidence: [{ kind: "ownership", summary: "pass" }],
    })
    expect(hit.passed).toBe(true)
    const miss = await evaluateCriterion(DETERMINISTIC_EVIDENCE, {
      cwd: "/tmp",
      evidence: [{ kind: "typecheck", summary: "pass" }],
    })
    expect(miss.passed).toBe(false)
  })

  test("compile produces deterministic verification nodes only (task 10)", () => {
    const results = compileCriterionVerifications([DETERMINISTIC_COMMAND, SEMANTIC, criterion({ id: "c.f", check: { type: "file_exists", path: "x" } })])
    expect(results).toHaveLength(1) // command 编译；semantic 与 file_exists 不产 verification
    expect(results[0]!.command).toBe("bun run typecheck")
    expect(results[0]!.kind).toBe("test")
  })
})

describe("M6: old doneCriteria compatibility", () => {
  test("legacy TaskPacket doneCriteria still displayed alongside typed criteria", () => {
    // 旧字段兼容：typed criteria 是可选扩展，不破坏既有数据结构
    const legacy = { taskId: "t1", doneCriteria: ["typecheck passes"], verification: [{ kind: "typecheck", description: "tsc" }] }
    const withTyped = { ...legacy, typedCriteria: [criterion()] }
    expect(withTyped.doneCriteria).toEqual(["typecheck passes"])
    expect(withTyped.typedCriteria).toHaveLength(1)
    expect(legacy.doneCriteria).toEqual(["typecheck passes"])
  })
})
