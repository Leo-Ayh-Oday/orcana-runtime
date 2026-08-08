/** LR2-3（P3-E）：Work Stealing 守卫 + 只读推测执行验收。 */

import { describe, expect, test } from "bun:test"
import { canSteal, type StealCandidate, type StealTargetContext } from "../../../../src/runtime/linux/scheduler/stealing"
import { speculativeAllowed, verifySpeculativeResult, type SpeculativeResult } from "../../../../src/runtime/linux/scheduler/speculative"

function candidate(overrides: Partial<StealCandidate> = {}): StealCandidate {
  return {
    nodeId: "n1", nodeRunId: "r:n1", capabilityId: "run_process",
    ownerFiles: ["a.txt"], newOwnerFiles: ["a.txt"],
    hasPrivateContextDependency: false, started: false,
    ...overrides,
  }
}

function target(overrides: Partial<StealTargetContext> = {}): StealTargetContext {
  return { agentId: "a2", capabilities: ["run_process"], secretsAuthorized: true, ...overrides }
}

describe("Work Stealing guards (P3-E)", () => {
  test("all 7 conditions met → allowed", () => {
    const verdict = canSteal(candidate(), target())
    expect(verdict.allowed).toBe(true)
  })

  test("node already started → rejected", () => {
    const verdict = canSteal(candidate({ started: true }), target())
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reasons).toContain("node already started")
  })

  test("target lacks capability → rejected", () => {
    const verdict = canSteal(candidate(), target({ capabilities: ["other"] }))
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reasons.some(r => r.includes("capability"))).toBe(true)
  })

  test("file ownership would expand → rejected", () => {
    const verdict = canSteal(candidate({ newOwnerFiles: ["a.txt", "b.txt"] }), target())
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reasons).toContain("file ownership would expand")
  })

  test("secrets not re-authorized → rejected", () => {
    const verdict = canSteal(candidate(), target({ secretsAuthorized: false }))
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reasons).toContain("secrets not re-authorized")
  })

  test("private context dependency → rejected", () => {
    const verdict = canSteal(candidate({ hasPrivateContextDependency: true }), target())
    expect(verdict.allowed).toBe(false)
  })

  test("multiple violations reported together", () => {
    const verdict = canSteal(candidate({ started: true, hasPrivateContextDependency: true }), target({ secretsAuthorized: false }))
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reasons.length).toBeGreaterThanOrEqual(3)
  })
})

describe("Speculative execution (P3-E)", () => {
  test("only readonly kinds are whitelisted", () => {
    for (const kind of ["test-discovery", "dependency-scan", "repo-map", "reviewer-preanalysis", "cache-warmup", "readonly-index"] as const) {
      expect(speculativeAllowed(kind)).toBe(true)
    }
    // 白名单外（如 build）拒绝
    expect(speculativeAllowed("build" as never)).toBe(false)
  })

  test("digest mismatch discards stale result (SPECULATIVE_STALE_COMMIT)", () => {
    const result: SpeculativeResult = {
      kind: "repo-map",
      inputDigest: "i1", workspaceDigest: "w1", policyDigest: "p1", toolchainDigest: "t1",
      output: { map: "..." }, producedAt: 1,
    }
    expect(verifySpeculativeResult(result, { inputDigest: "i1", workspaceDigest: "w1", policyDigest: "p1", toolchainDigest: "t1" })).toBe(true)
    // 任一 digest 变化 → 丢弃
    expect(verifySpeculativeResult(result, { inputDigest: "i2", workspaceDigest: "w1", policyDigest: "p1", toolchainDigest: "t1" })).toBe(false)
    expect(verifySpeculativeResult(result, { inputDigest: "i1", workspaceDigest: "w2", policyDigest: "p1", toolchainDigest: "t1" })).toBe(false)
    expect(verifySpeculativeResult(result, { inputDigest: "i1", workspaceDigest: "w1", policyDigest: "p2", toolchainDigest: "t1" })).toBe(false)
    expect(verifySpeculativeResult(result, { inputDigest: "i1", workspaceDigest: "w1", policyDigest: "p1", toolchainDigest: "t2" })).toBe(false)
  })
})
