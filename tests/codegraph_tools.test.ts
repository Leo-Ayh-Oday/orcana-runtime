import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PROJECT_STRUCTURE } from "../src/tools/codegraph"

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
})
