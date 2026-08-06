import { describe, expect, test, mock } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("saveColdArchive atomicity", () => {
  test("writes archive via temp file + fsync + rename, never directly to the final path", async () => {
    const writes: string[] = []
    let fsyncs = 0
    const renames: Array<[string, string]> = []
    mock.module("node:fs", () => {
      const fs = require("node:fs") as typeof import("node:fs")
      return {
        ...fs,
        writeFileSync: (path: unknown, ...rest: unknown[]) => {
          writes.push(String(path))
          return fs.writeFileSync(path as never, rest[0] as never, rest[1] as never)
        },
        fsyncSync: (fd: unknown) => {
          fsyncs++
          return fs.fsyncSync(fd as number)
        },
        renameSync: (from: unknown, to: unknown) => {
          renames.push([String(from), String(to)])
          return fs.renameSync(from as never, to as never)
        },
      }
    })

    const { createCompactor, saveColdArchive } = await import("../src/memory/compactor")
    const dir = mkdtempSync(join(tmpdir(), "orcana-archive-"))
    try {
      const state = createCompactor(dir)
      state.hotTurns = [{ role: "user", content: "hello world" }]
      state.estimatedTokens = 10
      const archive = saveColdArchive(state, "sess")
      expect(archive).not.toBeNull()
      expect(writes.some(path => path.endsWith(".json.tmp"))).toBe(true)
      expect(writes.some(path => path.endsWith(".json") && !path.endsWith(".json.tmp"))).toBe(false)
      expect(fsyncs).toBeGreaterThan(0)
      expect(renames.some(([from, to]) => from.endsWith(".json.tmp") && to.endsWith(".json"))).toBe(true)
      expect(readdirSync(join(dir, "archives")).some(name => name.endsWith(".tmp"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
