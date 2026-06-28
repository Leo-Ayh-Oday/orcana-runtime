/** Tests for PatchTransaction (PR 5). */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createTransaction } from "../src/tools/transaction"
import {
  computeBaseHash,
  readFileHash,
  checkBaseHash,
  checkForbiddenFile,
  generateLineDiff,
  formatDiff,
  createPatchTransaction,
  preWriteCheck,
  setActivePatchContext,
  getActivePatchContext,
  clearActivePatchContext,
  serializePatchTransaction,
  // PR-4.1 state machine
  initManagedTransaction,
  applyToTemp,
  verifyManagedTransaction,
  commitManagedTransaction,
  rollbackManagedTransaction,
  applyAndCommit,
  getManagedTransaction,
  getAllManagedTransactions,
  clearTransactionRegistry,
  type ManagedPatchTransaction,
  type PatchState,
} from "../src/agent/patch-transaction"

// ── Temp dir setup ──

let testDir: string

beforeAll(() => {
  testDir = resolve(tmpdir(), `deepseek-ptxn-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
})

afterAll(() => {
  try { rmSync(testDir, { recursive: true, force: true }) } catch {}
  clearActivePatchContext()
})

beforeEach(() => {
  clearActivePatchContext()
})

function writeTestFile(name: string, content: string): string {
  const p = join(testDir, name)
  mkdirSync(join(testDir, name, ".."), { recursive: true })
  writeFileSync(p, content, "utf-8")
  return p
}

// ── computeBaseHash ──

describe("computeBaseHash", () => {
  it("returns 16-char hex hash", () => {
    const h = computeBaseHash("hello")
    expect(h.length).toBe(16)
    expect(/^[0-9a-f]+$/.test(h)).toBe(true)
  })

  it("is deterministic", () => {
    expect(computeBaseHash("hello")).toBe(computeBaseHash("hello"))
  })

  it("differs for different content", () => {
    expect(computeBaseHash("hello")).not.toBe(computeBaseHash("world"))
  })
})

// ── readFileHash ──

describe("readFileHash", () => {
  it("returns null for non-existent file", () => {
    expect(readFileHash(join(testDir, "nonexistent.txt"))).toBeNull()
  })

  it("returns hash for existing file", () => {
    const p = writeTestFile("hash-test.txt", "content here")
    expect(readFileHash(p)).toBe(computeBaseHash("content here"))
  })
})

// ── checkBaseHash ──

describe("checkBaseHash", () => {
  it("returns match for null expected (new file)", () => {
    const result = checkBaseHash(join(testDir, "new.txt"), null)
    expect(result.match).toBe(true)
    expect(result.expected).toBeNull()
  })

  it("returns match when hash matches", () => {
    const p = writeTestFile("match.txt", "test")
    const h = computeBaseHash("test")
    expect(checkBaseHash(p, h).match).toBe(true)
  })

  it("returns mismatch when hash differs", () => {
    const p = writeTestFile("mismatch.txt", "original")
    const h = computeBaseHash("different")
    expect(checkBaseHash(p, h).match).toBe(false)
  })

  it("returns mismatch when file deleted", () => {
    const result = checkBaseHash(join(testDir, "gone.txt"), "abc123")
    expect(result.match).toBe(false)
    expect(result.actual).toBeNull()
  })
})

// ── checkForbiddenFile ──

describe("checkForbiddenFile", () => {
  it("allows normal project file", () => {
    expect(checkForbiddenFile("src/app.ts", testDir).allowed).toBe(true)
  })

  it("rejects .git/ internals", () => {
    expect(checkForbiddenFile(".git/config", testDir).allowed).toBe(false)
  })

  it("rejects .deepseek-code/ internals", () => {
    expect(checkForbiddenFile(".deepseek-code/config.json", testDir).allowed).toBe(false)
  })

  it("rejects node_modules/", () => {
    expect(checkForbiddenFile("node_modules/pkg/index.js", testDir).allowed).toBe(false)
  })

  it("rejects paths outside project root", () => {
    const result = checkForbiddenFile("../outside/file.ts", testDir)
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("项目根目录之外")
  })

  it("rejects .gitignore (in FORBIDDEN_EXACT)", () => {
    expect(checkForbiddenFile(".gitignore", testDir).allowed).toBe(false)
  })

  it("rejects case-variant .GITIGNORE (Windows bypass)", () => {
    expect(checkForbiddenFile(".GITIGNORE", testDir).allowed).toBe(false)
  })

  it("rejects case-variant .Git/config (Windows bypass)", () => {
    expect(checkForbiddenFile(".Git/config", testDir).allowed).toBe(false)
  })

  it("rejects .env (secret file protection)", () => {
    const result = checkForbiddenFile(".env", testDir)
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("敏感文件")
  })

  it("rejects .pem (credential file protection)", () => {
    const result = checkForbiddenFile("server.pem", testDir)
    expect(result.allowed).toBe(false)
  })

  it("rejects id_rsa (SSH key protection)", () => {
    const result = checkForbiddenFile("id_rsa", testDir)
    expect(result.allowed).toBe(false)
  })
})

// ── generateLineDiff ──

describe("generateLineDiff", () => {
  it("handles new file creation", () => {
    const diff = generateLineDiff(null, "line1\nline2\n", "src/new.ts")
    expect(diff.header).toContain("/dev/null")
    expect(diff.stats.added).toBeGreaterThan(0)
    expect(diff.hunks.length).toBeGreaterThan(0)
  })

  it("counts added/removed/unchanged lines", () => {
    const diff = generateLineDiff(
      "line1\nline2\nline3\n",
      "line1\nline2-new\nline3\nline4\n",
      "src/mod.ts",
    )
    // line1: unchanged, line3: unchanged
    expect(diff.stats.unchanged).toBe(2)
    // line2→line2-new: removed old + added new
    // line4: added
    expect(diff.stats.removed).toBe(1) // line2 was removed
    expect(diff.stats.added).toBe(2)   // line2-new + line4 added
  })

  it("handles identical content", () => {
    const diff = generateLineDiff("a\nb\n", "a\nb\n", "same.ts")
    expect(diff.stats.added).toBe(0)
    expect(diff.stats.removed).toBe(0)
    expect(diff.stats.unchanged).toBe(2)
  })
})

// ── formatDiff ──

describe("formatDiff", () => {
  it("produces readable diff string", () => {
    const diff = generateLineDiff(null, "hello\nworld\n", "new.ts")
    const formatted = formatDiff(diff)
    expect(formatted).toContain("new.ts")
    expect(formatted).toContain("统计")
  })
})

// ── Active patch context ──

describe("active patch context", () => {
  it("returns null by default", () => {
    expect(getActivePatchContext()).toBeNull()
  })

  it("returns set context", () => {
    setActivePatchContext({ scope: ["a.ts"], verification: ["typecheck"], nodeId: "1" })
    const ctx = getActivePatchContext()
    expect(ctx).not.toBeNull()
    expect(ctx!.scope).toEqual(["a.ts"])
    expect(ctx!.verification).toEqual(["typecheck"])
    expect(ctx!.nodeId).toBe("1")
  })

  it("can be cleared", () => {
    setActivePatchContext({ scope: ["b.ts"], verification: ["test"], nodeId: "2" })
    clearActivePatchContext()
    expect(getActivePatchContext()).toBeNull()
  })
})

// ── createPatchTransaction ──

describe("createPatchTransaction", () => {
  it("creates transaction for new file", () => {
    const ft = createTransaction({ tool: "write_file", paths: [join(testDir, "new.ts")], cwd: testDir })
    const pt = createPatchTransaction({
      tool: "write_file",
      path: "src/new.ts",
      oldContent: null,
      newContent: "export const x = 1\n",
      fileTransaction: ft,
      cwd: testDir,
    })
    expect(pt.txId).toMatch(/^ptxn_/)
    expect(pt.baseHash).toBeNull()
    expect(pt.diff.length).toBeGreaterThan(0)
    expect(pt.forbiddenCheck.passed).toBe(true)
  })

  it("rejects forbidden files", () => {
    const ft = createTransaction({ tool: "write_file", paths: [join(testDir, ".git/config")], cwd: testDir })
    const pt = createPatchTransaction({
      tool: "write_file",
      path: ".git/config",
      oldContent: null,
      newContent: "bad",
      fileTransaction: ft,
      cwd: testDir,
    })
    expect(pt.forbiddenCheck.passed).toBe(false)
  })

  it("uses active patch context scope", () => {
    setActivePatchContext({ scope: ["active/a.ts"], verification: ["typecheck"], nodeId: "3" })
    const ft = createTransaction({ tool: "edit_file", paths: [join(testDir, "test.ts")], cwd: testDir })
    const pt = createPatchTransaction({
      tool: "edit_file",
      path: "test.ts",
      oldContent: "old",
      newContent: "new",
      fileTransaction: ft,
      cwd: testDir,
    })
    expect(pt.scope).toEqual(["active/a.ts"])
    expect(pt.verification).toEqual(["typecheck"])
  })

  it("override scope takes precedence over active context", () => {
    setActivePatchContext({ scope: ["ctx.ts"], verification: ["lint"], nodeId: "4" })
    const ft = createTransaction({ tool: "write_file", paths: [join(testDir, "override.ts")], cwd: testDir })
    const pt = createPatchTransaction({
      tool: "write_file",
      path: "override.ts",
      oldContent: null,
      newContent: "x",
      fileTransaction: ft,
      scope: ["override.ts"],
      verification: ["test"],
      cwd: testDir,
    })
    expect(pt.scope).toEqual(["override.ts"])
    expect(pt.verification).toEqual(["test"])
  })
})

// ── preWriteCheck ──

describe("preWriteCheck", () => {
  it("allows valid write", () => {
    const p = writeTestFile("pre-check.ts", "const x = 1\n")
    const ft = createTransaction({ tool: "edit_file", paths: [p], cwd: testDir })
    const baseHash = computeBaseHash("const x = 1\n")
    const result = preWriteCheck({
      tool: "edit_file",
      path: "pre-check.ts",
      oldContent: "const x = 1\n",
      newContent: "const x = 2\n",
      expectedBaseHash: baseHash,
      fileTransaction: ft,
      cwd: testDir,
    })
    expect(result.allowed).toBe(true)
    expect(result.patchTransaction).toBeDefined()
    expect(result.patchTransaction!.baseHash).toBe(baseHash)
  })

  it("rejects forbidden file", () => {
    const ft = createTransaction({ tool: "write_file", paths: [join(testDir, ".git/HEAD")], cwd: testDir })
    const result = preWriteCheck({
      tool: "write_file",
      path: ".git/HEAD",
      oldContent: null,
      newContent: "bad",
      fileTransaction: ft,
      cwd: testDir,
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("禁止写入")
  })

  it("rejects base hash mismatch", () => {
    const p = writeTestFile("hash-mismatch.ts", "actual content\n")
    const ft = createTransaction({ tool: "edit_file", paths: [p], cwd: testDir })
    const result = preWriteCheck({
      tool: "edit_file",
      path: "hash-mismatch.ts",
      oldContent: "actual content\n",
      newContent: "new content\n",
      expectedBaseHash: "0000deadbeef0000", // wrong hash
      fileTransaction: ft,
      cwd: testDir,
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("Base hash")
  })

  it("allows new file with no expected hash", () => {
    const ft = createTransaction({ tool: "write_file", paths: [join(testDir, "brand-new.ts")], cwd: testDir })
    const result = preWriteCheck({
      tool: "write_file",
      path: "brand-new.ts",
      oldContent: null,
      newContent: "new",
      fileTransaction: ft,
      expectedBaseHash: null,
      cwd: testDir,
    })
    expect(result.allowed).toBe(true)
  })
})

// ── serializePatchTransaction ──

describe("serializePatchTransaction", () => {
  it("produces serializable object", () => {
    const ft = createTransaction({ tool: "write_file", paths: [join(testDir, "ser.ts")], cwd: testDir })
    const pt = createPatchTransaction({
      tool: "write_file",
      path: "ser.ts",
      oldContent: null,
      newContent: "export const a = 1\n",
      fileTransaction: ft,
      cwd: testDir,
    })
    const ser = serializePatchTransaction(pt)
    expect(ser.txId).toBe(pt.txId)
    expect(ser.baseHash).toBeNull()
    expect(typeof ser.diff).toBe("string")
    expect(ser.fileTransactionId).toBe(ft.id)
    expect(ser.createdAt).toBeTypeOf("number")
  })

  it("can be JSON.stringify-d", () => {
    const ft = createTransaction({ tool: "write_file", paths: [join(testDir, "json.ts")], cwd: testDir })
    const pt = createPatchTransaction({
      tool: "write_file",
      path: "json.ts",
      oldContent: null,
      newContent: "x",
      fileTransaction: ft,
      cwd: testDir,
    })
    const s = serializePatchTransaction(pt)
    const json = JSON.stringify(s)
    const parsed = JSON.parse(json)
    expect(parsed.txId).toBe(pt.txId)
  })
})

// ═══════════════════════════════════════════════════════════════
// PR-4.1: PatchTransaction State Machine tests
// ═══════════════════════════════════════════════════════════════

describe("ManagedPatchTransaction state machine", () => {
  let smTestDir: string

  beforeAll(() => {
    smTestDir = resolve(tmpdir(), `deepseek-ptxn-sm-${Date.now()}`)
    mkdirSync(smTestDir, { recursive: true })
  })

  afterAll(() => {
    try { rmSync(smTestDir, { recursive: true, force: true }) } catch {}
    clearTransactionRegistry()
    clearActivePatchContext()
  })

  beforeEach(() => {
    clearTransactionRegistry()
    clearActivePatchContext()
  })

  function makeFile(name: string, oldContent: string | null, newContent: string) {
    return { relativePath: name, oldContent, newContent }
  }

  // ── initManagedTransaction ──

  describe("initManagedTransaction", () => {
    it("creates transaction in proposed state", () => {
      const mpt = initManagedTransaction({
        tool: "write_file",
        files: [makeFile("src/new.ts", null, "export const x = 1\n")],
        cwd: smTestDir,
      })
      expect(mpt.state).toBe("proposed")
      expect(mpt.txId).toMatch(/^ptxn_/)
      expect(mpt.files).toHaveLength(1)
      expect(mpt.files[0]!.relativePath).toBe("src/new.ts")
      expect(mpt.stateTimestamps.proposed).toBeGreaterThan(0)
    })

    it("registers transaction in registry", () => {
      const mpt = initManagedTransaction({
        tool: "write_file",
        files: [makeFile("a.ts", "old", "new")],
        cwd: smTestDir,
      })
      const found = getManagedTransaction(mpt.txId)
      expect(found).toBeDefined()
      expect(found!.state).toBe("proposed")
    })

    it("throws on empty files", () => {
      expect(() =>
        initManagedTransaction({
          tool: "write_file",
          files: [],
          cwd: smTestDir,
        }),
      ).toThrow("至少需要一个文件")
    })

    it("supports multi-file transactions", () => {
      const mpt = initManagedTransaction({
        tool: "multi_edit",
        files: [
          makeFile("src/a.ts", "a", "a2"),
          makeFile("src/b.ts", "b", "b2"),
          makeFile("src/c.ts", null, "c"),
        ],
        cwd: smTestDir,
      })
      expect(mpt.files).toHaveLength(3)
      expect(mpt.patch.scope.length).toBeGreaterThan(0)
    })
  })

  // ── applyToTemp ──

  describe("applyToTemp", () => {
    it("transitions proposed → applied_to_temp", () => {
      const mpt = initManagedTransaction({
        tool: "write_file",
        files: [makeFile("temp-test.ts", null, "hello world\n")],
        cwd: smTestDir,
      })
      const result = applyToTemp(mpt)
      expect(result.state).toBe("applied_to_temp")
      expect(result.stateTimestamps.applied_to_temp).toBeGreaterThan(0)
    })

    it("writes files to temp directory", () => {
      const mpt = initManagedTransaction({
        tool: "write_file",
        files: [makeFile("lib/util.ts", null, "export const VERSION = 1\n")],
        cwd: smTestDir,
      })
      applyToTemp(mpt)
      expect(mpt.files[0]!.tempPath).toBeDefined()
      expect(existsSync(mpt.files[0]!.tempPath!)).toBe(true)
      const content = readFileSync(mpt.files[0]!.tempPath!, "utf-8")
      expect(content).toBe("export const VERSION = 1\n")
    })

    it("does not modify target file", () => {
      const targetPath = join(smTestDir, "real.ts")
      writeFileSync(targetPath, "original\n", "utf-8")
      const mpt = initManagedTransaction({
        tool: "edit_file",
        files: [makeFile("real.ts", "original\n", "modified\n")],
        cwd: smTestDir,
      })
      applyToTemp(mpt)
      // Target file should still have original content
      expect(readFileSync(targetPath, "utf-8")).toBe("original\n")
    })

    it("throws on invalid transition from verified", () => {
      const mpt = initManagedTransaction({
        tool: "write_file",
        files: [makeFile("x.ts", null, "x\n")],
        cwd: smTestDir,
      })
      applyToTemp(mpt)
      verifyManagedTransaction(mpt)
      expect(() => applyToTemp(mpt)).toThrow("非法状态转换")
    })

    it("throws on invalid transition from committed", () => {
      const mpt = initManagedTransaction({
        tool: "write_file",
        files: [makeFile("y.ts", null, "y\n")],
        cwd: smTestDir,
      })
      applyToTemp(mpt)
      verifyManagedTransaction(mpt)
      commitManagedTransaction(mpt)
      expect(() => applyToTemp(mpt)).toThrow("非法状态转换")
    })
  })

  // ── verifyManagedTransaction ──

  describe("verifyManagedTransaction", () => {
    it("transitions applied_to_temp → verified", () => {
      const mpt = initManagedTransaction({
        tool: "write_file",
        files: [makeFile("v.ts", null, "v\n")],
        cwd: smTestDir,
      })
      applyToTemp(mpt)
      const result = verifyManagedTransaction(mpt)
      expect(result.state).toBe("verified")
      expect(result.stateTimestamps.verified).toBeGreaterThan(0)
    })

    it("throws when verifying from proposed", () => {
      const mpt = initManagedTransaction({
        tool: "write_file",
        files: [makeFile("bad.ts", null, "bad\n")],
        cwd: smTestDir,
      })
      expect(() => verifyManagedTransaction(mpt)).toThrow("非法状态转换")
    })
  })

  // ── commitManagedTransaction ──

  describe("commitManagedTransaction", () => {
    it("transitions verified → committed", () => {
      const mpt = initManagedTransaction({
        tool: "write_file",
        files: [makeFile("commit-test.ts", null, "committed content\n")],
        cwd: smTestDir,
      })
      applyToTemp(mpt)
      verifyManagedTransaction(mpt)
      const result = commitManagedTransaction(mpt)
      expect(result.state).toBe("committed")
      expect(result.stateTimestamps.committed).toBeGreaterThan(0)
    })

    it("atomically moves temp file to target", () => {
      const mpt = initManagedTransaction({
        tool: "write_file",
        files: [makeFile("atomic.ts", null, "atomic write\n")],
        cwd: smTestDir,
      })
      applyToTemp(mpt)
      verifyManagedTransaction(mpt)
      commitManagedTransaction(mpt)

      const targetPath = join(smTestDir, "atomic.ts")
      expect(existsSync(targetPath)).toBe(true)
      expect(readFileSync(targetPath, "utf-8")).toBe("atomic write\n")
    })

    it("cleans up temp directory after commit", () => {
      const mpt = initManagedTransaction({
        tool: "write_file",
        files: [makeFile("cleanup.ts", null, "data\n")],
        cwd: smTestDir,
      })
      applyToTemp(mpt)
      const tempPath = mpt.files[0]!.tempPath!
      expect(existsSync(tempPath)).toBe(true)
      verifyManagedTransaction(mpt)
      commitManagedTransaction(mpt)
      // Temp file should be gone
      expect(existsSync(tempPath)).toBe(false)
    })

    it("overwrites existing target file", () => {
      const targetPath = join(smTestDir, "overwrite.ts")
      writeFileSync(targetPath, "old content\n", "utf-8")

      const mpt = initManagedTransaction({
        tool: "edit_file",
        files: [makeFile("overwrite.ts", "old content\n", "new content\n")],
        cwd: smTestDir,
      })
      applyToTemp(mpt)
      verifyManagedTransaction(mpt)
      commitManagedTransaction(mpt)

      expect(readFileSync(targetPath, "utf-8")).toBe("new content\n")
    })

    it("throws when committing from proposed", () => {
      const mpt = initManagedTransaction({
        tool: "write_file",
        files: [makeFile("skip.ts", null, "x\n")],
        cwd: smTestDir,
      })
      expect(() => commitManagedTransaction(mpt)).toThrow("非法状态转换")
    })

    it("supports multi-file commit", () => {
      const mpt = initManagedTransaction({
        tool: "multi_edit",
        files: [
          makeFile("multi/a.ts", null, "a content\n"),
          makeFile("multi/b.ts", null, "b content\n"),
        ],
        cwd: smTestDir,
      })
      applyToTemp(mpt)
      verifyManagedTransaction(mpt)
      commitManagedTransaction(mpt)

      expect(readFileSync(join(smTestDir, "multi/a.ts"), "utf-8")).toBe("a content\n")
      expect(readFileSync(join(smTestDir, "multi/b.ts"), "utf-8")).toBe("b content\n")
    })
  })

  // ── rollbackManagedTransaction ──

  describe("rollbackManagedTransaction", () => {
    it("transitions proposed → rolled_back", () => {
      const mpt = initManagedTransaction({
        tool: "write_file",
        files: [makeFile("rb-1.ts", null, "x\n")],
        cwd: smTestDir,
      })
      const result = rollbackManagedTransaction(mpt, "test cancel")
      expect(result.state).toBe("rolled_back")
      expect(result.rollbackReason).toBe("test cancel")
    })

    it("transitions applied_to_temp → rolled_back and cleans temp", () => {
      const mpt = initManagedTransaction({
        tool: "write_file",
        files: [makeFile("rb-2.ts", null, "temp content\n")],
        cwd: smTestDir,
      })
      applyToTemp(mpt)
      const tempPath = mpt.files[0]!.tempPath!
      expect(existsSync(tempPath)).toBe(true)

      rollbackManagedTransaction(mpt, "cleanup")
      expect(mpt.state).toBe("rolled_back")
      expect(existsSync(tempPath)).toBe(false)
    })

    it("transitions verified → rolled_back and cleans temp", () => {
      const mpt = initManagedTransaction({
        tool: "write_file",
        files: [makeFile("rb-3.ts", null, "verified then rolled\n")],
        cwd: smTestDir,
      })
      applyToTemp(mpt)
      verifyManagedTransaction(mpt)
      const tempPath = mpt.files[0]!.tempPath!
      rollbackManagedTransaction(mpt, "failed verification")
      expect(mpt.state).toBe("rolled_back")
      expect(existsSync(tempPath)).toBe(false)
    })

    it("is idempotent (rolled_back → rolled_back)", () => {
      const mpt = initManagedTransaction({
        tool: "write_file",
        files: [makeFile("rb-4.ts", null, "x\n")],
        cwd: smTestDir,
      })
      rollbackManagedTransaction(mpt, "first")
      expect(() => rollbackManagedTransaction(mpt, "second")).not.toThrow()
      expect(mpt.state).toBe("rolled_back")
    })

    it("does not revert committed files on disk", () => {
      const targetPath = join(smTestDir, "rb-committed.ts")
      const mpt = initManagedTransaction({
        tool: "write_file",
        files: [makeFile("rb-committed.ts", null, "committed data\n")],
        cwd: smTestDir,
      })
      applyToTemp(mpt)
      verifyManagedTransaction(mpt)
      commitManagedTransaction(mpt)
      expect(existsSync(targetPath)).toBe(true)

      // Rollback after commit — files stay (revert uses FileTransaction snapshot)
      rollbackManagedTransaction(mpt, "post-commit rollback")
      expect(mpt.state).toBe("rolled_back")
      expect(existsSync(targetPath)).toBe(true)
      expect(readFileSync(targetPath, "utf-8")).toBe("committed data\n")
    })
  })

  // ── applyAndCommit (full lifecycle) ──

  describe("applyAndCommit", () => {
    it("completes full lifecycle on successful verification", async () => {
      const mpt = await applyAndCommit(
        {
          tool: "write_file",
          files: [makeFile("full.ts", null, "full lifecycle\n")],
          cwd: smTestDir,
        },
        async (_mpt) => true, // verification passes
      )
      expect(mpt.state).toBe("committed")
      expect(existsSync(join(smTestDir, "full.ts"))).toBe(true)
    })

    it("rolls back on failed verification", async () => {
      const targetPath = join(smTestDir, "fail-verify.ts")
      const mpt = await applyAndCommit(
        {
          tool: "write_file",
          files: [makeFile("fail-verify.ts", null, "should not land\n")],
          cwd: smTestDir,
        },
        async (_mpt) => false, // verification fails
      )
      expect(mpt.state).toBe("rolled_back")
      expect(mpt.rollbackReason).toBe("verification failed")
      // Target file should NOT exist
      expect(existsSync(targetPath)).toBe(false)
    })

    it("re-throws on verification exception (no silent success)", async () => {
      const targetPath = join(smTestDir, "verify-crash.ts")
      let error: Error | null = null
      try {
        await applyAndCommit(
          {
            tool: "write_file",
            files: [makeFile("verify-crash.ts", null, "boom\n")],
            cwd: smTestDir,
          },
          async (_mpt) => { throw new Error("typecheck crashed") },
        )
      } catch (err) {
        error = err as Error
      }
      expect(error).not.toBeNull()
      expect(error!.message).toContain("typecheck crashed")
      // Target file should NOT exist (rolled back + re-thrown)
      expect(existsSync(targetPath)).toBe(false)
    })

    it("re-throws on forbidden file", async () => {
      let error: Error | null = null
      try {
        await applyAndCommit(
          {
            tool: "write_file",
            files: [makeFile(".git/config", null, "bad")],
            cwd: smTestDir,
          },
          async (_mpt) => true,
        )
      } catch (err) {
        error = err as Error
      }
      expect(error).not.toBeNull()
      expect(error!.message).toContain("禁止写入")
    })
  })

  // ── getAllManagedTransactions ──

  describe("getAllManagedTransactions", () => {
    it("returns all registered transactions", () => {
      initManagedTransaction({
        tool: "write_file",
        files: [makeFile("list-1.ts", null, "a\n")],
        cwd: smTestDir,
      })
      initManagedTransaction({
        tool: "edit_file",
        files: [makeFile("list-2.ts", "old", "new")],
        cwd: smTestDir,
      })
      const all = getAllManagedTransactions()
      expect(all.length).toBeGreaterThanOrEqual(2)
    })
  })

  // ── clearTransactionRegistry ──

  describe("clearTransactionRegistry", () => {
    it("clears all transactions", () => {
      initManagedTransaction({
        tool: "write_file",
        files: [makeFile("clear-me.ts", null, "x\n")],
        cwd: smTestDir,
      })
      expect(getAllManagedTransactions().length).toBeGreaterThan(0)
      clearTransactionRegistry()
      expect(getAllManagedTransactions()).toHaveLength(0)
    })
  })

  // ── Integration: scope & verification from active context ──

  describe("scope/verification from active context", () => {
    it("uses scope from active patch context", () => {
      setActivePatchContext({ scope: ["ctx/a.ts"], verification: ["test"], nodeId: "n1" })
      const mpt = initManagedTransaction({
        tool: "write_file",
        files: [makeFile("ctx-file.ts", null, "ctx\n")],
        cwd: smTestDir,
      })
      expect(mpt.patch.scope).toContain("ctx/a.ts")
      expect(mpt.patch.verification).toContain("test")
    })

    it("override scope takes precedence over active context", () => {
      setActivePatchContext({ scope: ["ctx/a.ts"], verification: ["test"], nodeId: "n2" })
      const mpt = initManagedTransaction({
        tool: "write_file",
        files: [makeFile("override.ts", null, "ov\n")],
        scope: ["explicit.ts"],
        verification: ["typecheck"],
        cwd: smTestDir,
      })
      expect(mpt.patch.scope).toEqual(["explicit.ts"])
      expect(mpt.patch.verification).toEqual(["typecheck"])
    })
  })
})
