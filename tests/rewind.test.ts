/** Tests for Unified Rewind (PR-4.3). */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { loadCheckpoint, registerCheckpointStore, unregisterCheckpointStore } from "../src/session/checkpoint"
import { SessionStore } from "../src/session/sqlite-session"
import {
  saveRewindPoint,
  listRewindPoints,
  executeRewind,
  formatRewindList,
  formatRewindResult,
  REWIND_MAX_DEPTH,
  type RewindMode,
} from "../src/agent/rewind"

// ── Temp dir setup ──

let testDir: string
let sessionId: string
let store: SessionStore
let originalCwd: string

beforeAll(() => {
  testDir = resolve(tmpdir(), `deepseek-rewind-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
  originalCwd = process.cwd()
  process.chdir(testDir)
  sessionId = `test-session-${Date.now().toString(36)}`
  store = new SessionStore(sessionId)
  registerCheckpointStore(sessionId, store)
})

afterAll(() => {
  process.chdir(originalCwd)
  unregisterCheckpointStore(sessionId)
  try { rmSync(testDir, { recursive: true, force: true }) } catch {}
})

beforeEach(() => {
  // Clean rewind dir between tests
  const rd = join(testDir, ".orcana", "rewind", sessionId)
  try { rmSync(rd, { recursive: true, force: true }) } catch {}
})

function createTestFile(relativePath: string, content: string): string {
  const abs = resolve(testDir, relativePath)
  mkdirSync(resolve(abs, ".."), { recursive: true })
  writeFileSync(abs, content, "utf-8")
  return abs
}

// ── saveRewindPoint / listRewindPoints ──

describe("saveRewindPoint & listRewindPoints", () => {
  it("saves and lists rewind points", () => {
    saveRewindPoint({
      sessionId,
      round: 1,
      summary: "Initial implementation",
      changedFiles: ["src/app.ts"],
      fileSHAs: {},
      conversationTokens: 5000,
    })

    const points = listRewindPoints(sessionId)
    expect(points.length).toBeGreaterThanOrEqual(1)
    expect(points[0]!.round).toBe(1)
    expect(points[0]!.summary).toBe("Initial implementation")
  })

  it("stores file content snapshots", () => {
    createTestFile("src/snapshot-test.ts", "const VERSION = 1\n")

    saveRewindPoint({
      sessionId,
      round: 2,
      summary: "After snapshot test",
      changedFiles: ["src/snapshot-test.ts"],
      fileSHAs: { "src/snapshot-test.ts": "abc123" },
      conversationTokens: 3000,
    })

    // Verify snapshot file exists
    const snapshotPath = join(testDir, ".orcana", "rewind", sessionId, "round-2.json")
    expect(existsSync(snapshotPath)).toBe(true)

    const snapshots = JSON.parse(readFileSync(snapshotPath, "utf-8")) as Record<string, unknown>
    expect(snapshots["src/snapshot-test.ts"]).toBeDefined()
  })

  it("returns empty list for unknown session", () => {
    const points = listRewindPoints("nonexistent-session")
    expect(points).toHaveLength(0)
  })

  it("sorts newest first", () => {
    saveRewindPoint({
      sessionId, round: 3, summary: "R3", changedFiles: [], fileSHAs: {}, conversationTokens: 1000,
    })
    saveRewindPoint({
      sessionId, round: 5, summary: "R5", changedFiles: [], fileSHAs: {}, conversationTokens: 2000,
    })
    saveRewindPoint({
      sessionId, round: 1, summary: "R1", changedFiles: [], fileSHAs: {}, conversationTokens: 500,
    })

    const points = listRewindPoints(sessionId)
    expect(points[0]!.round).toBe(5)
    expect(points[1]!.round).toBe(3)
    expect(points[2]!.round).toBe(1)
  })
})

// ── executeRewind ──

describe("executeRewind", () => {
  it("returns error for non-existent checkpoint", () => {
    const result = executeRewind({
      sessionId,
      targetRound: 999,
      mode: "code",
    })
    expect(result.success).toBe(false)
    expect(result.errors[0]).toContain("未找到")
  })

  it("restores files from snapshot (code mode)", () => {
    const filePath = createTestFile("src/rewind-code.ts", "original content\n")

    // Save rewind point with original content
    saveRewindPoint({
      sessionId,
      round: 10,
      summary: "Before modification",
      changedFiles: ["src/rewind-code.ts"],
      fileSHAs: { "src/rewind-code.ts": "orig" },
      conversationTokens: 1000,
    })

    // Modify the file
    writeFileSync(filePath, "modified content - should be reverted\n", "utf-8")

    // Rewind
    const result = executeRewind({
      sessionId,
      targetRound: 10,
      mode: "code",
    })

    expect(result.success).toBe(true)
    expect(result.restoredFiles).toContain("src/rewind-code.ts")
    expect(readFileSync(filePath, "utf-8")).toBe("original content\n")
  })

  it("restores from snapshot for both mode", () => {
    const fp = createTestFile("src/rewind-both.ts", "v1\n")

    saveRewindPoint({
      sessionId,
      round: 20,
      summary: "Before v2",
      changedFiles: ["src/rewind-both.ts"],
      fileSHAs: { "src/rewind-both.ts": "v1" },
      conversationTokens: 2000,
    })

    writeFileSync(fp, "v2 - should revert\n", "utf-8")

    const result = executeRewind({
      sessionId,
      targetRound: 20,
      mode: "both",
    })

    expect(result.success).toBe(true)
    expect(readFileSync(fp, "utf-8")).toBe("v1\n")
  })

  it("does not restore files in conversation-only mode", () => {
    const fp = createTestFile("src/rewind-conv.ts", "keep this\n")

    saveRewindPoint({
      sessionId,
      round: 30,
      summary: "Conv only",
      changedFiles: ["src/rewind-conv.ts"],
      fileSHAs: { "src/rewind-conv.ts": "keep" },
      conversationTokens: 500,
    })

    writeFileSync(fp, "do not revert\n", "utf-8")

    const result = executeRewind({
      sessionId,
      targetRound: 30,
      mode: "conversation",
    })

    expect(result.success).toBe(true)
    expect(result.restoredFiles).toHaveLength(0)
    // File should remain modified (conversation-only doesn't touch files)
    expect(readFileSync(fp, "utf-8")).toBe("do not revert\n")
  })

  it("handles deleted files (content is null)", () => {
    const fp = createTestFile("src/to-delete.ts", "will be deleted\n")

    // Save rewind point while file exists
    saveRewindPoint({
      sessionId,
      round: 40,
      summary: "Before deletion",
      changedFiles: ["src/to-delete.ts"],
      fileSHAs: {},
      conversationTokens: 100,
    })

    // Delete the file, then save another rewind point
    rmSync(fp, { force: true })
    saveRewindPoint({
      sessionId,
      round: 41,
      summary: "After deletion",
      changedFiles: ["src/to-delete.ts"],
      fileSHAs: {},
      conversationTokens: 100,
    })

    // Rewind back to round 40 (file existed) — should restore the file
    const restoreResult = executeRewind({
      sessionId,
      targetRound: 40,
      mode: "code",
    })
    expect(restoreResult.success).toBe(true)
    expect(restoreResult.restoredFiles).toContain("src/to-delete.ts")
    expect(existsSync(fp)).toBe(true)
    expect(readFileSync(fp, "utf-8")).toBe("will be deleted\n")

    // Rewind forward to round 41 (file was deleted) — should delete the file
    const deleteResult = executeRewind({
      sessionId,
      targetRound: 41,
      mode: "code",
    })
    expect(deleteResult.success).toBe(true)
    expect(deleteResult.deletedFiles).toContain("src/to-delete.ts")
    expect(existsSync(fp)).toBe(false)
  })
})

// ── formatRewindList ──

describe("formatRewindList", () => {
  it("formats empty list", () => {
    const out = formatRewindList([])
    expect(out).toContain("没有可用")
  })

  it("formats non-empty list", () => {
    const out = formatRewindList([
      { round: 5, timestamp: Date.now(), summary: "Test", changedFiles: ["a.ts"], fileCount: 3, conversationTokens: 5000 },
    ])
    expect(out).toContain("/rewind 5")
    expect(out).toContain("Test")
  })
})

// ── formatRewindResult ──

describe("formatRewindResult", () => {
  it("formats success", () => {
    const out = formatRewindResult({
      success: true,
      mode: "code",
      restoredFiles: ["src/a.ts"],
      deletedFiles: [],
      conversationTruncatedTo: 5,
      errors: [],
    })
    expect(out).toContain("已回退")
    expect(out).toContain("src/a.ts")
  })

  it("formats failure", () => {
    const out = formatRewindResult({
      success: false,
      mode: "both",
      restoredFiles: [],
      deletedFiles: [],
      conversationTruncatedTo: 10,
      errors: ["未找到 checkpoint"],
    })
    expect(out).toContain("回退失败")
    expect(out).toContain("未找到")
  })
})

// ── RC-11 H9: rewind 历史深度与清理 ──
// 使用独立 sessionId + store：本文件其他用例（executeRewind 系列）会写 round 40/41，
// 与深度用例共享同一 checkpoints 表会干扰"恰好保留 20 个最新"的断言。

describe("RC-11 H9 REWIND_HISTORY_DEPTH_AND_CLEANUP", () => {
  const depthSessionId = `h9-depth-${Date.now().toString(36)}`
  const depthStore = new SessionStore(depthSessionId)

  beforeAll(() => {
    registerCheckpointStore(depthSessionId, depthStore)
  })

  afterAll(() => {
    unregisterCheckpointStore(depthSessionId)
    depthStore.close()
  })

  beforeEach(() => {
    const rd = join(testDir, ".orcana", "rewind", depthSessionId)
    try { rmSync(rd, { recursive: true, force: true }) } catch {}
  })

  it("25 个 rewind 点 → 快照文件与 checkpoint 行都裁剪到 REWIND_MAX_DEPTH，最新可读", () => {
    for (let round = 1; round <= 25; round++) {
      saveRewindPoint({
        sessionId: depthSessionId,
        round,
        summary: `round ${round}`,
        changedFiles: [],
        fileSHAs: {},
        conversationTokens: round * 100,
      })
    }

    const files = readdirSync(join(testDir, ".orcana", "rewind", depthSessionId))
      .filter(f => f.startsWith("round-") && f.endsWith(".json"))
    expect(files.length).toBeLessThanOrEqual(REWIND_MAX_DEPTH)
    expect(files).toContain("round-25.json")
    expect(files).not.toContain("round-1.json")

    const points = listRewindPoints(depthSessionId)
    expect(points.length).toBeLessThanOrEqual(REWIND_MAX_DEPTH)
    expect(points[0]!.round).toBe(25)

    // 深度内 checkpoint 行可加载，超深行被清理
    expect(loadCheckpoint(depthSessionId, 25)).not.toBeNull()
    expect(loadCheckpoint(depthSessionId, 1)).toBeNull()
  })

  it("ORCANA_REWIND_MAX_DEPTH 可覆盖保留深度", () => {
    const saved = process.env.ORCANA_REWIND_MAX_DEPTH
    process.env.ORCANA_REWIND_MAX_DEPTH = "5"
    try {
      for (let round = 1; round <= 8; round++) {
        saveRewindPoint({
          sessionId: depthSessionId,
          round,
          summary: `env ${round}`,
          changedFiles: [],
          fileSHAs: {},
          conversationTokens: round * 50,
        })
      }
      const points = listRewindPoints(depthSessionId)
      expect(points).toHaveLength(5)
      expect(points[0]!.round).toBe(8)
      expect(points.some(p => p.round === 3)).toBe(false)
      expect(loadCheckpoint(depthSessionId, 3)).toBeNull()
      expect(loadCheckpoint(depthSessionId, 8)).not.toBeNull()
    } finally {
      if (saved === undefined) delete process.env.ORCANA_REWIND_MAX_DEPTH
      else process.env.ORCANA_REWIND_MAX_DEPTH = saved
    }
  })
})
