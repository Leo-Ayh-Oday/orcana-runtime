/** Tests for PR-8: RightRail 三态分类 + StatusBar blocked 降级。
 *
 *  覆盖 classifyRailState 纯函数：
 *    1. idle: ripplePhase=idle && gates=0 && patches=0 && activeTools=0
 *    2. blocked: ripplePhase=blocked OR gates.block>0
 *    3. running: 其余（active tools / 非 idle ripple / 有 evidence）
 *    4. blockedReason: 取第一条 block finding 的 reason
 */

import { describe, expect, test } from "bun:test"
import { classifyRailState } from "../../src/tui/components/RightRail"
import type { RightRailData } from "../../src/tui/state/selectors"

function makeBaseRail(overrides: Partial<RightRailData> = {}): RightRailData {
  return {
    round: 0,
    contextTokens: 0,
    contextMax: 200000,
    cacheHitRate: 0,
    cacheHits: [],
    rippleFindings: [],
    toolHistory: [],
    taskProgress: { done: 0, total: 0, current: "" },
    runtime: {
      ripplePhase: "idle",
      rippleFindings: [],
      gateSummary: { total: 0, pass: 0, block: 0, warn: 0, skip: 0 },
      evidenceSummary: { total: 0, passed: 0, failed: 0, blocked: 0, running: 0, skipped: 0 },
      patchSummary: { total: 0, proposed: 0, committed: 0, rolledBack: 0 },
      activeTools: 0,
    },
    ...overrides,
  }
}

// ── idle ──

describe("classifyRailState (PR-8): idle", () => {
  test("全空 → idle", () => {
    expect(classifyRailState(makeBaseRail()).state).toBe("idle")
  })

  test("有 evidence 但 ripple=idle 且无 tool/gate/patch → idle（evidence 是被动记录）", () => {
    const data = makeBaseRail({
      runtime: {
        ...makeBaseRail().runtime,
        evidenceSummary: { total: 1, passed: 1, failed: 0, blocked: 0, running: 0, skipped: 0 },
      },
    })
    // evidence 是历史记录，不表示当前活跃；ripple=idle 且无 activeTools 时为 idle
    expect(classifyRailState(data).state).toBe("idle")
  })

  test("有 patch 但 ripple=idle → running（patch 排除 idle）", () => {
    const data = makeBaseRail({
      runtime: {
        ...makeBaseRail().runtime,
        patchSummary: { total: 1, proposed: 0, committed: 1, rolledBack: 0 },
      },
    })
    expect(classifyRailState(data).state).toBe("running")
  })
})

// ── blocked ──

describe("classifyRailState (PR-8): blocked", () => {
  test("ripplePhase=blocked → blocked", () => {
    const data = makeBaseRail({
      runtime: { ...makeBaseRail().runtime, ripplePhase: "blocked" },
    })
    expect(classifyRailState(data).state).toBe("blocked")
  })

  test("gates.block>0 → blocked (即使 ripplePhase=idle)", () => {
    const data = makeBaseRail({
      runtime: {
        ...makeBaseRail().runtime,
        ripplePhase: "idle",
        gateSummary: { total: 1, pass: 0, block: 1, warn: 0, skip: 0 },
      },
    })
    expect(classifyRailState(data).state).toBe("blocked")
  })

  test("blocked 优先于 running（即使有 activeTools）", () => {
    const data = makeBaseRail({
      runtime: {
        ...makeBaseRail().runtime,
        ripplePhase: "blocked",
        activeTools: 3,
      },
    })
    expect(classifyRailState(data).state).toBe("blocked")
  })

  test("blockedReason: 取第一条 block finding 的 reason（截断 24 字符）", () => {
    const longReason = "This is a very long blocked reason that should be truncated to 24 chars"
    const data = makeBaseRail({
      runtime: { ...makeBaseRail().runtime, ripplePhase: "blocked" },
      rippleFindings: [
        { severity: "warn", file: "a.ts", reason: "warning reason" },
        { severity: "block", file: "b.ts", reason: longReason },
      ],
    })
    const result = classifyRailState(data)
    expect(result.state).toBe("blocked")
    expect(result.blockedReason).toBe(longReason.slice(0, 24))
  })

  test("blockedReason: 无 block finding 时为 undefined", () => {
    const data = makeBaseRail({
      runtime: { ...makeBaseRail().runtime, ripplePhase: "blocked" },
      rippleFindings: [],
    })
    const result = classifyRailState(data)
    expect(result.state).toBe("blocked")
    expect(result.blockedReason).toBeUndefined()
  })

  test("blockedReason: 跳过 warn finding 只取 block", () => {
    const data = makeBaseRail({
      runtime: { ...makeBaseRail().runtime, ripplePhase: "blocked" },
      rippleFindings: [
        { severity: "warn", file: "a.ts", reason: "should be skipped" },
      ],
    })
    const result = classifyRailState(data)
    expect(result.blockedReason).toBeUndefined()
  })
})

// ── running ──

describe("classifyRailState (PR-8): running", () => {
  test("activeTools>0 → running", () => {
    const data = makeBaseRail({
      runtime: { ...makeBaseRail().runtime, activeTools: 2 },
    })
    expect(classifyRailState(data).state).toBe("running")
  })

  test("ripplePhase=scan → running", () => {
    const data = makeBaseRail({
      runtime: { ...makeBaseRail().runtime, ripplePhase: "scan" },
    })
    expect(classifyRailState(data).state).toBe("running")
  })

  test("ripplePhase=propagate → running", () => {
    const data = makeBaseRail({
      runtime: { ...makeBaseRail().runtime, ripplePhase: "propagate" },
    })
    expect(classifyRailState(data).state).toBe("running")
  })

  test("ripplePhase=verify → running", () => {
    const data = makeBaseRail({
      runtime: { ...makeBaseRail().runtime, ripplePhase: "verify" },
    })
    expect(classifyRailState(data).state).toBe("running")
  })

  test("ripplePhase=settled → running（settled 不算 idle）", () => {
    const data = makeBaseRail({
      runtime: { ...makeBaseRail().runtime, ripplePhase: "settled" },
    })
    expect(classifyRailState(data).state).toBe("running")
  })

  test("有 gates.pass>0 但 block=0 → running", () => {
    const data = makeBaseRail({
      runtime: {
        ...makeBaseRail().runtime,
        gateSummary: { total: 1, pass: 1, block: 0, warn: 0, skip: 0 },
      },
    })
    expect(classifyRailState(data).state).toBe("running")
  })
})

// ── 完整生命周期 ──

describe("classifyRailState (PR-8): 生命周期", () => {
  test("idle → running → blocked → running → idle", () => {
    let data = makeBaseRail()
    expect(classifyRailState(data).state).toBe("idle")

    // 启动 scan
    data = makeBaseRail({
      runtime: { ...makeBaseRail().runtime, ripplePhase: "scan" },
    })
    expect(classifyRailState(data).state).toBe("running")

    // 阻塞
    data = makeBaseRail({
      runtime: { ...makeBaseRail().runtime, ripplePhase: "blocked" },
    })
    expect(classifyRailState(data).state).toBe("blocked")

    // 恢复
    data = makeBaseRail({
      runtime: { ...makeBaseRail().runtime, ripplePhase: "propagate" },
    })
    expect(classifyRailState(data).state).toBe("running")

    // 完成
    data = makeBaseRail()
    expect(classifyRailState(data).state).toBe("idle")
  })
})
