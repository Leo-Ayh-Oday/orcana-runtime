/** Tests for SessionLine field builder（Depthline P2）。
 *
 *  覆盖评审修正 #7：
 *    - 字段优先级链 blocked/error > running/idle > queue > mode > model > ctx > provider > branch
 *    - 错误/阻断状态永不被裁剪
 *    - 逐级降级表：≥120 / 80–119 / 60–79 / <60
 */

import { describe, expect, test } from "bun:test"
import { buildSessionLineFields, type SessionLineData } from "../../src/tui/components/SessionLine"

function baseData(overrides: Partial<SessionLineData> = {}): SessionLineData {
  return {
    mode: "executor",
    done: true,
    errorLine: "",
    status: "done",
    isWorking: false,
    queueCount: 0,
    provider: "anthropic",
    modelName: "claude-sonnet",
    branch: "main",
    repoRoot: "/home/user/orcana-runtime",
    ctxPct: 18,
    cachePct: 86,
    cols: 120,
    ...overrides,
  }
}

function keys(data: SessionLineData): string[] {
  return buildSessionLineFields(data).map(f => f.key)
}

describe("SessionLine field priority chain", () => {
  test("≥120 cols: branch · state · mode · provider/model · ctx · queue", () => {
    const k = keys(baseData({ queueCount: 2, done: false, isWorking: true, status: "thinking" }))
    expect(k).toEqual(["state", "mode", "queue", "model", "ctx", "cache", "branch"])
  })

  test("80–119 cols: state · mode · model · ctx · queue（无 branch/cache）", () => {
    const k = keys(baseData({ cols: 100, queueCount: 1 }))
    expect(k).toEqual(["state", "mode", "queue", "model", "ctx"])
  })

  test("60–79 cols: state · mode · short-model · queue（无 ctx）", () => {
    const k = keys(baseData({ cols: 70, queueCount: 0 }))
    expect(k).toEqual(["state", "mode", "model"])
  })

  test("<60 cols: state · mode · queue（无 model）", () => {
    const k = keys(baseData({ cols: 50, queueCount: 3 }))
    expect(k).toEqual(["state", "mode", "queue"])
  })

  test("error 状态永不裁剪（即使 <60 列，error 始终第一）", () => {
    const k = keys(baseData({ cols: 40, errorLine: "gate blocked: read-only root" }))
    expect(k[0]).toBe("state")
    expect(buildSessionLineFields(baseData({ cols: 40, errorLine: "boom" }))[0]!.text).toContain("boom")
  })

  test("state 标签：error 优先于 running/done/idle", () => {
    const fields = buildSessionLineFields(baseData({ errorLine: "denied", isWorking: true, done: false }))
    expect(fields[0]!.key).toBe("state")
    expect(fields[0]!.text).toContain("denied")
  })

  test("provider/model 组合为一个字段", () => {
    const fields = buildSessionLineFields(baseData({ cols: 100 }))
    const model = fields.find(f => f.key === "model")
    expect(model!.text).toBe("anthropic/claude-sonnet")
  })

  test("无 provider 时只用 model 名", () => {
    const fields = buildSessionLineFields(baseData({ cols: 100, provider: undefined }))
    const model = fields.find(f => f.key === "model")
    expect(model!.text).toBe("claude-sonnet")
  })

  test("queue 仅在 >0 时显示", () => {
    const k0 = keys(baseData({ queueCount: 0 }))
    expect(k0).not.toContain("queue")
    const k1 = keys(baseData({ queueCount: 1 }))
    expect(k1).toContain("queue")
  })

  test("running 状态标签派生自 status 文本", () => {
    const fields = buildSessionLineFields(baseData({ done: false, isWorking: true, status: "reading context" }))
    expect(fields[0]!.text).toBe("reading")
  })
})
