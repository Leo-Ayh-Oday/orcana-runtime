import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { getRuntimeFileStateLedger, resetRuntimeFileStateLedger } from "../src/file-state"
import { resetRippleProgram } from "../src/ripple/engine"
import { clearTransactionRegistry, currentTransactionEvidenceBinding } from "../src/agent/patch-transaction"
import { buildTool } from "../src/tools/registry"
import { EDIT_FILE, EDIT_FIM, MULTI_EDIT, READ_FILE, WRITE_FILE } from "../src/tools/file"

const oldCwd = process.cwd()
const tempRoots: string[] = []

afterEach(() => {
  process.chdir(oldCwd)
  resetRuntimeFileStateLedger()
  resetRippleProgram()
  clearTransactionRegistry()
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

    const result = await tool.execute({ path: "src/a.ts" }, { projectRoot: root })
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

    const result = await tool.execute({ path: "src/a.ts", offset: 1, limit: 1 }, { projectRoot: root })
    const record = getRuntimeFileStateLedger().get(resolve(root, "src/a.ts"))

    expect(result.success).toBe(true)
    expect(record?.status).toBe("partial")
    expect(record?.readRange).toEqual({ kind: "range", startLine: 2, endLine: 2 })
    expect(result.metadata?.fileState).toMatchObject({ status: "partial" })
  })

  test("read_file records large structural reads as truncated baselines", async () => {
    const root = project({ "src/large.ts": Array.from({ length: 410 }, (_, i) => `export const v${i} = ${i}`).join("\n") })
    const tool = buildTool(READ_FILE)

    const result = await tool.execute({ path: "src/large.ts" }, { projectRoot: root })
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

    const result = await tool.execute({ path: "src/a.ts", content: "export const value = 2\n", confirm: true }, { projectRoot: root })
    const fullPath = resolve(root, "src/a.ts")
    const record = getRuntimeFileStateLedger().get(fullPath)

    expect(result.success).toBe(true)
    expect(readFileSync(fullPath, "utf-8")).toBe("export const value = 2\n")
    expect(record?.status).toBe("fresh")
    expect(record?.source).toBe("agent_write")
    expect(result.metadata?.fileState).toMatchObject({ status: "fresh", source: "agent_write" })
    expect(result.metadata?.transactionId).toMatch(/^txn_/)
    expect(result.metadata?.patchTransactionId).toMatch(/^ptxn_/)
    expect(currentTransactionEvidenceBinding()).toMatchObject({
      transactionCount: 1,
      latestTransactionId: result.metadata?.patchTransactionId,
    })
    expect(currentTransactionEvidenceBinding()?.stateId).toMatch(/^txstate_[0-9a-f]{32}$/)
  })

  test("write_file blocks overwriting an existing file without a full baseline", async () => {
    const root = project({ "src/a.ts": "export const value = 1\n" })
    const tool = buildTool(WRITE_FILE)
    const fullPath = resolve(root, "src/a.ts")

    const result = await tool.execute({
      path: "src/a.ts",
      content: "export const value = 2\n",
      confirm: true,
    }, { projectRoot: root })

    expect(result.success).toBe(false)
    expect(result.metadata).toMatchObject({
      blocked: true,
      gate: "freshness",
      freshness: { path: "src/a.ts", status: "missing" },
    })
    expect(readFileSync(fullPath, "utf-8")).toBe("export const value = 1\n")
  })

  test("write_file can overwrite an existing file after a fresh full read", async () => {
    const root = project({ "src/a.ts": "export const value = 1\n" })
    const read = buildTool(READ_FILE)
    const write = buildTool(WRITE_FILE)
    const fullPath = resolve(root, "src/a.ts")

    expect((await read.execute({ path: "src/a.ts" }, { projectRoot: root })).success).toBe(true)
    const result = await write.execute({
      path: "src/a.ts",
      content: "export const value = 2\n",
      confirm: true,
    }, { projectRoot: root })

    expect(result.success).toBe(true)
    expect(readFileSync(fullPath, "utf-8")).toBe("export const value = 2\n")
  })

  test("write_file does not reinterpret an externally deleted baseline as a new file", async () => {
    const root = project({ "src/a.ts": "export const value = 1\n" })
    const read = buildTool(READ_FILE)
    const write = buildTool(WRITE_FILE)
    const fullPath = resolve(root, "src/a.ts")

    expect((await read.execute({ path: "src/a.ts" }, { projectRoot: root })).success).toBe(true)
    rmSync(fullPath)
    const result = await write.execute({
      path: "src/a.ts",
      content: "export const value = 2\n",
      confirm: true,
    }, { projectRoot: root })

    expect(result.success).toBe(false)
    expect(result.metadata).toMatchObject({
      blocked: true,
      gate: "freshness",
      freshness: { path: "src/a.ts", status: "deleted" },
    })
    expect(existsSync(fullPath)).toBe(false)
  })

  test("edit_file records an agent_write baseline for the edited file", async () => {
    const root = project({ "src/a.ts": "export const value = 1\n" })
    const read = buildTool(READ_FILE)
    const tool = buildTool(EDIT_FILE)

    expect((await read.execute({ path: "src/a.ts" }, { projectRoot: root })).success).toBe(true)
    const result = await tool.execute({
      path: "src/a.ts",
      old_string: "value = 1",
      new_string: "value = 2",
      confirm: true,
    }, { projectRoot: root })
    const record = getRuntimeFileStateLedger().get(resolve(root, "src/a.ts"))

    expect(result.success).toBe(true)
    expect(record?.status).toBe("fresh")
    expect(record?.source).toBe("agent_write")
    expect(record?.baselinePreview).toContain("value = 2")
  })

  test("edit_file blocks an existing file without a baseline", async () => {
    const root = project({ "src/a.ts": "export const value = 1\n" })
    const tool = buildTool(EDIT_FILE)
    const fullPath = resolve(root, "src/a.ts")

    const result = await tool.execute({
      path: "src/a.ts",
      old_string: "value = 1",
      new_string: "value = 2",
      confirm: true,
    }, { projectRoot: root })

    expect(result.success).toBe(false)
    expect(result.metadata).toMatchObject({
      blocked: true,
      gate: "freshness",
      freshness: { path: "src/a.ts", status: "missing" },
    })
    expect(readFileSync(fullPath, "utf-8")).toBe("export const value = 1\n")
  })

  test("freshness blocks do not expose an absolute workspace path", async () => {
    const root = project({ "src/a.ts": "export const value = 1\n" })
    const edit = buildTool(EDIT_FILE)
    const fullPath = resolve(root, "src/a.ts")

    const result = await edit.execute({
      path: fullPath,
      old_string: "value = 1",
      new_string: "value = 2",
      confirm: true,
    }, { projectRoot: root })

    expect(result.success).toBe(false)
    expect(result.content).not.toContain(root)
    expect(result.metadata).toMatchObject({
      gate: "freshness",
      freshness: { path: "src/a.ts", status: "missing" },
    })
  })

  test("freshness requirements reject non-string paths instead of coercing them", async () => {
    const root = project({ "123": "external content\n" })
    const edit = buildTool(EDIT_FILE)

    const result = await edit.execute({
      path: 123,
      old_string: "external",
      new_string: "agent",
      confirm: true,
    }, { projectRoot: root })

    expect(result.success).toBe(false)
    expect(result.metadata).toMatchObject({
      blocked: true,
      gate: "freshness",
      freshness: { path: "path", status: "missing" },
    })
    expect(readFileSync(resolve(root, "123"), "utf-8")).toBe("external content\n")
  })

  test("write_file blocks whole-file overwrite from a partial baseline", async () => {
    const root = project({ "src/a.ts": "one\ntwo\nthree\n" })
    const read = buildTool(READ_FILE)
    const write = buildTool(WRITE_FILE)
    const fullPath = resolve(root, "src/a.ts")

    expect((await read.execute({ path: "src/a.ts", offset: 0, limit: 1 }, { projectRoot: root })).success).toBe(true)
    const result = await write.execute({
      path: "src/a.ts",
      content: "changed\n",
      confirm: true,
    }, { projectRoot: root })

    expect(result.success).toBe(false)
    expect(result.metadata).toMatchObject({
      blocked: true,
      gate: "freshness",
      freshness: { path: "src/a.ts", status: "partial" },
    })
    expect(readFileSync(fullPath, "utf-8")).toBe("one\ntwo\nthree\n")
  })

  test("write_file blocks whole-file overwrite from a truncated structural baseline", async () => {
    const content = Array.from({ length: 410 }, (_, i) => `export const v${i} = ${i}`).join("\n")
    const root = project({ "src/large.ts": content })
    const read = buildTool(READ_FILE)
    const write = buildTool(WRITE_FILE)
    const fullPath = resolve(root, "src/large.ts")

    expect((await read.execute({ path: "src/large.ts" }, { projectRoot: root })).success).toBe(true)
    const result = await write.execute({
      path: "src/large.ts",
      content: "export const replacement = true\n",
      confirm: true,
    }, { projectRoot: root })

    expect(result.success).toBe(false)
    expect(result.metadata).toMatchObject({
      blocked: true,
      gate: "freshness",
      freshness: { path: "src/large.ts", status: "truncated" },
    })
    expect(readFileSync(fullPath, "utf-8")).toBe(content)
  })

  test("multi_edit records agent_write baselines for each committed file", async () => {
    const root = project({
      "src/a.ts": "export const a = 1\n",
      "src/b.ts": "export const b = 1\n",
    })
    const read = buildTool(READ_FILE)
    const tool = buildTool(MULTI_EDIT)

    expect((await read.execute({ path: "src/a.ts" }, { projectRoot: root })).success).toBe(true)
    expect((await read.execute({ path: "src/b.ts" }, { projectRoot: root })).success).toBe(true)
    const result = await tool.execute({
      confirm: true,
      edits: [
        { path: "src/a.ts", old_string: "a = 1", new_string: "a = 2" },
        { path: "src/b.ts", old_string: "b = 1", new_string: "b = 2" },
      ],
    }, { projectRoot: root })
    const ledger = getRuntimeFileStateLedger()

    expect(result.success).toBe(true)
    expect(ledger.get(resolve(root, "src/a.ts"))?.baselinePreview).toContain("a = 2")
    expect(ledger.get(resolve(root, "src/b.ts"))?.baselinePreview).toContain("b = 2")
    expect(result.metadata?.fileStates).toEqual([
      expect.objectContaining({ status: "fresh", source: "agent_write" }),
      expect.objectContaining({ status: "fresh", source: "agent_write" }),
    ])
    expect(result.metadata?.patchTransactionId).toMatch(/^ptxn_/)
  })

  test("edit_file blocks when disk content changed after the full-file baseline", async () => {
    const root = project({ "src/a.ts": "export const value = 1\n" })
    const read = buildTool(READ_FILE)
    const edit = buildTool(EDIT_FILE)
    const fullPath = resolve(root, "src/a.ts")

    expect((await read.execute({ path: "src/a.ts" }, { projectRoot: root })).success).toBe(true)
    writeFileSync(fullPath, "// external change\nexport const value = 1\n", "utf-8")

    const result = await edit.execute({
      path: "src/a.ts",
      old_string: "value = 1",
      new_string: "value = 2",
      confirm: true,
    }, { projectRoot: root })

    expect(result.success).toBe(false)
    expect(result.content).toContain("FreshnessGate")
    expect(result.content).toContain("disk content changed since baseline")
    expect(result.metadata).toMatchObject({
      blocked: true,
      gate: "freshness",
      freshness: { path: "src/a.ts", status: "stale" },
    })
    expect(readFileSync(fullPath, "utf-8")).toBe("// external change\nexport const value = 1\n")
  })

  test("a fresh full reread clears stale state and allows the edit", async () => {
    const root = project({ "src/a.ts": "export const value = 1\n" })
    const read = buildTool(READ_FILE)
    const edit = buildTool(EDIT_FILE)
    const fullPath = resolve(root, "src/a.ts")

    expect((await read.execute({ path: "src/a.ts" }, { projectRoot: root })).success).toBe(true)
    writeFileSync(fullPath, "// external change\nexport const value = 1\n", "utf-8")
    expect((await edit.execute({
      path: "src/a.ts",
      old_string: "value = 1",
      new_string: "value = 2",
      confirm: true,
    }, { projectRoot: root })).success).toBe(false)

    expect((await read.execute({ path: "src/a.ts" }, { projectRoot: root })).success).toBe(true)
    const result = await edit.execute({
      path: "src/a.ts",
      old_string: "value = 1",
      new_string: "value = 2",
      confirm: true,
    }, { projectRoot: root })

    expect(result.success).toBe(true)
    expect(readFileSync(fullPath, "utf-8")).toContain("value = 2")
  })

  test("edit_fim is blocked before model execution when its existing target has no baseline", async () => {
    const root = project({ "src/a.ts": "export const value = 1\n" })
    const fim = buildTool(EDIT_FIM)
    const fullPath = resolve(root, "src/a.ts")

    const result = await fim.execute({
      path: "src/a.ts",
      instruction: "change the value",
      start_line: 1,
      end_line: 1,
      confirm: true,
    }, { projectRoot: root })

    expect(result.success).toBe(false)
    expect(result.metadata).toMatchObject({
      blocked: true,
      gate: "freshness",
      freshness: { path: "src/a.ts", status: "missing" },
    })
    expect(readFileSync(fullPath, "utf-8")).toBe("export const value = 1\n")
  })

  test("edit_fim rejects forbidden paths before calling the remote model", async () => {
    const root = project({ ".git/config": "[core]\nrepositoryformatversion = 0\n" })
    const read = buildTool(READ_FILE)
    const fim = buildTool(EDIT_FIM)
    const previousFetch = globalThis.fetch
    const previousKey = process.env.DEEPSEEK_API_KEY
    let fetchCalls = 0

    expect((await read.execute({ path: ".git/config" }, { projectRoot: root })).success).toBe(true)
    process.env.DEEPSEEK_API_KEY = "test-key"
    globalThis.fetch = (async () => {
      fetchCalls++
      return new Response(JSON.stringify({ choices: [{ text: "changed" }] }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      const result = await fim.execute({
        path: ".git/config",
        instruction: "change config",
        start_line: 1,
        end_line: 1,
        confirm: true,
      }, { projectRoot: root })

      expect(result.success).toBe(false)
      expect(result.metadata).toMatchObject({ blocked: true, gate: "path_policy" })
      expect(fetchCalls).toBe(0)
    } finally {
      globalThis.fetch = previousFetch
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previousKey
    }
  })

  test("edit_fim does not overwrite a file changed while the model is running", async () => {
    const root = project({ "src/a.ts": "export const value = 1\n" })
    const read = buildTool(READ_FILE)
    const fim = buildTool(EDIT_FIM)
    const fullPath = resolve(root, "src/a.ts")
    const previousFetch = globalThis.fetch
    const previousKey = process.env.DEEPSEEK_API_KEY

    expect((await read.execute({ path: "src/a.ts" }, { projectRoot: root })).success).toBe(true)
    process.env.DEEPSEEK_API_KEY = "test-key"
    globalThis.fetch = (async () => {
      writeFileSync(fullPath, "// external change\nexport const value = 1\n", "utf-8")
      return new Response(JSON.stringify({ choices: [{ text: "export const value = 2\n" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch

    try {
      const result = await fim.execute({
        path: "src/a.ts",
        instruction: "change the value",
        start_line: 1,
        end_line: 1,
        confirm: true,
      }, { projectRoot: root })

      expect(result.success).toBe(false)
      expect(result.metadata).toMatchObject({
        blocked: true,
        gate: "freshness",
        freshness: { path: "src/a.ts", status: "stale" },
      })
      expect(readFileSync(fullPath, "utf-8")).toBe("// external change\nexport const value = 1\n")
    } finally {
      globalThis.fetch = previousFetch
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previousKey
    }
  })

  test("multi_edit blocks the whole atomic edit when one target becomes stale", async () => {
    const root = project({
      "src/a.ts": "export const a = 1\n",
      "src/b.ts": "export const b = 1\n",
    })
    const read = buildTool(READ_FILE)
    const multi = buildTool(MULTI_EDIT)
    const pathA = resolve(root, "src/a.ts")
    const pathB = resolve(root, "src/b.ts")

    expect((await read.execute({ path: "src/a.ts" }, { projectRoot: root })).success).toBe(true)
    expect((await read.execute({ path: "src/b.ts" }, { projectRoot: root })).success).toBe(true)
    writeFileSync(pathB, "// external change\nexport const b = 1\n", "utf-8")

    const result = await multi.execute({
      confirm: true,
      edits: [
        { path: "src/a.ts", old_string: "a = 1", new_string: "a = 2" },
        { path: "src/b.ts", old_string: "b = 1", new_string: "b = 2" },
      ],
    }, { projectRoot: root })

    expect(result.success).toBe(false)
    expect(result.metadata).toMatchObject({
      blocked: true,
      gate: "freshness",
      freshness: { path: "src/b.ts", status: "stale" },
    })
    expect(readFileSync(pathA, "utf-8")).toBe("export const a = 1\n")
    expect(readFileSync(pathB, "utf-8")).toBe("// external change\nexport const b = 1\n")
  })
})
