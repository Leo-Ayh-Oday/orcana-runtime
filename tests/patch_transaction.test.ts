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

  it("allows dotfiles like .env", () => {
    const result = checkForbiddenFile(".env", testDir)
    expect(result.allowed).toBe(true)
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
