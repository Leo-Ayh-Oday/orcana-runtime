import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GateTelemetry } from "../src/agent/gates/telemetry"
import { GateChain } from "../src/agent/gates/chain"
import type { Gate, GateResult } from "../src/agent/gates/types"
import { createPreRoundChain } from "../src/agent/gates/pre-round"
import { createCompletionChain } from "../src/agent/gates/completion"
import { ContextBudgetGate } from "../src/agent/gates/context-budget"

// ── Helpers ──

function makeGate(name: string, pass: boolean, reason?: string): Gate<unknown> {
  return {
    name,
    evaluate: (): GateResult => ({ pass, reason }),
  }
}

function makeAsyncGate(name: string, pass: boolean, reason?: string): Gate<unknown> {
  return {
    name,
    evaluate: async (): Promise<GateResult> => ({ pass, reason }),
  }
}

// ── GateTelemetry ──

describe("GateTelemetry", () => {
  test("records pass and block outcomes", () => {
    const tel = new GateTelemetry()
    tel.record("semantic:ripple_exit", "pass")
    tel.record("semantic:ripple_exit", "block")
    tel.record("semantic:ripple_exit", "pass")

    const hit = tel.get("semantic:ripple_exit")!
    expect(hit.triggers).toBe(3)
    expect(hit.passes).toBe(2)
    expect(hit.blocks).toBe(1)
  })

  test("tracks multiple gates independently", () => {
    const tel = new GateTelemetry()
    tel.record("semantic:quality", "pass")
    tel.record("semantic:quality", "block")
    tel.record("semantic:ripple_exit", "block")

    expect(tel.get("semantic:quality")!.triggers).toBe(2)
    expect(tel.get("semantic:quality")!.blocks).toBe(1)
    expect(tel.get("semantic:ripple_exit")!.triggers).toBe(1)
    expect(tel.get("semantic:ripple_exit")!.blocks).toBe(1)
  })

  test("interceptRate returns blocks/triggers", () => {
    const tel = new GateTelemetry()
    tel.record("g", "pass")
    tel.record("g", "pass")
    tel.record("g", "block")

    expect(tel.interceptRate("g")).toBeCloseTo(1 / 3)
  })

  test("interceptRate returns 0 for unknown gate", () => {
    expect(new GateTelemetry().interceptRate("nope")).toBe(0)
  })

  test("falsePositiveRate returns FP/blocks", () => {
    const tel = new GateTelemetry()
    tel.record("g", "block")
    tel.record("g", "block")
    tel.record("g", "block")
    tel.markFalsePositive("g")

    expect(tel.falsePositiveRate("g")).toBeCloseTo(1 / 3)
  })

  test("falsePositiveRate returns 0 when no blocks", () => {
    const tel = new GateTelemetry()
    tel.record("g", "pass")
    tel.markFalsePositive("g") // no-op: gate has 0 blocks
    expect(tel.get("g")!.falsePositives).toBe(0)
    expect(tel.falsePositiveRate("g")).toBe(0)
  })

  test("markFalsePositive no-ops when gate has no blocks", () => {
    const tel = new GateTelemetry()
    tel.record("g", "block")
    tel.markFalsePositive("g")
    expect(tel.get("g")!.falsePositives).toBe(1)

    // No blocks → can't have false positives
    tel.markFalsePositive("never_blocked") // no-op, gate doesn't exist
    expect(tel.get("never_blocked")).toBeUndefined()
  })

  test("markMissed increments missed counter", () => {
    const tel = new GateTelemetry()
    tel.record("g", "pass")
    tel.markMissed("g")
    tel.markMissed("g")
    expect(tel.get("g")!.missed).toBe(2)
  })

  test("gateNames returns all recorded gate names", () => {
    const tel = new GateTelemetry()
    tel.record("a", "pass")
    tel.record("b", "block")
    expect(tel.gateNames().sort()).toEqual(["a", "b"])
  })

  test("summary returns compact string", () => {
    const tel = new GateTelemetry()
    tel.record("semantic:ripple_exit", "pass")
    tel.record("semantic:ripple_exit", "block")
    const s = tel.summary("semantic:ripple_exit")
    expect(s).toContain("semantic:ripple_exit")
    expect(s).toContain("2t")
    expect(s).toContain("1b")
    expect(s).toContain("1p")
    expect(s).toContain("50% int")
  })

  test("summary for unknown gate returns no-data message", () => {
    expect(new GateTelemetry().summary("nope")).toContain("no data")
  })

  test("report sorts by blocks descending", () => {
    const tel = new GateTelemetry()
    tel.record("low", "pass")
    tel.record("high", "block")
    tel.record("high", "block")
    tel.record("mid", "block")

    const r = tel.report()
    const lines = r.split("\n")
    const highIdx = lines.findIndex(l => l.includes("high"))
    const midIdx = lines.findIndex(l => l.includes("mid"))
    const lowIdx = lines.findIndex(l => l.includes("low"))
    expect(highIdx).toBeLessThan(midIdx)
    expect(midIdx).toBeLessThan(lowIdx)
  })

  test("empty report shows placeholder", () => {
    expect(new GateTelemetry().report()).toContain("No gate evaluations recorded")
  })

  test("toJSON and fromJSON round-trip", () => {
    const tel = new GateTelemetry()
    tel.record("a", "pass")
    tel.record("a", "block")
    tel.markFalsePositive("a")

    const json = tel.toJSON()
    const restored = GateTelemetry.fromJSON(json)
    expect(restored.get("a")!.triggers).toBe(2)
    expect(restored.get("a")!.blocks).toBe(1)
    expect(restored.get("a")!.falsePositives).toBe(1)
  })

  test("fromJSON skips malformed entries (non-finite numbers)", () => {
    const corrupted = {
      good: { triggers: 5, passes: 3, blocks: 2, falsePositives: 0, missed: 0 },
      bad_strings: { triggers: "oops", passes: 0, blocks: 0, falsePositives: 0, missed: 0 },
      bad_nan: { triggers: NaN, passes: 0, blocks: 0, falsePositives: 0, missed: 0 },
      bad_infinity: { triggers: Infinity, passes: 0, blocks: 0, falsePositives: 0, missed: 0 },
    }
    const tel = GateTelemetry.fromJSON(corrupted as any)
    expect(tel.gateNames()).toEqual(["good"])
    expect(tel.get("good")!.triggers).toBe(5)
  })

  test("fromJSON handles empty object", () => {
    const tel = GateTelemetry.fromJSON({})
    expect(tel.gateNames().length).toBe(0)
  })

  test("merge combines two telemetry instances additively", () => {
    const a = new GateTelemetry()
    a.record("g", "pass")
    a.record("g", "block")

    const b = new GateTelemetry()
    b.record("g", "block")
    b.markMissed("g")

    a.merge(b)
    expect(a.get("g")!.triggers).toBe(3)
    expect(a.get("g")!.passes).toBe(1)
    expect(a.get("g")!.blocks).toBe(2)
    expect(a.get("g")!.missed).toBe(1)
  })

  test("merge combines disjoint gate sets", () => {
    const a = new GateTelemetry()
    a.record("budget", "block")
    const b = new GateTelemetry()
    b.record("quality", "pass")
    b.record("quality", "block")

    a.merge(b)
    expect(a.gateNames().sort()).toEqual(["budget", "quality"])
    expect(a.get("budget")!.blocks).toBe(1)
    expect(a.get("budget")!.passes).toBe(0)
    expect(a.get("quality")!.passes).toBe(1)
    expect(a.get("quality")!.blocks).toBe(1)
  })

  test("reset clears all counters", () => {
    const tel = new GateTelemetry()
    tel.record("g", "block")
    tel.reset()
    expect(tel.gateNames().length).toBe(0)
  })

  test("saveToFile creates parent directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "gate-telemetry-"))
    try {
      const tel = new GateTelemetry()
      tel.record("policy:context_readiness", "block")
      const target = join(root, "nested", "telemetry.json")

      await tel.saveToFile(target)

      expect(existsSync(target)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── GateChain with telemetry ──

describe("GateChain with telemetry", () => {
  test("evaluateSync records pass for all passing gates", () => {
    const chain = GateChain.pipe([
      makeGate("a", true),
      makeGate("b", true),
      makeGate("c", true),
    ])
    const tel = new GateTelemetry()
    const result = chain.evaluateSync({}, tel)
    expect(result.pass).toBe(true)
    expect(tel.get("a")!.passes).toBe(1)
    expect(tel.get("b")!.passes).toBe(1)
    expect(tel.get("c")!.passes).toBe(1)
    expect(tel.get("a")!.blocks).toBe(0)
  })

  test("evaluateSync records block for the blocking gate, skips rest", () => {
    const chain = GateChain.pipe([
      makeGate("a", true),
      makeGate("b", false, "blocked_by_b"),
      makeGate("c", true),
    ])
    const tel = new GateTelemetry()
    const result = chain.evaluateSync({}, tel)
    expect(result.pass).toBe(false)
    expect(result.reason).toBe("blocked_by_b")
    expect(tel.get("a")!.passes).toBe(1)
    expect(tel.get("b")!.blocks).toBe(1)
    // Gate c was never evaluated (first block wins)
    expect(tel.get("c")).toBeUndefined()
  })

  test("evaluateSync records correctly when first gate blocks", () => {
    const chain = GateChain.pipe([
      makeGate("budget", false, "policy:context_budget"),
      makeGate("disclosure", true),
    ])
    const tel = new GateTelemetry()
    const result = chain.evaluateSync({}, tel)
    expect(result.pass).toBe(false)
    expect(tel.get("budget")!.blocks).toBe(1)
    expect(tel.get("disclosure")).toBeUndefined()
  })

  test("async evaluate records telemetry", async () => {
    const chain = GateChain.pipe([
      makeAsyncGate("async_a", true),
      makeAsyncGate("async_b", false, "nope"),
      makeAsyncGate("async_c", true),
    ])
    const tel = new GateTelemetry()
    const result = await chain.evaluate({}, tel)
    expect(result.pass).toBe(false)
    expect(tel.get("async_a")!.passes).toBe(1)
    expect(tel.get("async_b")!.blocks).toBe(1)
    expect(tel.get("async_c")).toBeUndefined()
  })

  test("evaluateWithTrace records telemetry for each gate", async () => {
    const chain = GateChain.pipe([
      makeAsyncGate("g1", true),
      makeAsyncGate("g2", true),
    ])
    const tel = new GateTelemetry()
    const { result, trace } = await chain.evaluateWithTrace({}, tel)
    expect(result.pass).toBe(true)
    expect(trace.length).toBe(2)
    expect(tel.get("g1")!.passes).toBe(1)
    expect(tel.get("g2")!.passes).toBe(1)
  })

  test("evaluateWithTrace stops trace and telemetry at blocking gate", async () => {
    const chain = GateChain.pipe([
      makeAsyncGate("g1", true),
      makeAsyncGate("g2", false, "blocked"),
      makeAsyncGate("g3", true),
    ])
    const tel = new GateTelemetry()
    const { result, trace } = await chain.evaluateWithTrace({}, tel)
    expect(result.pass).toBe(false)
    expect(trace.length).toBe(2) // g1 + g2 only, g3 skipped
    expect(trace[1]!.gateName).toBe("g2")
    expect(tel.get("g1")!.passes).toBe(1)
    expect(tel.get("g2")!.blocks).toBe(1)
    expect(tel.get("g3")).toBeUndefined()
  })

  test("async evaluate with undefined telemetry does not throw", async () => {
    const chain = GateChain.pipe([
      makeAsyncGate("a", true),
      makeAsyncGate("b", true),
    ])
    const result = await chain.evaluate({}) // no telemetry arg
    expect(result.pass).toBe(true)
  })

  test("evaluateSync throws on async gate even with telemetry", () => {
    const chain = GateChain.pipe([makeAsyncGate("async", true)])
    const tel = new GateTelemetry()
    expect(() => chain.evaluateSync({}, tel)).toThrow("Promise")
  })

  test("telemetry does not affect gate decisions", () => {
    // Same chain, same context — with and without telemetry should produce same result
    const chain = GateChain.pipe([
      makeGate("a", true),
      makeGate("b", false, "stop"),
    ])
    const without = chain.evaluateSync({})
    const withTel = chain.evaluateSync({}, new GateTelemetry())
    expect(withTel.pass).toBe(without.pass)
    expect(withTel.reason).toBe(without.reason)
  })

  test("all gates pass, no blocks, telemetry shows 0% intercept across all", () => {
    const chain = GateChain.pipe([
      makeGate("a", true),
      makeGate("b", true),
    ])
    const tel = new GateTelemetry()
    chain.evaluateSync({}, tel)
    expect(tel.interceptRate("a")).toBe(0)
    expect(tel.interceptRate("b")).toBe(0)
  })

  // ── Integration: PreRoundChain behavior with telemetry ──

  test("createPreRoundChain records all 4 gates in order", () => {
    const chain = createPreRoundChain()
    const tel = new GateTelemetry()

    // Minimal context that lets all gates pass
    const ctx = {
      round: 0,
      roundInputTokens: 1000,
      contextMax: 100_000,
      fullTools: [],
      tools: [],
      rippleReports: [],
      pendingRippleObligations: [],
      intentReadonly: false,
      taskPlanning: false,
      cacheStableTools: true, // bypasses disclosure + readonly + ripple filters
      disclosureContextText: "",
      contextBudgetMode: "normal" as const,
      contextBudgetPercent: 0,
      budgetMessage: null,
      announcedDegraded: false,
      rippleBlockActive: false,
      tokensSaved: 0,
      activeTools: [],
    }

    chain.evaluateSync(ctx, tel)
    const names = tel.gateNames().sort()
    expect(names).toContain("policy:context_budget")
    expect(names).toContain("policy:tool_disclosure")
    expect(names).toContain("policy:readonly_plan")
    expect(names).toContain("policy:ripple_tool_filter")
    // All should pass with cacheStableTools=true
    for (const name of names) {
      expect(tel.get(name)!.blocks).toBe(0)
    }
  })

  test("ContextBudgetGate blocks when ratio >= block ratio", () => {
    const gate = new ContextBudgetGate()
    const tel = new GateTelemetry()

    // Simulate context at 90% — well above default block ratio (0.6)
    const ctx = {
      round: 0, roundInputTokens: 90_000, contextMax: 100_000,
      fullTools: [], tools: [], rippleReports: [],
      pendingRippleObligations: [], intentReadonly: false,
      taskPlanning: false, cacheStableTools: true,
      disclosureContextText: "",
      contextBudgetMode: "normal" as const, contextBudgetPercent: 0,
      budgetMessage: null, announcedDegraded: false,
      rippleBlockActive: false, tokensSaved: 0, activeTools: [],
    }
    const result = gate.evaluate(ctx)
    expect(result.pass).toBe(false)
    expect(result.reason).toBe("context_budget_block")

    // Wire through chain as well
    const chain = GateChain.pipe([gate])
    const tel2 = new GateTelemetry()
    const chainResult = chain.evaluateSync(ctx, tel2)
    expect(chainResult.pass).toBe(false)
    expect(tel2.get("policy:context_budget")!.blocks).toBe(1)
  })

  test("RippleExitGate blocks completion with pending obligations in write mode", () => {
    const chain = createCompletionChain()
    const tel = new GateTelemetry()

    const ctx = {
      round: 0,
      finalText: "done",
      intentPolicy: { mode: "full", reason: "user asked to implement" },
      taskTracker: null,
      pendingRippleObligations: [{ caller: { file: "cart.ts", line: 3, symbol: "loadUser", text: "loadUser()" }, symbol: "loadUser", targetFile: "api.ts", reason: "symbol_moved" }],
      taskHadWrite: true,
      taskToolErrors: 0,
      taskModifiedFiles: 1,
      lastTypecheck: undefined,
      lastRippleReports: [],
      lastVerificationResults: [],
      planApproved: false,
      planningRejections: 0,
      maxRounds: 20,
      priorTools: ["edit_file"],
      priorFiles: new Set(["api.ts"]),
      confidenceEvaluator: {
        evaluateSync: () => ({ recommendation: "done", confidence: 0.95 }),
        evaluate: async () => ({ recommendation: "done", confidence: 0.95 }),
        scoreWithLLM: async () => ({ overall: 0.95 }),
        buildSummary: () => "",
      } as unknown as import("../src/evaluator/confidence").ConfidenceEvaluator,
      completionBlockMessage: null,
      shouldBreak: false,
      breakEvent: null,
      statusMessage: "",
      injectMessages: [],
      traceEvent: null,
    }

    chain.evaluateSync(ctx, tel)
    // ripple_exit should block first with pending obligations
    expect(tel.get("semantic:ripple_exit")!.blocks).toBe(1)
    expect(ctx.completionBlockMessage).not.toBeNull()
  })

  test("createCompletionChain records all 4 gates in order", () => {
    const chain = createCompletionChain()
    const tel = new GateTelemetry()

    // Minimal context that lets all gates pass (readonly mode skips most)
    const ctx = {
      round: 0,
      finalText: "done",
      intentPolicy: { mode: "readonly", reason: "user asked for info" },
      taskTracker: null,
      pendingRippleObligations: [],
      taskHadWrite: false,
      taskToolErrors: 0,
      taskModifiedFiles: 0,
      lastTypecheck: undefined,
      lastRippleReports: [],
      lastVerificationResults: [],
      planApproved: false,
      planningRejections: 0,
      maxRounds: 20,
      priorTools: [],
      priorFiles: new Set<string>(),
      confidenceEvaluator: {
        evaluateSync: () => ({ recommendation: "done", confidence: 0.95 }),
        evaluate: async () => ({ recommendation: "done", confidence: 0.95 }),
        scoreWithLLM: async () => ({ overall: 0.95 }),
        buildSummary: () => "",
      } as unknown as import("../src/evaluator/confidence").ConfidenceEvaluator,
      completionBlockMessage: null,
      shouldBreak: false,
      breakEvent: null,
      statusMessage: "",
      injectMessages: [],
      traceEvent: null,
    }

    chain.evaluateSync(ctx, tel)
    const names = tel.gateNames().sort()
    expect(names).toContain("semantic:ripple_exit")
    expect(names).toContain("semantic:planning_artifact")
    expect(names).toContain("semantic:task_tracker")
    expect(names).toContain("semantic:quality")
    // All should pass in readonly mode
    for (const name of names) {
      expect(tel.get(name)!.blocks).toBe(0)
    }
  })
})
