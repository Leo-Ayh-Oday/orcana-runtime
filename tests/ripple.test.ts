import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { buildTool } from "../src/tools/registry"
import { EDIT_FILE, FILE_TOOLS, MULTI_EDIT, ROLLBACK_TRANSACTION, WRITE_FILE } from "../src/tools/file"
import { buildContextKernel } from "../src/context/kernel"
import { HybridMemory } from "../src/memory/hybrid"
import { formatCascadeSuggestion, previewEdit, tightenRippleDecision } from "../src/ripple/engine"
import { formatRippleExitGate } from "../src/ripple/obligations"

const oldCwd = process.cwd()
const tempRoots: string[] = []

afterEach(() => {
  process.chdir(oldCwd)
  for (const root of tempRoots.splice(0)) {
    if (!existsSync(root)) continue
    // Windows file locks — retry cleanup up to 3 times with backoff
    for (let attempt = 0; attempt < 3; attempt++) {
      try { rmSync(root, { recursive: true, force: true }); break }
      catch (e) {
        if (attempt < 2) { Bun.sleepSync(100); continue }
        // Last attempt failed — leak the temp dir, OS will clean it later
      }
    }
  }
})

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ripple-"))
  tempRoots.push(root)
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, "utf-8")
  }
  process.chdir(root)
  return root
}

describe("Ripple Engine", () => {
  test("allows internal implementation-only changes", () => {
    const root = project({
      "math.ts": `export function add(a: number, b: number): number {\n  return a + b\n}\n`,
    })
    const oldContent = readFileSync(join(root, "math.ts"), "utf-8")
    const newContent = oldContent.replace("return a + b", "return a + b + 0")

    const report = previewEdit({ targetFile: "math.ts", oldContent, newContent, projectRoot: root })

    expect(report.decision).toBe("allow")
    expect(report.findings).toHaveLength(0)
  })

  test("blocks exported function signature changes with callers", () => {
    const root = project({
      "math.ts": `export function add(a: number, b: number): number {\n  return a + b\n}\n`,
      "cart.ts": `import { add } from "./math"\nexport const total = add(1, 2)\n`,
    })
    const oldContent = readFileSync(join(root, "math.ts"), "utf-8")
    const newContent = oldContent.replace("add(a: number, b: number)", "add(values: number[])")

    const report = previewEdit({ targetFile: "math.ts", oldContent, newContent, projectRoot: root })

    expect(report.decision).toBe("block")
    expect(report.callers.some(c => c.file === "cart.ts")).toBe(true)
    expect(report.findings.some(f => f.kind === "signature-change")).toBe(true)
    expect(report.cascadePlan).toMatchObject({
      required: true,
      recommendedTool: "multi_edit",
      targetFile: "math.ts",
    })
    expect(report.cascadePlan?.affectedFiles).toEqual(["math.ts", "cart.ts"])
  })

  test("blocks sync return becoming Promise when callers exist", () => {
    const root = project({
      "api.ts": `export function loadUser(): number {\n  return 1\n}\n`,
      "page.ts": `import { loadUser } from "./api"\nexport const user = loadUser()\n`,
    })
    const oldContent = readFileSync(join(root, "api.ts"), "utf-8")
    const newContent = oldContent
      .replace("export function loadUser(): number", "export async function loadUser(): Promise<number>")
      .replace("return 1", "return 1")

    const report = previewEdit({ targetFile: "api.ts", oldContent, newContent, projectRoot: root })

    expect(report.decision).toBe("block")
    expect(report.findings.some(f => f.kind === "async-return-change")).toBe(true)
  })

  test("blocks Promise return changes even when target file starts with a BOM", () => {
    const root = project({
      "api.ts": `\uFEFFexport function loadUser(): number {\n  return 1\n}\n`,
      "page.ts": `import { loadUser } from "./api"\nexport const user = loadUser()\n`,
    })
    const oldContent = readFileSync(join(root, "api.ts"), "utf-8")
    const newContent = oldContent.replace("export function loadUser(): number", "export async function loadUser(): Promise<number>")

    const report = previewEdit({ targetFile: "api.ts", oldContent, newContent, projectRoot: root })

    expect(report.decision).toBe("block")
    expect(report.findings.some(f => f.kind === "async-return-change")).toBe(true)
  })

  test("blocks exported interface field removal", () => {
    const root = project({
      "types.ts": `export interface User {\n  id: string\n  name: string\n}\n`,
    })
    const oldContent = readFileSync(join(root, "types.ts"), "utf-8")
    const newContent = oldContent.replace("  name: string\n", "")

    const report = previewEdit({ targetFile: "types.ts", oldContent, newContent, projectRoot: root })

    expect(report.decision).toBe("block")
    expect(report.findings.some(f => f.kind === "exported-type-change")).toBe(true)
  })

  test("edit_file block does not mutate disk", async () => {
    const root = project({
      "math.ts": `export function add(a: number, b: number): number {\n  return a + b\n}\n`,
      "cart.ts": `import { add } from "./math"\nexport const total = add(1, 2)\n`,
    })
    const full = join(root, "math.ts")
    const before = readFileSync(full, "utf-8")
    const tool = buildTool(EDIT_FILE)

    const result = await tool.execute({
      path: full,
      old_string: "add(a: number, b: number)",
      new_string: "add(values: number[])",
      confirm: true,
    })

    expect(result.success).toBe(false)
    expect(result.content).toContain("Ripple blocked")
    expect(result.content).toContain("multi_edit")
    expect(result.content).toContain("cart.ts")
    expect(readFileSync(full, "utf-8")).toBe(before)
  })

  test("multi_edit applies target and caller cascade atomically", async () => {
    const root = project({
      "math.ts": `export function add(a: number, b: number): number {\n  return a + b\n}\n`,
      "cart.ts": `import { add } from "./math"\nexport const total = add(1, 2)\n`,
    })
    const tool = buildTool(MULTI_EDIT)

    const result = await tool.execute({
      confirm: true,
      edits: [
        {
          path: join(root, "math.ts"),
          old_string: "add(a: number, b: number): number",
          new_string: "add(values: number[]): number",
        },
        {
          path: join(root, "cart.ts"),
          old_string: "add(1, 2)",
          new_string: "add([1, 2])",
        },
      ],
    })

    expect(result.success).toBe(true)
    expect(readFileSync(join(root, "math.ts"), "utf-8")).toContain("add(values: number[])")
    expect(readFileSync(join(root, "cart.ts"), "utf-8")).toContain("add([1, 2])")
    expect(Array.isArray(result.metadata?.checkpoints)).toBe(true)
    expect((result.metadata?.checkpoints as Array<Record<string, unknown>>)[0]?.previousHash).toBeTruthy()
  })

  test("write tools expose checkpoint metadata without storing old content", async () => {
    const root = project({
      "note.txt": `before\n`,
    })
    const write = buildTool(WRITE_FILE)
    const edit = buildTool(EDIT_FILE)

    const writeResult = await write.execute({
      path: join(root, "created.txt"),
      content: "new\n",
      confirm: true,
    })
    const editResult = await edit.execute({
      path: join(root, "note.txt"),
      old_string: "before",
      new_string: "after",
      confirm: true,
    })

    expect(writeResult.success).toBe(true)
    expect(writeResult.metadata?.checkpoint).toMatchObject({ existedBefore: false, previousBytes: 0, previousHash: null })
    expect(editResult.success).toBe(true)
    expect(editResult.metadata?.checkpoint).toMatchObject({ existedBefore: true, previousBytes: 7 })
    expect(JSON.stringify(editResult.metadata?.checkpoint)).not.toContain("before")
    expect(typeof writeResult.metadata?.transactionId).toBe("string")
    expect(typeof editResult.metadata?.transactionId).toBe("string")
  })

  test("rollback_transaction restores edited files", async () => {
    const root = project({
      "note.txt": `before\n`,
    })
    const edit = buildTool(EDIT_FILE)
    const rollback = buildTool(ROLLBACK_TRANSACTION)

    const editResult = await edit.execute({
      path: join(root, "note.txt"),
      old_string: "before",
      new_string: "after",
      confirm: true,
    })
    expect(editResult.success).toBe(true)
    expect(readFileSync(join(root, "note.txt"), "utf-8")).toBe("after\n")

    const rollbackResult = await rollback.execute({
      transactionId: String(editResult.metadata?.transactionId),
      confirm: true,
    })

    expect(rollbackResult.success).toBe(true)
    expect(readFileSync(join(root, "note.txt"), "utf-8")).toBe("before\n")
    expect(rollbackResult.metadata?.restored).toEqual(["note.txt"])
  })

  test("rollback_transaction deletes files created by a transaction", async () => {
    const root = project({})
    const write = buildTool(WRITE_FILE)
    const rollback = buildTool(ROLLBACK_TRANSACTION)
    const path = join(root, "created.txt")

    const writeResult = await write.execute({
      path,
      content: "new\n",
      confirm: true,
    })
    expect(writeResult.success).toBe(true)
    expect(existsSync(path)).toBe(true)

    const rollbackResult = await rollback.execute({
      transactionId: String(writeResult.metadata?.transactionId),
      confirm: true,
    })

    expect(rollbackResult.success).toBe(true)
    expect(existsSync(path)).toBe(false)
    expect(rollbackResult.metadata?.deleted).toEqual(["created.txt"])
  })

  test("rollback_transaction restores multi_edit atomically", async () => {
    const root = project({
      "a.ts": `export const a = 1\n`,
      "b.ts": `export const b = 2\n`,
    })
    const multi = buildTool(MULTI_EDIT)
    const rollback = buildTool(ROLLBACK_TRANSACTION)

    const editResult = await multi.execute({
      confirm: true,
      edits: [
        { path: join(root, "a.ts"), old_string: "a = 1", new_string: "a = 10" },
        { path: join(root, "b.ts"), old_string: "b = 2", new_string: "b = 20" },
      ],
    })
    expect(editResult.success).toBe(true)
    expect(readFileSync(join(root, "a.ts"), "utf-8")).toContain("a = 10")
    expect(readFileSync(join(root, "b.ts"), "utf-8")).toContain("b = 20")

    const rollbackResult = await rollback.execute({
      transactionId: String(editResult.metadata?.transactionId),
      confirm: true,
    })

    expect(rollbackResult.success).toBe(true)
    expect(readFileSync(join(root, "a.ts"), "utf-8")).toContain("a = 1")
    expect(readFileSync(join(root, "b.ts"), "utf-8")).toContain("b = 2")
    expect(rollbackResult.metadata?.restored).toEqual(["a.ts", "b.ts"])
  })

  test("FILE_TOOLS exposes rollback_transaction", () => {
    expect(FILE_TOOLS.some(tool => tool.name === "rollback_transaction")).toBe(true)
  })

  test("multi_edit does not mutate disk when any edit is invalid", async () => {
    const root = project({
      "a.ts": `export const a = 1\n`,
      "b.ts": `export const b = 2\n`,
    })
    const beforeA = readFileSync(join(root, "a.ts"), "utf-8")
    const beforeB = readFileSync(join(root, "b.ts"), "utf-8")
    const tool = buildTool(MULTI_EDIT)

    const result = await tool.execute({
      confirm: true,
      edits: [
        { path: join(root, "a.ts"), old_string: "a = 1", new_string: "a = 10" },
        { path: join(root, "b.ts"), old_string: "missing", new_string: "b = 20" },
      ],
    })

    expect(result.success).toBe(false)
    expect(readFileSync(join(root, "a.ts"), "utf-8")).toBe(beforeA)
    expect(readFileSync(join(root, "b.ts"), "utf-8")).toBe(beforeB)
  })

  test("hybrid memory can warn inside ripple reports", () => {
    const root = project({
      "api.ts": `export function stableApi(): number {\n  return 1\n}\n`,
    })
    new HybridMemory(root).store("api stableApi", "Do not change this public API without a migration.", "test", 0.95)
    const oldContent = readFileSync(join(root, "api.ts"), "utf-8")
    const newContent = oldContent.replace("stableApi()", "stableApi(flag: boolean)")

    const report = previewEdit({ targetFile: "api.ts", oldContent, newContent, projectRoot: root })

    expect(report.memoryHits.length).toBeGreaterThan(0)
    expect(report.findings.some(f => f.kind === "memory-contract")).toBe(true)
  })

  test("context budget degraded mode escalates ripple warnings to block", () => {
    const decision = tightenRippleDecision({
      targetFile: "src/a.ts",
      changedSymbols: ["foo"],
      apiChanges: [],
      callers: [],
      findings: [{ file: "src/a.ts", severity: "warn", kind: "memory-contract", reason: "test warning" }],
      decision: "warn",
      memoryHits: [],
    }, "degraded")

    expect(decision).toBe("block")
  })

  test("formats cascade suggestions with affected files and next actions", () => {
    const text = formatCascadeSuggestion({
      targetFile: "math.ts",
      changedSymbols: ["add"],
      apiChanges: [],
      callers: [{ file: "cart.ts", line: 2, symbol: "add", text: "export const total = add(1, 2)" }],
      findings: [{
        file: "cart.ts",
        line: 2,
        severity: "block",
        kind: "signature-change",
        reason: "add signature changed.",
        suggestedFix: "Update caller arguments.",
      }],
      decision: "block",
      memoryHits: [],
    })

    expect(text).toContain("Affected files: math.ts, cart.ts")
    expect(text).toContain("Recommended tool: multi_edit")
    expect(text).toContain("Callers to inspect")
    expect(text).toContain("Next actions")
    expect(text).toContain("rollback_transaction")
  })

  test("ripple exit gate instructs cascade patch and rollback path", () => {
    const text = formatRippleExitGate([{
      targetFile: "math.ts",
      symbol: "add",
      caller: { file: "cart.ts", line: 2, symbol: "add", text: "export const total = add(1, 2)" },
      reason: "cart.ts still references changed symbol add.",
    }])

    expect(text).toContain("multi_edit cascade")
    expect(text).toContain("rollback_transaction")
  })

  test("context kernel is stable for the same project snapshot", () => {
    const root = project({
      "package.json": `{"name":"kernel-test"}`,
      "src/index.ts": `export const answer = 42\n`,
    })

    const a = buildContextKernel(root)
    const b = buildContextKernel(root)

    expect(a.hash).toBe(b.hash)
    expect(a.sections).toContain("package.json")
    expect(a.sections).toContain("source-skeleton")
  })
})
