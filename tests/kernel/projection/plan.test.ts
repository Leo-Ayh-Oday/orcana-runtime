/** AK2-T01 — Projection plan runtime validation + path policy 表驱动反例。 */

import { describe, expect, test } from "bun:test"
import { ProjectionError, type WorldProjectionPlanInput } from "../../../src/kernel/projection/contracts"
import { validateWorldProjectionPlan } from "../../../src/kernel/projection/plan"
import {
  canonicalizeProjectionPath,
  pathWithinAny,
  pathWithinRoot,
} from "../../../src/kernel/projection/path-policy"

function basePlan(overrides: Partial<WorldProjectionPlanInput> = {}): WorldProjectionPlanInput {
  return {
    projectionId: "proj-1",
    worldId: "world-1",
    branchId: "branch-main",
    snapshotId: "snapshot:abc",
    actor: "actor:test",
    mode: "native",
    writableRoots: ["src"],
    readonlyRoots: ["docs"],
    expectedOutputs: ["src/out.js"],
    graphCompletionAllowed: false,
    ...overrides,
  }
}

/** 断言 plan 构造抛指定 code。 */
function expectReject(input: WorldProjectionPlanInput, code: import("../../../src/kernel/projection/contracts").ProjectionErrorCode): void {
  try {
    validateWorldProjectionPlan(input)
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectionError)
    expect((error as ProjectionError).code).toBe(code)
    return
  }
  throw new Error(`expected ProjectionError(${code}) but plan validated`)
}

describe("AK2-T01 path canonicalization 表驱动", () => {
  const valid: Array<[string, string]> = [
    ["a", "a"],
    ["a/b", "a/b"],
    ["a/b/c.ts", "a/b/c.ts"],
    ["dir.with.dots/file name.ts", "dir.with.dots/file name.ts"],
    ["x-1/_y", "x-1/_y"],
  ]
  test.each(valid)("canonicalize(%j) -> %j", (input, expected) => {
    expect(canonicalizeProjectionPath(input)).toBe(expected)
  })

  const invalid: Array<[string, import("../../../src/kernel/projection/contracts").ProjectionErrorCode, string]> = [
    ["", "INVALID_PATH", "empty"],
    ["/abs", "INVALID_PATH", "absolute"],
    ["/", "INVALID_PATH", "root absolute"],
    ["a\0b", "INVALID_PATH", "NUL"],
    ["a\\b", "INVALID_PATH", "backslash"],
    ["a//b", "NON_CANONICAL_PATH", "duplicate separator"],
    ["a/", "NON_CANONICAL_PATH", "trailing slash"],
    ["/a/", "INVALID_PATH", "absolute trailing"],
    [".", "NON_CANONICAL_PATH", "dot"],
    ["..", "NON_CANONICAL_PATH", "dotdot"],
    ["./a", "NON_CANONICAL_PATH", "dot slash prefix"],
    ["a/./b", "NON_CANONICAL_PATH", "embedded dot"],
    ["a/../b", "NON_CANONICAL_PATH", "embedded dotdot"],
    ["../a", "NON_CANONICAL_PATH", "leading dotdot"],
    ["a/b/..", "NON_CANONICAL_PATH", "trailing dotdot"],
  ]
  test.each(invalid)("canonicalize(%j) rejects: %s", (input, code) => {
    try {
      canonicalizeProjectionPath(input)
    } catch (error) {
      expect((error as ProjectionError).code).toBe(code)
      return
    }
    throw new Error(`expected rejection for ${JSON.stringify(input)}`)
  })
})

describe("AK2-T01 scope 反例表", () => {
  test("writable 与 readonly 重叠（相等）拒绝", () => {
    expectReject(basePlan({ writableRoots: ["src"], readonlyRoots: ["src"] }), "SCOPE_AMBIGUITY")
  })
  test("writable 嵌套于 readonly 拒绝", () => {
    expectReject(
      basePlan({ writableRoots: ["src/app"], readonlyRoots: ["src"] }),
      "SCOPE_AMBIGUITY",
    )
  })
  test("readonly 嵌套于 writable 拒绝", () => {
    expectReject(basePlan({ writableRoots: ["src"], readonlyRoots: ["src/app"] }), "SCOPE_AMBIGUITY")
  })
  test("同 scope 重复 root 拒绝", () => {
    expectReject(basePlan({ writableRoots: ["src", "src"] }), "DUPLICATE_SCOPE_ROOT")
  })
  test("同 scope 嵌套 root 拒绝（归属不唯一）", () => {
    expectReject(basePlan({ writableRoots: ["src", "src/app"] }), "SCOPE_OVERLAP")
  })
  test("writable 为空拒绝", () => {
    expectReject(basePlan({ writableRoots: [] }), "SCOPE_AMBIGUITY")
  })
  test("expected output 在 writable 之外拒绝", () => {
    expectReject(
      basePlan({ expectedOutputs: ["dist/out.js"] }),
      "EXPECTED_OUTPUT_OUTSIDE_WRITABLE",
    )
  })
  test("expected output 只落在 readonly（不在 writable）→ 拒绝", () => {
    // scope 不重叠 ⇒ output 在 readonly 内必不在 writable 内，主条件先拒绝；
    // INSIDE_READONLY 是 writable∩readonly 重叠时的防御分支（重叠本身已被
    // SCOPE_AMBIGUITY 提前拒绝）。
    expectReject(
      basePlan({ readonlyRoots: ["docs"], expectedOutputs: ["docs/x"] }),
      "EXPECTED_OUTPUT_OUTSIDE_WRITABLE",
    )
  })
  test("expected output 非 canonical 拒绝", () => {
    expectReject(
      basePlan({ expectedOutputs: ["src/../out.js"] }),
      "NON_CANONICAL_PATH",
    )
  })
  test("mode=direct fail-closed", () => {
    expectReject(basePlan({ mode: "direct" }), "MODE_FAIL_CLOSED")
  })
  test("mode=live fail-closed", () => {
    expectReject(basePlan({ mode: "live" }), "MODE_FAIL_CLOSED")
  })
  test("graphCompletionAllowed=true 拒绝", () => {
    expectReject(
      basePlan({ graphCompletionAllowed: true as never }),
      "GRAPH_COMPLETION_FORBIDDEN",
    )
  })
  test("graphCompletionAllowed=undefined 拒绝", () => {
    expectReject(
      basePlan({ graphCompletionAllowed: undefined as never }),
      "GRAPH_COMPLETION_FORBIDDEN",
    )
  })
  test("projectionId/worldId/branchId/snapshotId/actor 空或非法拒绝", () => {
    expectReject(basePlan({ projectionId: "" }), "INVALID_PROJECTION_ID")
    expectReject(basePlan({ worldId: "  " }), "INVALID_WORLD_ID")
    expectReject(basePlan({ branchId: "a\nb" }), "INVALID_WORLD_ID")
    expectReject(basePlan({ snapshotId: "x\0y" }), "INVALID_WORLD_ID")
    expectReject(basePlan({ actor: "" }), "INVALID_WORLD_ID")
    expectReject(basePlan({ projectionId: "x".repeat(513) }), "INVALID_PROJECTION_ID")
  })
  test("writable/readonly 无关路径合法", () => {
    const plan = validateWorldProjectionPlan(
      basePlan({
        writableRoots: ["src", "tests"],
        readonlyRoots: ["docs", "vendor/lib"],
        expectedOutputs: ["src/out.js", "tests/out.json"],
      }),
    )
    expect(plan.mode).toBe("native")
    expect(plan.graphCompletionAllowed).toBe(false)
  })
})

describe("AK2-T01 plan 冻结与归属", () => {
  test("plan 深冻结（数组与对象不可变）", () => {
    const plan = validateWorldProjectionPlan(basePlan())
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.writableRoots)).toBe(true)
    expect(Object.isFrozen(plan.readonlyRoots)).toBe(true)
    expect(Object.isFrozen(plan.expectedOutputs)).toBe(true)
    expect(() => {
      ;(plan.writableRoots as string[]).push("evil")
    }).toThrow()
  })

  test("pathWithinRoot / pathWithinAny 边界", () => {
    expect(pathWithinRoot("src", "src")).toBe(true)
    expect(pathWithinRoot("src/a", "src")).toBe(true)
    expect(pathWithinRoot("src2/a", "src")).toBe(false)
    expect(pathWithinRoot("sr", "src")).toBe(false)
    expect(pathWithinAny("a/b", ["a", "z"])).toBe(true)
    expect(pathWithinAny("ab", ["a", "z"])).toBe(false)
  })

  test("输入数组不共享（调用方后续变异不影响 plan）", () => {
    const writable = ["src"]
    const plan = validateWorldProjectionPlan(basePlan({ writableRoots: writable }))
    writable.push("evil")
    expect(plan.writableRoots).toEqual(["src"])
  })
})
