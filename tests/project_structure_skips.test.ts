/** RC-16 G5: project_structure must skip dependency directories (node_modules
 *  etc.) with an explicit policy — the real project tree must not be drowned
 *  out or silently misrepresented. */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PROJECT_STRUCTURE } from "../src/tools/codegraph"

describe("project_structure dependency policy (RC-16 G5)", () => {
  test("skips node_modules and hidden dirs with an explicit boundary statement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc16-structure-"))
    try {
      mkdirSync(join(dir, "src"), { recursive: true })
      mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true })
      mkdirSync(join(dir, ".cache"), { recursive: true })
      writeFileSync(join(dir, "src", "real.ts"), "export const ok = true\n", "utf-8")
      writeFileSync(join(dir, "node_modules", "pkg", "index.ts"), "export const dep = true\n", "utf-8")
      writeFileSync(join(dir, ".cache", "junk.ts"), "export const junk = true\n", "utf-8")

      const result = await PROJECT_STRUCTURE.execute({ path: dir, max_depth: 3 }, undefined, { projectRoot: dir })
      expect(result.success).toBe(true)

      expect(result.content).toContain("src/")
      expect(result.content).toContain("real.ts")
      expect(result.content).not.toContain("node_modules/")
      expect(result.content).not.toContain(".cache/")
      expect(result.content).toContain("Boundary")
      expect(result.content).toMatch(/node_modules|dependency/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
