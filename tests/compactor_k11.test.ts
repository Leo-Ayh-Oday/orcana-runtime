import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addTurn, createBaseCheckpoint, createCompactor } from "../src/memory/compactor"

// RC-11 K11 (M0_NO_PROTECTION_WINDOW): M0 锚默认阈值 0 → 首轮即建，消除 50k
// 阈值前的保护空窗；锚已存在且无新材料时不 churn（K12 hasNewMaterial 判定）。

describe("RC-11 K11 M0_NO_PROTECTION_WINDOW", () => {
  test("默认阈值 0 → 首轮（低 token 状态）即建锚，保护空窗关闭", () => {
    const dir = mkdtempSync(join(tmpdir(), "orcana-k11-"))
    try {
      let state = createCompactor(dir)
      state = addTurn(state, { role: "user", content: "第一个用户请求" })
      // 不传 thresholdTokens：默认 0，任何 token 量都直接建锚
      const anchored = createBaseCheckpoint(state, { sessionId: "k11", title: "K11 首轮锚" })
      expect(anchored.anchor).toBeDefined()
      expect(anchored.anchor!.anchorVersion).toBe(1)
      expect(anchored.anchor!.digest.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("锚已存在且无新材料 → 不 churn（id/version 不变）", () => {
    const dir = mkdtempSync(join(tmpdir(), "orcana-k11-"))
    try {
      let state = createCompactor(dir)
      state = addTurn(state, { role: "user", content: "继续" })
      const first = createBaseCheckpoint(state, { sessionId: "k11", title: "base" })
      const again = createBaseCheckpoint(first, { sessionId: "k11", title: "base" })
      expect(again.anchor?.id).toBe(first.anchor?.id)
      expect(again.anchor?.anchorVersion).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
