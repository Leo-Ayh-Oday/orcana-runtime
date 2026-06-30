/** Tests for processGateOverflow — cumulative block escalation logic. */
import { describe, expect, test } from "bun:test"
import { processGateOverflow, type GateOverflowInput } from "../src/agent/gates/overflow"

function baseInput(overrides?: Partial<GateOverflowInput>): GateOverflowInput {
  return {
    round: 0,
    rippleBlockActive: false,
    pendingRippleObligationsLength: 0,
    postToolPlanningPrompt: null,
    postToolRequiredFilesPrompt: null,
    gateBlockCounts: new Map(),
    ...overrides,
  }
}

describe("processGateOverflow", () => {
  test("returns empty output when no gates are blocked", () => {
    const result = processGateOverflow(baseInput())
    expect(result.blocked).toBe(false)
    expect(result.deferredMessages).toHaveLength(0)
    expect(result.statusEvents).toHaveLength(0)
  })

  test("increments ripple counter when ripple is blocked", () => {
    const counts = new Map<string, { count: number; lastSeen: number }>()
    const result = processGateOverflow(baseInput({
      rippleBlockActive: true,
      gateBlockCounts: counts,
    }))
    expect(counts.get("policy:ripple")?.count).toBe(1)
    expect(result.blocked).toBe(false)
  })

  test("increments ripple_obligations counter", () => {
    const counts = new Map<string, { count: number; lastSeen: number }>()
    processGateOverflow(baseInput({
      pendingRippleObligationsLength: 3,
      gateBlockCounts: counts,
    }))
    expect(counts.get("semantic:ripple_obligations")?.count).toBe(1)
  })

  test("increments planning counter when post-tool planning prompt exists", () => {
    const counts = new Map<string, { count: number; lastSeen: number }>()
    processGateOverflow(baseInput({
      postToolPlanningPrompt: "re-evaluate architecture",
      gateBlockCounts: counts,
    }))
    expect(counts.get("semantic:planning")?.count).toBe(1)
  })

  test("increments required_files counter", () => {
    const counts = new Map<string, { count: number; lastSeen: number }>()
    processGateOverflow(baseInput({
      postToolRequiredFilesPrompt: "missing README.md",
      gateBlockCounts: counts,
    }))
    expect(counts.get("semantic:required_files")?.count).toBe(1)
  })

  test("accumulates counts across rounds — same gate blocked repeatedly", () => {
    const counts = new Map<string, { count: number; lastSeen: number }>()

    // Round 0
    processGateOverflow(baseInput({ round: 0, rippleBlockActive: true, gateBlockCounts: counts }))
    expect(counts.get("policy:ripple")?.count).toBe(1)

    // Round 1
    processGateOverflow(baseInput({ round: 1, rippleBlockActive: true, gateBlockCounts: counts }))
    expect(counts.get("policy:ripple")?.count).toBe(2)

    // Round 2
    processGateOverflow(baseInput({ round: 2, rippleBlockActive: true, gateBlockCounts: counts }))
    expect(counts.get("policy:ripple")?.count).toBe(3)
  })

  test("3 blocks → strategy switch message injected, not yet BLOCKED", () => {
    const counts = new Map<string, { count: number; lastSeen: number }>()

    // Build up to 2
    processGateOverflow(baseInput({ round: 0, rippleBlockActive: true, gateBlockCounts: counts }))
    processGateOverflow(baseInput({ round: 1, rippleBlockActive: true, gateBlockCounts: counts }))

    // 3rd round triggers switch
    const result = processGateOverflow(baseInput({ round: 2, rippleBlockActive: true, gateBlockCounts: counts }))

    expect(result.blocked).toBe(false)
    expect(result.deferredMessages.length).toBeGreaterThan(0)
    expect(result.deferredMessages[0]!).toContain("Gate overflow")
    expect(result.deferredMessages[0]!).toContain("multi_edit")
    expect(result.statusEvents).toContain("gate-overflow: policy:ripple blocked 3 times")
  })

  test("5 blocks → BLOCKED state", () => {
    const counts = new Map<string, { count: number; lastSeen: number }>()

    // Build up to 4
    for (let r = 0; r < 4; r++) {
      const result = processGateOverflow(baseInput({ round: r, rippleBlockActive: true, gateBlockCounts: counts }))
      if (r < 3) expect(result.blocked).toBe(false)
    }

    // 5th round triggers BLOCKED
    const result = processGateOverflow(baseInput({ round: 4, rippleBlockActive: true, gateBlockCounts: counts }))

    expect(result.blocked).toBe(true)
    expect(result.blockedGate).toBe("policy:ripple")
    expect(result.blockedCount).toBe(5)
  })

  test("7 blocks → definitely BLOCKED", () => {
    const counts = new Map<string, { count: number; lastSeen: number }>()

    for (let r = 0; r < 6; r++) {
      processGateOverflow(baseInput({ round: r, rippleBlockActive: true, gateBlockCounts: counts }))
    }
    const result = processGateOverflow(baseInput({ round: 6, rippleBlockActive: true, gateBlockCounts: counts }))

    expect(result.blocked).toBe(true)
    expect(counts.get("policy:ripple")?.count).toBe(7)
  })

  test("cleans stale entries after 2 rounds without a block", () => {
    const counts = new Map<string, { count: number; lastSeen: number }>()

    // Round 0: ripple blocked
    processGateOverflow(baseInput({ round: 0, rippleBlockActive: true, gateBlockCounts: counts }))
    expect(counts.has("policy:ripple")).toBe(true)

    // Round 1: nothing blocked — ripple was last seen at 0, round-0 = 1, < 2 so kept
    processGateOverflow(baseInput({ round: 1, gateBlockCounts: counts }))
    expect(counts.has("policy:ripple")).toBe(true)

    // Round 2: nothing blocked — round-0 = 2, >= 2 so cleaned
    processGateOverflow(baseInput({ round: 2, gateBlockCounts: counts }))
    expect(counts.has("policy:ripple")).toBe(false)
  })

  test("tracks multiple gates independently", () => {
    const counts = new Map<string, { count: number; lastSeen: number }>()

    processGateOverflow(baseInput({
      round: 0,
      rippleBlockActive: true,
      pendingRippleObligationsLength: 2,
      postToolPlanningPrompt: "plan again",
      gateBlockCounts: counts,
    }))

    expect(counts.get("policy:ripple")?.count).toBe(1)
    expect(counts.get("semantic:ripple_obligations")?.count).toBe(1)
    expect(counts.get("semantic:planning")?.count).toBe(1)
  })

  test("first gate to reach 5 blocks wins — BLOCKED gate is deterministic", () => {
    const counts = new Map<string, { count: number; lastSeen: number }>()

    // Ripple gets to 5, planning gets to 3
    for (let r = 0; r < 4; r++) {
      processGateOverflow(baseInput({
        round: r,
        rippleBlockActive: true,
        postToolPlanningPrompt: "try again",
        gateBlockCounts: counts,
      }))
    }

    const result = processGateOverflow(baseInput({
      round: 4,
      rippleBlockActive: true,
      postToolPlanningPrompt: "try again",
      gateBlockCounts: counts,
    }))

    expect(result.blocked).toBe(true)
    // The first gate in the iteration order of the map is the one that wins
    // (ripple since it was inserted first or planning depending on insertion order)
    expect(result.blockedGate).toBeDefined()
    expect(result.blockedCount).toBeGreaterThanOrEqual(5)
  })

  test("ripple_obligations at count 3 gives chain-fix message", () => {
    const counts = new Map<string, { count: number; lastSeen: number }>()

    for (let r = 0; r < 2; r++) {
      processGateOverflow(baseInput({ round: r, pendingRippleObligationsLength: 1, gateBlockCounts: counts }))
    }
    const result = processGateOverflow(baseInput({ round: 2, pendingRippleObligationsLength: 1, gateBlockCounts: counts }))

    expect(result.blocked).toBe(false)
    expect(result.deferredMessages[0]!).toContain("semantic:ripple_obligations")
    expect(result.deferredMessages[0]!).toContain("调用方")
  })

  test("planning at count 3 gives scope-reduction message", () => {
    const counts = new Map<string, { count: number; lastSeen: number }>()

    for (let r = 0; r < 2; r++) {
      processGateOverflow(baseInput({ round: r, postToolPlanningPrompt: "plan", gateBlockCounts: counts }))
    }
    const result = processGateOverflow(baseInput({ round: 2, postToolPlanningPrompt: "plan", gateBlockCounts: counts }))

    expect(result.blocked).toBe(false)
    expect(result.deferredMessages[0]!).toContain("planning")
    expect(result.deferredMessages[0]!).toContain("任务范围")
  })

  test("required_files at count 3 gives create-files message", () => {
    const counts = new Map<string, { count: number; lastSeen: number }>()

    for (let r = 0; r < 2; r++) {
      processGateOverflow(baseInput({ round: r, postToolRequiredFilesPrompt: "missing", gateBlockCounts: counts }))
    }
    const result = processGateOverflow(baseInput({ round: 2, postToolRequiredFilesPrompt: "missing", gateBlockCounts: counts }))

    expect(result.blocked).toBe(false)
    expect(result.deferredMessages[0]!).toContain("required_files")
    expect(result.deferredMessages[0]!).toContain("创建")
  })

  test("statusEvents reflect correct gate name", () => {
    const counts = new Map<string, { count: number; lastSeen: number }>()

    // Build to 3 for ripple
    for (let r = 0; r < 2; r++) {
      processGateOverflow(baseInput({ round: r, rippleBlockActive: true, gateBlockCounts: counts }))
    }
    const result = processGateOverflow(baseInput({ round: 2, rippleBlockActive: true, gateBlockCounts: counts }))

    expect(result.statusEvents[0]!).toBe("gate-overflow: policy:ripple blocked 3 times")
  })

  test("counts reset after being cleaned (stale cleanup works)", () => {
    const counts = new Map<string, { count: number; lastSeen: number }>()

    // Round 0: ripple blocked
    processGateOverflow(baseInput({ round: 0, rippleBlockActive: true, gateBlockCounts: counts }))
    expect(counts.get("policy:ripple")?.count).toBe(1)

    // Rounds 1-2: no blocks, entry goes stale at round 2 (2 rounds since lastSeen=0)
    processGateOverflow(baseInput({ round: 1, gateBlockCounts: counts }))
    processGateOverflow(baseInput({ round: 2, gateBlockCounts: counts }))
    expect(counts.has("policy:ripple")).toBe(false)

    // Round 3: ripple blocked again — should start fresh
    processGateOverflow(baseInput({ round: 3, rippleBlockActive: true, gateBlockCounts: counts }))
    expect(counts.get("policy:ripple")?.count).toBe(1)
  })
})
