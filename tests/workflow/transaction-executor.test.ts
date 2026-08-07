/** G3 acceptance: write lock enforcement + apply_patch transaction semantics.
 *
 *  apply_patch operates against process.cwd() (its writable root), so the
 *  fixture project lives under ./tmp-g3-* relative to the repo root.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { buildTool } from "../../src/tools/registry"
import { READ_FILE } from "../../src/tools/file"
import { APPLY_PATCH_TRANSACTION_TOOL } from "../../src/tools/apply-patch"
import { ConcurrencyController } from "../../src/workflow/scheduler/concurrency-controller"
import { runWriteNode, WRITE_HANDLERS } from "../../src/workflow/execution/transaction-executor"

const PROJECT = resolve("tmp-g3-fixture")
const CALC = join(PROJECT, "calc.ts")

beforeAll(() => {
  mkdirSync(PROJECT, { recursive: true })
  writeFileSync(CALC, "export function add(a: number, b: number) { return a + b }\n")
})

afterAll(() => {
  rmSync(PROJECT, { recursive: true, force: true })
})

function relDiff(from: string, to: string): string {
  // D7：diff 路径是 projectRoot 相对 —— 不再内嵌 cwd 前缀
  const rel = `calc.ts`
  return `--- a/${rel}\n+++ b/${rel}\n@@ -1 +1 @@\n-${from}\n+${to}\n`
}

describe("G3 write lock", () => {
  test("write whitelist is exactly the three sanctioned handlers", () => {
    expect([...WRITE_HANDLERS].sort()).toEqual([
      "tool.apply_patch",
      "tool.run_process",
      "tool.run_targeted_verification",
    ])
  })

  test("concurrency controller serializes writers (single slot)", async () => {
    const cc = new ConcurrencyController()
    const first = cc.tryAcquireWrite()
    expect(first).not.toBeNull()
    expect(cc.tryAcquireWrite()).toBeNull() // second writer rejected immediately
    expect(cc.writeBusy).toBe(true)

    const waiter = cc.acquireWrite().then(lock => {
      lock.release()
    })
    await new Promise(r => setTimeout(r, 10))
    first!.release()
    await waiter
    expect(cc.writeBusy).toBe(false)
  })
})

describe("G3 transaction executor", () => {
  test("apply_patch transaction applies and is verifiable on disk", async () => {
    writeFileSync(CALC, "export function add(a: number, b: number) { return a + b }\n")
    const cc = new ConcurrencyController()
    const lock = cc.tryAcquireWrite()!
    const diff = relDiff(
      "export function add(a: number, b: number) { return a + b }",
      "export function add(a: number, b: number) { return a + b + 0 }",
    )
    const result = await runWriteNode(
      "w:patch",
      buildTool(APPLY_PATCH_TRANSACTION_TOOL),
      { patches: [{ diff }] },
      lock,
      PROJECT,
    )
    expect(result.status).toBe("done")
    expect(readFileSync(CALC, "utf-8")).toContain("a + b + 0")
    expect(cc.writeBusy).toBe(false) // lock released in finally
  })

  test("conflicting patch fails and rolls back (file unchanged)", async () => {
    writeFileSync(CALC, "const v = 1\n")
    const original = readFileSync(CALC, "utf-8")
    const cc = new ConcurrencyController()
    const lock = cc.tryAcquireWrite()!
    const badDiff = "--- a/calc.ts\n+++ b/calc.ts\n@@ -1 +1 @@\n-totally different content\n+patched\n"

    const result = await runWriteNode(
      "w:patch",
      buildTool(APPLY_PATCH_TRANSACTION_TOOL),
      { patches: [{ diff: badDiff }] },
      lock,
      PROJECT,
    )
    expect(result.status).toBe("failed")
    expect(result.error).toContain("rolled back")
    expect(readFileSync(CALC, "utf-8")).toBe(original)
  })

  test("read-only tools cannot run as write nodes", async () => {
    const cc = new ConcurrencyController()
    const lock = cc.tryAcquireWrite()!
    const result = await runWriteNode("w:read", buildTool(READ_FILE), { path: CALC }, lock)
    expect(result.status).toBe("failed")
    expect(result.error).toContain("read-only tool")
  })
})
