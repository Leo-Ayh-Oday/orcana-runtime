import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { getRuntimeFileStateLedger, resetRuntimeFileStateLedger } from "../src/file-state"
import { resetRippleProgram } from "../src/ripple/engine"
import { buildTool } from "../src/tools/registry"
import { EDIT_FILE, MULTI_EDIT, READ_FILE, WRITE_FILE } from "../src/tools/file"

const oldCwd = process.cwd()
const tempRoots: string[] = []

afterEach(() => {
  process.chdir(oldCwd)
  resetRuntimeFileStateLedger()
  resetRippleProgram()
  for (const root of tempRoots.splice(0)) {
    if (!existsSync(root)) continue
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        rmSync(root, { recursive: true, force: true })
        break
      } catch {
        if (attempt < 2) {
          Bun.sleepSync(100)
          continue
        }
      }
    }
  }
})

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "orcana-file-tools-state-"))
  tempRoots.push(root)
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, "utf-8")
  }
  process.chdir(root)
  return root
}

describe("file tools runtime FileState observation", () => {
  test("read_file records a fresh full-file baseline", async () => {
    const root = project({ "src/a.ts": "export const value = 1\n" })
    const tool = buildTool(READ_FILE)

    const result = await tool.execute({ path: "src/a.ts" })
    const record = getRuntimeFileStateLedger().get(resolve(root, "src/a.ts"))

    expect(result.success).toBe(true)
    expect(record?.status).toBe("fresh")
    expect(record?.source).toBe("read_file")
    expect(record?.readRange).toEqual({ kind: "full" })
    expect(result.metadata?.fileState).toMatchObject({ status: "fresh", source: "read_file" })
  })

  test("read_file records ranged reads as partial baselines", async () => {
    const root = project({ "src/a.ts": "one\ntwo\nthree\n" })
    const tool = buildTool(READ_FILE)

    const result = await tool.execute({ path: "src/a.ts", offset: 1, limit: 1 })
    const record = getRuntimeFileStateLedger().get(resolve(root, "src/a.ts"))

    expect(result.success).toBe(true)
    expect(record?.status).toBe("partial")
    expect(record?.readRange).toEqual({ kind: "range", startLine: 2, endLine: 2 })
    expect(result.metadata?.fileState).toMatchObject({ status: "partial" })
  })

  test("read_file records large structural reads as truncated baselines", async () => {
    const root = project({ "src/large.ts": Array.from({ length: 410 }, (_, i) => `export const v${i} = ${i}`).join("\n") })
    const tool = buildTool(READ_FILE)

    const result = await tool.execute({ path: "src/large.ts" })
    const record = getRuntimeFileStateLedger().get(resolve(root, "src/large.ts"))

    expect(result.success).toBe(true)
    expect(result.metadata?.analyzed).toBe(true)
    expect(record?.status).toBe("truncated")
    expect(record?.readRange).toEqual({ kind: "full" })
    expect(result.metadata?.fileState).toMatchObject({ status: "truncated" })
  })

  test("write_file records an agent_write baseline after commit", async () => {
    const root = project({})
    const tool = buildTool(WRITE_FILE)

    const result = await tool.execute({ path: "src/a.ts", content: "export const value = 2\n", confirm: true })
    const fullPath = resolve(root, "src/a.ts")
    const record = getRuntimeFileStateLedger().get(fullPath)

    expect(result.success).toBe(true)
    expect(readFileSync(fullPath, "utf-8")).toBe("export const value = 2\n")
    expect(record?.status).toBe("fresh")
    expect(record?.source).toBe("agent_write")
    expect(result.metadata?.fileState).toMatchObject({ status: "fresh", source: "agent_write" })
  })

  test("edit_file records an agent_write baseline for the edited file", async () => {
    const root = project({ "src/a.ts": "export const value = 1\n" })
    const tool = buildTool(EDIT_FILE)

    const result = await tool.execute({
      path: "src/a.ts",
      old_string: "value = 1",
      new_string: "value = 2",
      confirm: true,
    })
    const record = getRuntimeFileStateLedger().get(resolve(root, "src/a.ts"))

    expect(result.success).toBe(true)
    expect(record?.status).toBe("fresh")
    expect(record?.source).toBe("agent_write")
    expect(record?.baselinePreview).toContain("value = 2")
  })

  test("multi_edit records agent_write baselines for each committed file", async () => {
    const root = project({
      "src/a.ts": "export const a = 1\n",
      "src/b.ts": "export const b = 1\n",
    })
    const tool = buildTool(MULTI_EDIT)

    const result = await tool.execute({
      confirm: true,
      edits: [
        { path: "src/a.ts", old_string: "a = 1", new_string: "a = 2" },
        { path: "src/b.ts", old_string: "b = 1", new_string: "b = 2" },
      ],
    })
    const ledger = getRuntimeFileStateLedger()

    expect(result.success).toBe(true)
    expect(ledger.get(resolve(root, "src/a.ts"))?.baselinePreview).toContain("a = 2")
    expect(ledger.get(resolve(root, "src/b.ts"))?.baselinePreview).toContain("b = 2")
    expect(result.metadata?.fileStates).toEqual([
      expect.objectContaining({ status: "fresh", source: "agent_write" }),
      expect.objectContaining({ status: "fresh", source: "agent_write" }),
    ])
  })
})
