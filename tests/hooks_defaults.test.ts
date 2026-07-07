import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createDefaultHookSystem } from "../src/hooks/defaults"
import { resetWriteGuard } from "../src/hooks/builtin"

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "orcana-hooks-"))
}

describe("createDefaultHookSystem", () => {
  test("registers default before and after tool hooks", () => {
    const repo = tempRepo()
    try {
      const hooks = createDefaultHookSystem({ projectRoot: repo })

      expect(hooks.beforeCount).toBe(2)
      expect(hooks.afterCount).toBe(2)
      expect(hooks.handlerCounts()).toMatchObject({
        PreToolUse: 2,
        PostToolUse: 2,
      })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("includes safety policy before write guard", async () => {
    const repo = tempRepo()
    try {
      const hooks = createDefaultHookSystem({ projectRoot: repo })

      const result = await hooks.runBefore("shell", {
        command: "git reset --hard HEAD",
      })

      expect(result.blocked).toBe(true)
      expect(result.warnings.join("\n")).toContain("Safety policy blocked")
      expect(result.trace[0]).toContain("hooks:safety-policy")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("tracks successful reads before later file writes", async () => {
    resetWriteGuard()
    const repo = tempRepo()
    try {
      const hooks = createDefaultHookSystem({ projectRoot: repo })
      const path = join(repo, "src", "file.ts")

      await hooks.runAfter("read_file", { path }, { success: true, content: "ok" })
      const result = await hooks.runBefore("edit_file", { path })

      expect(result.blocked).toBe(false)
      expect(result.warnings).toEqual([])
    } finally {
      resetWriteGuard()
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
