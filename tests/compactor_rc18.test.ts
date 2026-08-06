import { describe, expect, test, mock } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  addTurn,
  appendDeltaMemory,
  buildCompactionContext,
  buildCompactionPreview,
  buildDynamicMemoryContext,
  createBaseCheckpoint,
  createCompactor,
  type RunTrajectory,
} from "../src/memory/compactor"

const JUNK = (i: number) => `junk turn ${i}: plain filler without any signal`

function withWarmRecords(count: number, content: (i: number) => string) {
  const dir = mkdtempSync(join(tmpdir(), "orcana-rc18-"))
  let state = createCompactor(dir)
  for (let i = 0; i < count; i++) {
    state = addTurn(state, { role: i % 2 === 0 ? "user" : "assistant", content: content(i) })
  }
  return { state, dir }
}

describe("K12 M0_SUPERSEDABLE — M0 anchor can be corrected", () => {
  test("unchanged anchor when no new input is provided", () => {
    const { state, dir } = withWarmRecords(65, i => `decided to keep src/app${i}.ts stable`)
    try {
      const first = createBaseCheckpoint(state, { sessionId: "k12", thresholdTokens: 1, title: "Base" })
      const again = createBaseCheckpoint(first, { sessionId: "k12", thresholdTokens: 1, title: "Base" })
      expect(again.anchor?.id).toBe(first.anchor?.id)
      expect(again.anchor?.anchorVersion).toBe(1)
      expect(again.anchor?.digest).toBe(first.anchor?.digest)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("late-discovered obligation supersedes the anchor with audit trail", () => {
    const { state, dir } = withWarmRecords(65, i => `decided to keep src/app${i}.ts stable`)
    try {
      const first = createBaseCheckpoint(state, { sessionId: "k12", thresholdTokens: 1, title: "Base" })
      const firstId = first.anchor!.id
      const superseded = createBaseCheckpoint(first, {
        sessionId: "k12",
        thresholdTokens: 1,
        title: "Base",
        unresolvedObligations: ["cart.ts late finding"],
      })

      expect(superseded.anchor?.anchorVersion).toBe(2)
      expect(superseded.anchor?.supersedesId).toBe(firstId)
      expect(superseded.anchor?.digest).toContain("cart.ts late finding")
      // Old anchor material is merged, not dropped.
      expect(superseded.anchor?.digest).toContain("src/app0.ts")
      expect(superseded.manifest.unresolvedObligations).toContain("cart.ts late finding")

      // Re-applying the same input is idempotent — no further supersede.
      const again = createBaseCheckpoint(superseded, {
        sessionId: "k12",
        thresholdTokens: 1,
        title: "Base",
        unresolvedObligations: ["cart.ts late finding"],
      })
      expect(again.anchor?.anchorVersion).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("explicit supersede flag replaces title while keeping old decisions", () => {
    const { state, dir } = withWarmRecords(65, i => `decided to keep src/app${i}.ts stable`)
    try {
      const first = createBaseCheckpoint(state, { sessionId: "k12", thresholdTokens: 1, title: "Base v1" })
      const superseded = createBaseCheckpoint(first, {
        sessionId: "k12",
        thresholdTokens: 1,
        title: "Base v2",
        supersede: true,
      })
      expect(superseded.anchor?.anchorVersion).toBe(2)
      expect(superseded.anchor?.digest).toContain("Goal: Base v2")
      expect(superseded.anchor?.digest).toContain("src/app0.ts")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("K13 WARM_GIST_STRUCTURED_EXTRACTION — structured decision signals", () => {
  test("title-line extraction is highest confidence with source line", () => {
    const { state, dir } = withWarmRecords(21, i => (i === 0 ? "决定：改用方案B并保留缓存层" : JUNK(i)))
    try {
      const record = state.warmRecords[0]!
      expect(record.signals?.[0]?.source).toBe("header")
      expect(record.signals?.[0]?.confidence).toBe(1)
      expect(record.signals?.[0]?.line).toBe(1)
      expect(record.signals?.[0]?.text).toContain("改用方案B")
      expect(record.gist).toContain("signal=")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("verb-phrase extraction catches non-header decisions", () => {
    const { state, dir } = withWarmRecords(21, i => (i === 0 ? "我决定不再用 webpack 打包，改为 vite 构建" : JUNK(i)))
    try {
      const record = state.warmRecords[0]!
      const signal = record.signals?.find(s => s.source === "verb-phrase")
      expect(signal).toBeDefined()
      expect(signal!.confidence).toBeGreaterThanOrEqual(0.85)
      expect(signal!.text).toContain("我决定不再用 webpack")
      expect(record.gist).toContain("signal=")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("tool-result text corroborates the extraction", () => {
    const { state, dir } = withWarmRecords(21, i => (i === 0 ? "改用方案B：bun test 通过，typecheck 通过" : JUNK(i)))
    try {
      const signal = state.warmRecords[0]!.signals?.[0]!
      expect(signal.evidence).toContain("tool-result")
      expect(signal.confidence).toBeGreaterThan(0.6)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("trajectory verification corroborates extraction without changing text", () => {
    const dir = mkdtempSync(join(tmpdir(), "orcana-rc18-"))
    try {
      const trajectory: RunTrajectory = { verifications: [{ kind: "bun test", passed: true, atRound: 2 }] }
      let state = createCompactor(dir)
      state = addTurn(state, { role: "assistant", content: "我决定采用多轮编译" }, { trajectory })
      for (let i = 1; i < 21; i++) state = addTurn(state, { role: "user", content: JUNK(i) })
      const signal = state.warmRecords[0]!.signals?.[0]!
      expect(signal.evidence).toContain("verification-passed")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("K14 WARM_GIST_TAIL_PRESERVED — head+tail gist truncation", () => {
  test("tail constraints survive truncation with mid-ellipsis", () => {
    const head = "用户约束：保持模块边界不变"
    const tail = "尾部约束：此约束不得被截断"
    const content = `${head}${"x".repeat(300)}${tail}`
    const { state, dir } = withWarmRecords(21, i => (i === 0 ? content : JUNK(i)))
    try {
      const record = state.warmRecords[0]!
      expect(record.gist).toContain(head)
      expect(record.gist).toContain(tail)
      expect(record.gist).toContain("…")
      expect(record.gist).toContain("mid-truncated")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("short content is not touched", () => {
    const { state, dir } = withWarmRecords(21, i => (i === 0 ? "决定：短决策" : JUNK(i)))
    try {
      const record = state.warmRecords[0]!
      expect(record.gist).toContain("决定：短决策")
      expect(record.gist).not.toContain("…")
      expect(record.gist).not.toContain("mid-truncated")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("K15 CAP_LIMITS_NEVER_SILENT — omission manifest", () => {
  test("cap evictions are recorded with gist/reason/index and injected", () => {
    const { state, dir } = withWarmRecords(65, i => (i === 0 ? "决定：宝贵决策，绝不能被静默淘汰" : JUNK(i)))
    try {
      expect(state.omitted.length).toBe(5)
      for (const entry of state.omitted) {
        expect(entry.reason).toBe("cap")
        expect(typeof entry.index).toBe("number")
        expect(typeof entry.at).toBe("number")
        expect(entry.gist.length).toBeGreaterThan(0)
      }
      const context = buildCompactionContext(state)
      expect(context).toContain("## Memory Omissions")
      expect(context).toContain("已省略 5 条因上限 (cap)")
      const preview = buildCompactionPreview(state, { messageCount: 65 })
      expect(preview).toContain("Omission manifest: 5 entries")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("eviction is value-ordered, not mechanical tail", () => {
    const { state, dir } = withWarmRecords(70, i =>
      i === 0
        ? "我决定采用长线架构：维护 src/a.ts，通过 typecheck 验证完整性，并将模块边界保持稳定"
        : JUNK(i),
    )
    try {
      // Turn 0 is the oldest and highest-value; it must survive 10 evictions.
      expect(state.warmRecords.some(r => r.index === 1 && r.gist.includes("src/a.ts"))).toBe(true)
      expect(state.omitted.length).toBe(10)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("K16 COLD_ARCHIVE_COMPLETE_AND_ATOMIC — complete raw archive", () => {
  test("archive contains the complete raw message sequence plus gist map", () => {
    const { state, dir } = withWarmRecords(65, i => `archive source turn ${i}: decided to keep src/archive${i}.ts stable`)
    try {
      const withAnchor = createBaseCheckpoint(state, { sessionId: "k16", thresholdTokens: 1, title: "K16" })
      const payload = JSON.parse(readFileSync(withAnchor.anchor!.archivePath!, "utf-8"))
      expect(payload.turns.length).toBe(65)
      expect(payload.turns[0].content).toContain("archive source turn 0")
      expect(payload.turns[64].content).toContain("archive source turn 64")
      expect(payload.gists.length).toBe(40)
      expect(payload.gists[0].gist).toContain("signal=")
      expect(payload.omitted.length).toBe(5)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

})

describe("K17 DYNAMIC_MEMORY_BUDGET_ORDER_SAFE — conversation floor", () => {
  test("real conversation gets a guaranteed floor even under a tiny budget", () => {
    const { state, dir } = withWarmRecords(41, i => `conversation turn ${i} with plain words`)
    try {
      let withDeltas = appendDeltaMemory(state, { title: "Big delta A", summary: "x".repeat(3000) })
      withDeltas = appendDeltaMemory(withDeltas, { title: "Big delta B", summary: "y".repeat(3000) })
      const ctx = buildDynamicMemoryContext(withDeltas, { maxTokens: 300 })
      expect(ctx).toContain("## Earlier Conversation Digest")
      // The last two rounds are the floor — they must be present.
      expect(ctx).toContain("conversation turn 19")
      expect(ctx).toContain("conversation turn 20")
      // Memory trims are announced, never silent.
      expect(ctx).toContain("已省略 2 条记忆：budget")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("default budget keeps existing behavior — memory and conversation both present", () => {
    const { state, dir } = withWarmRecords(41, i => `conversation turn ${i} with plain words`)
    try {
      const withDeltas = appendDeltaMemory(state, { title: "Small delta", summary: "short" })
      const ctx = buildDynamicMemoryContext(withDeltas)
      expect(ctx).toContain("## Recent Delta Memories")
      expect(ctx).toContain("Small delta")
      expect(ctx).toContain("## Earlier Conversation Digest")
      expect(ctx).toContain("conversation turn 20")
      expect(ctx).not.toContain("已省略")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("K18 COMPACTOR_SEES_RUN_TRAJECTORY — optional trajectory input", () => {
  test("passed verification marks the warm record verified", () => {
    const dir = mkdtempSync(join(tmpdir(), "orcana-rc18-"))
    try {
      const trajectory: RunTrajectory = {
        toolCalls: [{ name: "multi_edit", ok: true, summary: "patched src/cart.ts" }],
        verifications: [{ kind: "bun test", passed: true, atRound: 3 }],
      }
      let state = createCompactor(dir)
      state = addTurn(state, { role: "assistant", content: "fixed the cart bug via multi_edit" }, { trajectory })
      for (let i = 1; i < 21; i++) state = addTurn(state, { role: "user", content: JUNK(i) })

      const record = state.warmRecords[0]!
      expect(record.verified).toBe(true)
      expect(record.gist).toContain("verified")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("without trajectory nothing changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "orcana-rc18-"))
    try {
      let state = createCompactor(dir)
      state = addTurn(state, { role: "assistant", content: "fixed the cart bug via multi_edit" })
      for (let i = 1; i < 21; i++) state = addTurn(state, { role: "user", content: JUNK(i) })

      const record = state.warmRecords[0]!
      expect(record.verified).toBe(false)
      expect(record.gist).not.toContain("verified")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("trajectory evidence lands in the M0 digest", () => {
    const { state, dir } = withWarmRecords(30, i => `decided to keep src/app${i}.ts stable`)
    try {
      const withAnchor = createBaseCheckpoint(state, {
        sessionId: "k18",
        thresholdTokens: 1,
        title: "K18",
        trajectory: {
          toolCalls: [{ name: "multi_edit", ok: true }],
          verifications: [{ kind: "typecheck", passed: true, atRound: 3 }],
          gateBlocks: [{ gate: "completion", round: 4 }],
        },
      })
      expect(withAnchor.anchor?.digest).toContain("Trajectory evidence:")
      expect(withAnchor.anchor?.digest).toContain("1 verification(s) passed | 1 tool call(s) ok | 1 gate block(s)")
      expect(withAnchor.anchor?.digest).toContain("typecheck passed (round 3)")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// Kept last: mock.module("node:fs") applies for the rest of this file.
describe("K16 atomicity — failure cleanup", () => {
  test("failed archive write leaves no half-written temp file", async () => {
    mock.module("node:fs", () => {
      const fs = require("node:fs") as typeof import("node:fs")
      return {
        ...fs,
        renameSync: (_from: unknown, _to: unknown) => {
          throw new Error("simulated rename failure")
        },
      }
    })
    const { createCompactor, saveColdArchive } = await import("../src/memory/compactor")
    const dir = mkdtempSync(join(tmpdir(), "orcana-archive-fail-"))
    try {
      const state = createCompactor(dir)
      state.hotTurns = [{ role: "user", content: "content that must never be half-written" }]
      state.estimatedTokens = 10
      expect(() => saveColdArchive(state, "sess")).toThrow("simulated rename failure")
      expect(readdirSync(join(dir, "archives"))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
