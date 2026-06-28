/** Tests for FIM Safety Guard — PR-6.5. */
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  checkFimSafety,
  verifyFimPreEditHash,
  quickFimCheck,
  formatFimGuardResult,
  type FimSafetyContext,
} from "../src/sandbox/fim-guard"

// ── Temp directory ──

let tempDir: string

beforeAll(() => {
  tempDir = join(tmpdir(), `fim-guard-test-${Date.now()}`)
  mkdirSync(tempDir, { recursive: true })
})

afterAll(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

function writeTempFile(name: string, content: string): string {
  const p = join(tempDir, name)
  const dir = join(p, "..")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(p, content)
  return p
}

// ── Forbidden file checks ──

describe("checkFimSafety — forbidden files", () => {
  test("blocks .env files", async () => {
    const result = await checkFimSafety("/project/.env", {})
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("禁止编辑受保护文件")
  })

  test("blocks .env.local files", async () => {
    const result = await checkFimSafety("/project/.env.local", {})
    expect(result.allowed).toBe(false)
  })

  test("blocks .pem files", async () => {
    const result = await checkFimSafety("/project/server.pem", {})
    expect(result.allowed).toBe(false)
  })

  test("blocks SSH private keys", async () => {
    expect((await checkFimSafety("/project/id_rsa", {})).allowed).toBe(false)
    expect((await checkFimSafety("/project/id_ecdsa", {})).allowed).toBe(false)
    expect((await checkFimSafety("/project/id_ed25519", {})).allowed).toBe(false)
  })

  test("blocks credentials.json", async () => {
    const result = await checkFimSafety("/project/credentials.json", {})
    expect(result.allowed).toBe(false)
  })

  test("blocks node_modules path", async () => {
    const result = await checkFimSafety("/project/node_modules/pkg/index.js", {})
    expect(result.allowed).toBe(false)
  })

  test("blocks .git path", async () => {
    const result = await checkFimSafety("/project/.git/config", {})
    expect(result.allowed).toBe(false)
  })

  test("blocks .deepseek-code path", async () => {
    const result = await checkFimSafety("/project/.deepseek-code/state.json", {})
    expect(result.allowed).toBe(false)
  })

  test("allows normal source files", async () => {
    const fp = writeTempFile("src/index.ts", "const x = 1")
    const result = await checkFimSafety(fp, {})
    expect(result.allowed).toBe(true)
    expect(result.txId).toBeDefined()
    expect(result.txId).toMatch(/^txn_fim_/)
  })
})

// ── Scope validation ──

describe("checkFimSafety — scope validation", () => {
  test("allows file in scope", async () => {
    const fp = writeTempFile("src/components/Button.tsx", "export const Button = () => null")
    const result = await checkFimSafety(fp, {
      scope: ["src/components/Button.tsx", "src/utils/"],
    })
    expect(result.allowed).toBe(true)
  })

  test("blocks file outside scope", async () => {
    const fp = writeTempFile("src/secret/hack.ts", "// malicious")
    const result = await checkFimSafety(fp, {
      scope: ["src/components/", "src/utils/"],
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("不在当前节点 scope")
  })

  test("empty scope allows all files", async () => {
    const fp = writeTempFile("anywhere/file.ts", "// ok")
    const result = await checkFimSafety(fp, { scope: [] })
    expect(result.allowed).toBe(true)
  })

  test("no scope context allows all files", async () => {
    const fp = writeTempFile("anywhere/file.ts", "// ok")
    const result = await checkFimSafety(fp, {})
    expect(result.allowed).toBe(true)
  })

  // ── Scope bypass regression tests (HIGH-1 fix) ──

  test("blocks overscope by substring: src/a does NOT match src/a_secret/file.ts", async () => {
    const fp = writeTempFile("src/a_secret/file.ts", "// sensitive")
    const result = await checkFimSafety(fp, { scope: ["src/a/"] })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("不在当前节点 scope")
  })

  test("blocks overscope by suffix: Button.tsx does NOT match Button.tsx.backup", async () => {
    const fp = writeTempFile("src/components/Button.tsx.backup", "// backup")
    const result = await checkFimSafety(fp, { scope: ["src/components/Button.tsx"] })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("不在当前节点 scope")
  })

  test("allows exact file match", async () => {
    const fp = writeTempFile("src/components/Button.tsx", "export const Button")
    const result = await checkFimSafety(fp, { scope: ["src/components/Button.tsx"] })
    expect(result.allowed).toBe(true)
  })

  test("allows files in subdirectory of scope", async () => {
    const fp = writeTempFile("src/components/deep/Button.tsx", "export const Button")
    const result = await checkFimSafety(fp, { scope: ["src/components/"] })
    expect(result.allowed).toBe(true)
  })
})

// ── File existence ──

describe("checkFimSafety — file existence", () => {
  test("blocks non-existent file", async () => {
    const result = await checkFimSafety("/nonexistent/file.ts", {})
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("文件不存在")
  })
})

// ── Pre-edit hash and verification ──

describe("checkFimSafety — hash and verification", () => {
  test("computes pre-edit hash for existing file", async () => {
    const fp = writeTempFile("hash-test.ts", "const a = 1")
    const result = await checkFimSafety(fp, {})
    expect(result.preEditHash).toBeDefined()
    expect(result.preEditHash!.length).toBe(16) // 16-char hex
  })

  test("returns required verification when context says so", async () => {
    const fp = writeTempFile("verify-test.ts", "const b = 2")
    const result = await checkFimSafety(fp, {
      requiresVerification: true,
      verificationKinds: ["typecheck", "test"],
    })
    expect(result.allowed).toBe(true)
    expect(result.requiredVerification).toEqual(["typecheck", "test"])
  })

  test("no verification when context doesn't require it", async () => {
    const fp = writeTempFile("no-verify.ts", "const c = 3")
    const result = await checkFimSafety(fp, { requiresVerification: false })
    expect(result.requiredVerification).toBeUndefined()
  })
})

// ── verifyFimPreEditHash ──

describe("verifyFimPreEditHash", () => {
  test("valid when file unchanged", async () => {
    const fp = writeTempFile("unchanged.ts", "const x = 1")
    const hash = (await checkFimSafety(fp, {})).preEditHash!
    const result = await verifyFimPreEditHash(fp, hash)
    expect(result.valid).toBe(true)
  })

  test("invalid when file changed", async () => {
    const fp = writeTempFile("changed.ts", "const x = 1")
    const hash = (await checkFimSafety(fp, {})).preEditHash!
    // Modify file
    writeFileSync(fp, "const x = 2")
    const result = await verifyFimPreEditHash(fp, hash)
    expect(result.valid).toBe(false)
  })

  test("invalid when file deleted", async () => {
    const result = await verifyFimPreEditHash("/nonexistent/file.ts", "abc123")
    expect(result.valid).toBe(false)
  })
})

// ── quickFimCheck ──

describe("quickFimCheck", () => {
  test("blocks forbidden files without hash", () => {
    expect(quickFimCheck("/project/.env", {}).allowed).toBe(false)
  })

  test("blocks out-of-scope files", () => {
    expect(quickFimCheck("/project/other/file.ts", { scope: ["src/"] }).allowed).toBe(false)
  })

  test("allows normal files", () => {
    expect(quickFimCheck("/project/src/file.ts", { scope: ["src/"] }).allowed).toBe(true)
  })
})

// ── formatFimGuardResult ──

describe("formatFimGuardResult", () => {
  test("formats allowed result with tx id", () => {
    const s = formatFimGuardResult({
      allowed: true,
      txId: "txn_fim_abc123",
      preEditHash: "deadbeef12345678",
    })
    expect(s).toContain("✅")
    expect(s).toContain("txn_fim_abc123")
  })

  test("formats allowed result with verification requirements", () => {
    const s = formatFimGuardResult({
      allowed: true,
      txId: "txn_fim_abc123",
      preEditHash: "deadbeef12345678",
      requiredVerification: ["typecheck", "test"],
    })
    expect(s).toContain("typecheck")
    expect(s).toContain("test")
  })

  test("formats blocked result", () => {
    const s = formatFimGuardResult({
      allowed: false,
      reason: "禁止编辑受保护文件",
    })
    expect(s).toContain("❌")
    expect(s).toContain("禁止编辑受保护文件")
  })
})
