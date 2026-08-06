import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FIND_REFERENCES, FIND_SYMBOL, PROJECT_STRUCTURE } from "../src/tools/codegraph"

describe("codegraph tools", () => {
  test("project_structure labels target project and hides runtime artifacts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dscode-target-"))
    try {
      mkdirSync(join(dir, "src"), { recursive: true })
      mkdirSync(join(dir, ".orcana", "runs"), { recursive: true })
      writeFileSync(join(dir, "src", "index.ts"), "export const ok = true\n", "utf-8")
      writeFileSync(join(dir, ".orcana", "runs", "run.jsonl"), "{}\n", "utf-8")

      const result = await PROJECT_STRUCTURE.execute({ path: dir, max_depth: 3 })
      expect(result.success).toBe(true)
      expect(result.content).toContain("Target project:")
      expect(result.content).toContain("Runtime artifacts")
      expect(result.content).toContain("src")
      expect(result.content).not.toContain(".orcana/")
      expect(result.content).not.toContain("run.jsonl")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("find_symbol treats regex metacharacters in symbol names literally", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dscode-symbol-"))
    try {
      writeFileSync(join(dir, "sample.ts"), "const foo$bar = 1\nconst foo.bar = 2\n", "utf-8")
      const prev = process.cwd()
      process.chdir(dir)
      try {
        const result = await FIND_SYMBOL.execute({ name: "foo$bar", max_results: 10 })
        expect(result.content).toContain("foo$bar = 1")
      } finally {
        process.chdir(prev)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("find_references treats regex metacharacters in symbol names literally", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dscode-ref-"))
    try {
      writeFileSync(join(dir, "sample.ts"), "const foo$bar = 1\nconst foo$barX = 2\n", "utf-8")
      const prev = process.cwd()
      process.chdir(dir)
      try {
        const result = await FIND_REFERENCES.execute({ name: "foo$bar", max_results: 10 })
        expect(result.content).toContain("1 reference(s) to 'foo$bar'")
      } finally {
        process.chdir(prev)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
