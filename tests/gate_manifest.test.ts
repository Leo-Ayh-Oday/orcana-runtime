import { describe, expect, test } from "bun:test"
import { GateTelemetry } from "../src/agent/gates/telemetry"
import { generateManifest, manifestReport } from "../src/agent/gates/manifest"

describe("generateManifest", () => {
  test("classifies pass-through filters correctly", () => {
    const tel = new GateTelemetry()
    tel.record("policy:tool_disclosure", "pass")
    tel.record("policy:readonly_plan", "pass")
    tel.record("policy:ripple_tool_filter", "pass")

    const m = generateManifest(tel)
    expect(m.summary.pass_through).toBe(3)
    for (const v of m.verdicts) {
      expect(v.decision).toBe("pass_through")
    }
  })

  test("classifies safety nets with 0% FP", () => {
    const tel = new GateTelemetry()
    // context_budget never blocked but triggered — safety net
    tel.record("policy:context_budget", "pass")
    tel.record("policy:context_budget", "pass")

    const m = generateManifest(tel)
    const v = m.verdicts.find(x => x.gate === "policy:context_budget")!
    expect(v.decision).toBe("safety_net")
  })

  test("high intercept + low FP → keep", () => {
    const tel = new GateTelemetry()
    // 30% intercept, 0% FP
    tel.record("semantic:ripple_exit", "pass")
    tel.record("semantic:ripple_exit", "pass")
    tel.record("semantic:ripple_exit", "pass")
    tel.record("semantic:ripple_exit", "pass")
    tel.record("semantic:ripple_exit", "pass")
    tel.record("semantic:ripple_exit", "pass")
    tel.record("semantic:ripple_exit", "block")
    tel.record("semantic:ripple_exit", "block")
    tel.record("semantic:ripple_exit", "block") // 3/9 = 33%

    const m = generateManifest(tel)
    const v = m.verdicts.find(x => x.gate === "semantic:ripple_exit")!
    expect(v.decision).toBe("keep")
    expect(v.interceptRate).toBeCloseTo(3 / 9)
  })

  test("high intercept + high FP → tune", () => {
    const tel = new GateTelemetry()
    // 25% intercept, 40% FP
    tel.record("policy:planning_phase", "pass")
    tel.record("policy:planning_phase", "pass")
    tel.record("policy:planning_phase", "pass")
    tel.record("policy:planning_phase", "block") // 1/4 = 25%
    tel.markFalsePositive("policy:planning_phase") // 1/1 = 100% FP (triggers tune)

    const m = generateManifest(tel)
    const v = m.verdicts.find(x => x.gate === "policy:planning_phase")!
    expect(v.decision).toBe("tune")
  })

  test("moderate intercept → observe", () => {
    const tel = new GateTelemetry()
    // 10% intercept
    for (let i = 0; i < 9; i++) tel.record("gate", "pass")
    tel.record("gate", "block") // 1/10 = 10%

    const m = generateManifest(tel)
    const v = m.verdicts.find(x => x.gate === "gate")!
    expect(v.decision).toBe("observe")
  })

  test("very low intercept with data → delete", () => {
    const tel = new GateTelemetry()
    // 2% intercept over 50 triggers
    for (let i = 0; i < 49; i++) tel.record("gate", "pass")
    tel.record("gate", "block") // 1/50 = 2%

    const m = generateManifest(tel)
    const v = m.verdicts.find(x => x.gate === "gate")!
    expect(v.decision).toBe("delete")
  })

  test("low intercept with insufficient data → observe", () => {
    const tel = new GateTelemetry()
    // 0% intercept but only 5 triggers — not enough data to delete
    for (let i = 0; i < 5; i++) tel.record("gate", "pass")

    const m = generateManifest(tel)
    const v = m.verdicts.find(x => x.gate === "gate")!
    expect(v.decision).toBe("observe")
    expect(v.action).toContain("insufficient data")
  })

  test("missed > 0 → keep (critical signal)", () => {
    const tel = new GateTelemetry()
    tel.record("semantic:quality", "pass")
    tel.record("semantic:quality", "pass")
    tel.markMissed("semantic:quality")
    tel.markMissed("semantic:quality")

    const m = generateManifest(tel)
    const v = m.verdicts.find(x => x.gate === "semantic:quality")!
    expect(v.decision).toBe("keep")
    expect(v.action).toContain("漏拦")
  })

  test("verdicts sorted: keep first, pass_through last", () => {
    const tel = new GateTelemetry()
    tel.record("policy:tool_disclosure", "pass") // pass_through
    tel.record("policy:context_budget", "pass")  // safety_net
    // ripple_exit: 30% intercept → keep
    tel.record("semantic:ripple_exit", "pass")
    tel.record("semantic:ripple_exit", "pass")
    tel.record("semantic:ripple_exit", "block")
    // gate: 10% → observe
    for (let i = 0; i < 9; i++) tel.record("low", "pass")
    tel.record("low", "block")
    // 2% over 50 → delete
    for (let i = 0; i < 49; i++) tel.record("dead", "pass")
    tel.record("dead", "block")

    const m = generateManifest(tel)
    const decisions = m.verdicts.map(v => v.decision)
    const keepIdx = decisions.indexOf("keep")
    const safetyIdx = decisions.indexOf("safety_net")
    const observeIdx = decisions.indexOf("observe")
    const deleteIdx = decisions.indexOf("delete")
    const ptIdx = decisions.indexOf("pass_through")

    expect(keepIdx).toBeLessThan(safetyIdx)
    expect(safetyIdx).toBeLessThan(observeIdx)
    expect(observeIdx).toBeLessThan(deleteIdx)
    expect(deleteIdx).toBeLessThan(ptIdx)
  })

  test("empty telemetry produces empty manifest", () => {
    const m = generateManifest(new GateTelemetry())
    expect(m.verdicts.length).toBe(0)
    expect(m.summary.keep).toBe(0)
  })

  test("manifestReport includes all sections", () => {
    const tel = new GateTelemetry()
    tel.record("semantic:ripple_exit", "block")
    tel.record("semantic:ripple_exit", "pass")
    tel.record("policy:tool_disclosure", "pass")

    const m = generateManifest(tel)
    const report = manifestReport(m)

    expect(report).toContain("# Gate Manifest v1")
    expect(report).toContain("Summary")
    expect(report).toContain("Verdicts")
    expect(report).toContain("ripple_exit")
    expect(report).toContain("tool_disclosure")
    expect(report).toContain("⏩ pass_through")
  })
})

describe("GateTelemetry file persistence", () => {
  test("saveToFile and loadFromFile round-trip", async () => {
    const tel = new GateTelemetry()
    tel.record("a", "pass")
    tel.record("a", "block")
    tel.markFalsePositive("a")

    const tmpFile = `tests/tmp/telemetry-roundtrip-${Date.now()}.json`
    await tel.saveToFile(tmpFile)

    const restored = await GateTelemetry.loadFromFile(tmpFile)
    expect(restored.get("a")!.triggers).toBe(2)
    expect(restored.get("a")!.blocks).toBe(1)
    expect(restored.get("a")!.falsePositives).toBe(1)
  })

  test("loadFromFile returns empty telemetry for missing file", async () => {
    const tel = await GateTelemetry.loadFromFile("tests/tmp/does-not-exist.json")
    expect(tel.gateNames().length).toBe(0)
  })
})
