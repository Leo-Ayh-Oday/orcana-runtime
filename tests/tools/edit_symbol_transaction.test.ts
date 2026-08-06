/** RC-16 G8: edit_symbol must commit through PatchTransaction + freshness —
 *  a symbol replacement is either fully transactional (rollback-able) or blocked. */

import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { EDIT_SYMBOL_TOOL, ROLLBACK_TRANSACTION } from "../../src/tools/file"
import { computeBaseHash, clearTransactionRegistry } from "../../src/agent/patch-transaction"
import { resetRippleProgram } from "../../src/ripple/engine"
import type { ToolExecutionContext } from "../../src/tools/registry"

let tempDir: string
const oldCwd = process.cwd()

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "rc16-editsymbol-"))
})

afterEach(() => {
  process.chdir(oldCwd)
  resetRippleProgram()
  clearTransactionRegistry()
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function writeSource(name: string, content: string): string {
  const p = join(tempDir, name)
  writeFileSync(p, content, "utf-8")
  process.chdir(tempDir)
  return p
}

const ORIGINAL = [
  "export function foo(): number {",
  "  return 1",
  "}",
].join("\n")

describe("edit_symbol transaction (RC-16 G8)", () => {
  test("symbol edit is transactional — rollback restores the original file", async () => {
    const p = writeSource("a.ts", ORIGINAL)

    const result = await EDIT_SYMBOL_TOOL.execute({
      path: p,
      symbol: "foo",
      newText: "export function foo(): number {\n  return 2\n}",
    })
    expect(result.success).toBe(true)
    expect(readFileSync(p, "utf-8")).toContain("return 2")

    const transactionId = (result as { metadata?: { transactionId?: string } }).metadata?.transactionId
    expect(typeof transactionId).toBe("string")

    const rollback = await ROLLBACK_TRANSACTION.execute({ transactionId })
    expect(rollback.success).toBe(true)
    expect(readFileSync(p, "utf-8")).toContain("return 1")
  })

  test("symbol edit is freshness-gated — a stale base blocks the write", async () => {
    const p = writeSource("b.ts", ORIGINAL)
    const originalContent = readFileSync(p, "utf-8")
    const staleHash = computeBaseHash(originalContent)

    writeFileSync(p, "export function foo(): number {\n  return 99\n}\n", "utf-8")

    const context: ToolExecutionContext = {
      freshness: {
        expectedBaseHashes: { [resolve(p)]: staleHash },
        approvedContents: { [resolve(p)]: originalContent },
      },
    }
    const result = await EDIT_SYMBOL_TOOL.execute(
      { path: p, symbol: "foo", newText: "export function foo(): number {\n  return 3\n}" },
      undefined,
      context,
    )
    expect(result.success).toBe(false)
    expect((result as { metadata?: { gate?: string } }).metadata?.gate).toBe("freshness")
    expect(readFileSync(p, "utf-8")).toContain("return 99")
  })
})
