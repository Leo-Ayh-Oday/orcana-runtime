import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

      expect(hooks.beforeCount).toBe(3)
      expect(hooks.afterCount).toBe(2)
      expect(hooks.handlerCounts()).toMatchObject({
        PreToolUse: 3,
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

  test("warns about shell side effects from the default hook stack", async () => {
    const repo = tempRepo()
    try {
      const hooks = createDefaultHookSystem({ projectRoot: repo })

      const result = await hooks.runBefore("shell", {
        command: "Move-Item -Force old.ts new.ts",
      })

      expect(result.blocked).toBe(false)
      expect(result.warnings.join("\n")).toContain("Shell 副作用")
      expect(result.trace).toContain("warn by hooks:side-effect-policy")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("blocks dangerous side effects from the default hook stack", async () => {
    const repo = tempRepo()
    try {
      const hooks = createDefaultHookSystem({ projectRoot: repo })

      const result = await hooks.runBefore("shell", {
        command: "git checkout -- /etc/hosts",
      })

      expect(result.blocked).toBe(true)
      expect(result.warnings.join("\n")).toContain("Shell 副作用")
      expect(result.trace[0]).toContain("hooks:side-effect-policy")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("blocks unread existing-file edits by default", async () => {
    resetWriteGuard()
    const repo = tempRepo()
    try {
      const hooks = createDefaultHookSystem({ projectRoot: repo })
      const path = join(repo, "src", "file.ts")
      mkdirSync(join(repo, "src"), { recursive: true })
      writeFileSync(path, "old", "utf-8")

      const result = await hooks.runBefore("edit_file", { path })

      expect(result.blocked).toBe(true)
      expect(result.warnings.join("\n")).toContain("blocked in strict mode")
      expect(result.trace[0]).toContain("hooks:writeGuard")
    } finally {
      resetWriteGuard()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("blocks unread write_file overwrites but allows new files", async () => {
    resetWriteGuard()
    const repo = tempRepo()
    try {
      const hooks = createDefaultHookSystem({ projectRoot: repo })
      const existing = join(repo, "src", "existing.ts")
      const created = join(repo, "src", "created.ts")
      mkdirSync(join(repo, "src"), { recursive: true })
      writeFileSync(existing, "old", "utf-8")

      const overwrite = await hooks.runBefore("write_file", { path: existing, content: "new" })
      const create = await hooks.runBefore("write_file", { path: created, content: "new" })

      expect(overwrite.blocked).toBe(true)
      expect(overwrite.warnings.join("\n")).toContain("blocked in strict mode")
      expect(create.blocked).toBe(false)
      expect(create.warnings).toEqual([])
    } finally {
      resetWriteGuard()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("can keep unread existing-file edits in warn mode for compatibility", async () => {
    resetWriteGuard()
    const repo = tempRepo()
    try {
      const hooks = createDefaultHookSystem({ projectRoot: repo, writeGuardMode: "warn" })
      const path = join(repo, "src", "file.ts")
      mkdirSync(join(repo, "src"), { recursive: true })
      writeFileSync(path, "old", "utf-8")

      const result = await hooks.runBefore("edit_file", { path })

      expect(result.blocked).toBe(false)
      expect(result.warnings.join("\n")).toContain("hasn't been read yet")
      expect(result.trace[0]).toContain("hooks:writeGuard")
    } finally {
      resetWriteGuard()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("requires every multi_edit target to be read in strict mode", async () => {
    resetWriteGuard()
    const repo = tempRepo()
    try {
      const hooks = createDefaultHookSystem({ projectRoot: repo })
      const pathA = join(repo, "src", "a.ts")
      const pathB = join(repo, "src", "b.ts")
      mkdirSync(join(repo, "src"), { recursive: true })
      writeFileSync(pathA, "a", "utf-8")
      writeFileSync(pathB, "b", "utf-8")

      await hooks.runAfter("read_file", { path: pathA }, { success: true, content: "a" })
      const result = await hooks.runBefore("multi_edit", {
        edits: [
          { path: pathA, old_string: "a", new_string: "aa" },
          { path: pathB, old_string: "b", new_string: "bb" },
        ],
      })

      expect(result.blocked).toBe(true)
      expect(result.warnings.join("\n")).toContain("b.ts")
      expect(result.warnings.join("\n")).not.toContain("a.ts,")
    } finally {
      resetWriteGuard()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("does not share read state across default hook systems", async () => {
    const repo = tempRepo()
    try {
      const path = join(repo, "src", "file.ts")
      mkdirSync(join(repo, "src"), { recursive: true })
      writeFileSync(path, "old", "utf-8")
      const first = createDefaultHookSystem({ projectRoot: repo })
      const second = createDefaultHookSystem({ projectRoot: repo })

      await first.runAfter("read_file", { path }, { success: true, content: "old" })
      const firstResult = await first.runBefore("edit_file", { path })
      const secondResult = await second.runBefore("edit_file", { path })

      expect(firstResult.blocked).toBe(false)
      expect(secondResult.blocked).toBe(true)
      expect(secondResult.trace[0]).toContain("hooks:writeGuard")
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
