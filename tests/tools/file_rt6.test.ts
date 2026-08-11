import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { READ_FILE, EDIT_SYMBOL_TOOL } from "../../src/tools/file"
import { fingerprintContent } from "../../src/file-state/file-fingerprint"


// RT-6: read_file selector/expectedHash + edit_symbol AST editing.

const TS_FILE = [
  "export function greet(name: string): string {",
  "  return `hello ${name}`",
  "}",
  "",
  "export interface User {",
  "  id: number",
  "}",
].join("\n")

describe("RT-6 read_file enhancements", () => {
  test("symbol selector returns the AST span of a function", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rt6-read-"))
    try {
      const p = join(cwd, "lib.ts")
      writeFileSync(p, TS_FILE)
      const result = await READ_FILE.execute!({ path: p, selector: { kind: "symbol", name: "greet" } }, undefined, { projectRoot: cwd })
      expect(result.success).toBe(true)
      const content = result.content
      expect(content).toContain("export function greet")
      expect(content).not.toContain("interface User")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("expectedHash mismatch returns STALE_FILE", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rt6-stale-"))
    try {
      const p = join(cwd, "a.txt")
      writeFileSync(p, "content v1")
      const hash = fingerprintContent("content v1").sha256
      const ok = await READ_FILE.execute!({ path: p, expectedHash: hash }, undefined, { projectRoot: cwd })
      expect(ok.success).toBe(true)
      const stale = await READ_FILE.execute!({ path: p, expectedHash: "wrong-hash" }, undefined, { projectRoot: cwd })
      expect(stale.success).toBe(false)
      expect(stale.content).toContain("STALE_FILE")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("lines selector returns the requested window", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rt6-lines-"))
    try {
      const p = join(cwd, "a.txt")
      writeFileSync(p, "l0\nl1\nl2\nl3\n")
      const result = await READ_FILE.execute!({ path: p, selector: { kind: "lines", start: 1, end: 3 } }, undefined, { projectRoot: cwd })
      expect(result.success).toBe(true)
      expect(result.content).toBe("l1\nl2")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe("RT-6 edit_symbol", () => {
  test("dryRun previews the symbol text and span", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rt6-sym-"))
    try {
      const p = join(cwd, "lib.ts")
      writeFileSync(p, TS_FILE)
      const result = await EDIT_SYMBOL_TOOL.execute!({ path: p, symbol: "User", dryRun: true }, undefined, { projectRoot: cwd })
      expect(result.success).toBe(true)
      expect(result.content).toContain("export interface User")
      const meta = result.metadata as { authority: string; startLine: number; endLine: number; dryRun: boolean }
      expect(meta.authority).toBe("compiler")
      expect(meta.startLine).toBe(4)
      expect(meta.dryRun).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("edits the symbol in place via the AST span", async () => {
    // Must live inside the project root — managed patch transactions refuse out-of-root paths.
    // Ripple preview scans the whole project for callers (cold ~7s), so allow 15s.
    const cwd = mkdtempSync(join(process.cwd(), ".rt6-sym2-"))
    try {
      const p = join(cwd, "lib.ts")
      writeFileSync(p, TS_FILE)
      const result = await EDIT_SYMBOL_TOOL.execute!({
        path: p,
        symbol: "greet",
        newText: "export function greet(name: string): string {\n  return `hi ${name}`\n}",
      }, undefined, { projectRoot: cwd })
      expect(result.success).toBe(true)
      const updated = readFileSync(p, "utf-8")
      expect(updated).toContain("return `hi ${name}`")
      expect(updated).not.toContain("return `hello ${name}`")
      expect(updated).toContain("export interface User")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 15000)

  test("missing symbol fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rt6-sym3-"))
    try {
      const p = join(cwd, "lib.ts")
      writeFileSync(p, TS_FILE)
      const result = await EDIT_SYMBOL_TOOL.execute!({ path: p, symbol: "nope", dryRun: true }, undefined, { projectRoot: cwd })
      expect(result.success).toBe(false)
      expect(result.content).toContain("Symbol not found")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

// ── IC01-R5: 生产路径跨 chunk 行窗口（WORKSPACE_FILE_READER chunkSize=64KiB）──

describe("IC01-R5 read_file 生产路径 —— 前一行跨 chunk 时 TARGET 精确返回", () => {
  const prevLens = [64 * 1024 - 1, 64 * 1024, 64 * 1024 + 7, 3 * 64 * 1024 + 13]

  for (const prevLen of prevLens) {
    test(`前一行 ${prevLen}B（跨 chunk 边界）→ lines selector 精确返回 TARGET，不含上一行`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "rt6-r5-prod-"))
      try {
        const p = join(cwd, "big.txt")
        const prev = "X".repeat(prevLen)
        const target = "TARGET-ABCDEFGHIJ-LINE"
        writeFileSync(p, "first line\n" + prev + "\n" + target + "\n" + "tail line\n", "utf-8")
        // 0-based 行：0=first line，1=P 行，2=TARGET，3=tail。
        const result = await READ_FILE.execute!({ path: p, selector: { kind: "lines", start: 2, end: 3 } }, undefined, { projectRoot: cwd })
        expect(result.success).toBe(true)
        expect(result.content).toBe(target)
        expect(result.content).not.toContain("X")
        // 多行窗口：3-4 → TARGET + tail。
        const two = await READ_FILE.execute!({ path: p, selector: { kind: "lines", start: 2, end: 4 } }, undefined, { projectRoot: cwd })
        expect(two.success).toBe(true)
        expect(two.content).toBe(target + "\ntail line")
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    })
  }

  test("前一行跨 chunk + 目标行无尾随换行（EOF）→ 精确返回", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rt6-r5-eof-"))
    try {
      const p = join(cwd, "big.txt")
      const prev = "X".repeat(64 * 1024 + 3)
      const target = "LAST-TARGET-NO-NEWLINE"
      writeFileSync(p, "prelude\n" + prev + "\n" + target, "utf-8")
      // 0-based 行：0=prelude，1=P 行，2=TARGET（EOF）。
      const result = await READ_FILE.execute!({ path: p, selector: { kind: "lines", start: 2, end: 3 } }, undefined, { projectRoot: cwd })
      expect(result.success).toBe(true)
      expect(result.content).toBe(target)
      expect(result.content).not.toContain("X")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
