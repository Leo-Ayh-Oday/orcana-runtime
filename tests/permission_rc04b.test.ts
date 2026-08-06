/** RC-04b：B3 路径规范化 / H11 categoryOverrides 接线。 */

import { describe, expect, test } from "bun:test"
import { matchPathPattern, normalizePathForPattern } from "../src/agent/permission-config"
import { PermissionGate } from "../src/agent/permission"

describe("RC-04b B3 path normalization", () => {
  test("normalizePathForPattern resolves dot segments", () => {
    expect(normalizePathForPattern("src/../.env")).toBe("/.env")
    expect(normalizePathForPattern("./.env")).toBe("/.env")
    expect(normalizePathForPattern("/a//b")).toBe("/a/b")
    expect(normalizePathForPattern("/a/./b")).toBe("/a/b")
    expect(normalizePathForPattern("a/b/")).toBe("/a/b")
  })

  test("dot segments can no longer bypass pattern", () => {
    // 旧实现：src/../.env 与模式 **/.env 的段比对会 miss（src 段先比）
    expect(matchPathPattern("**/.env", "src/../.env")).toBe(true)
    expect(matchPathPattern("**/.env", "./.env")).toBe(true)
  })

  test("normal pattern matching unchanged", () => {
    expect(matchPathPattern("src/**", "src/app/index.ts")).toBe(true)
    expect(matchPathPattern("src/**", "tests/app/index.ts")).toBe(false)
    expect(matchPathPattern("**/.env", "config/.env")).toBe(true)
  })

  test("exclusion prefix still works", () => {
    expect(matchPathPattern("!**/.env", "src/.env")).toBe(false)
    expect(matchPathPattern("!**/.env", "src/index.ts")).toBe(true)
  })
})

describe("RC-04b H11 categoryOverrides", () => {
  test("override can demote git category to ask", () => {
    const g = new PermissionGate()
    g.loadRules([], [], { git: "ask" })
    const r = g.check("git_status", {})
    expect(r.level).toBe("ask")
  })

  test("override can promote file category to allow", () => {
    const g = new PermissionGate()
    g.loadRules([], [], { file: "allow" })
    const r = g.check("write_file", { path: "/x" })
    expect(r.allowed).toBe(true)
  })

  test("without overrides, defaults apply", () => {
    const g = new PermissionGate()
    const r = g.check("git_status", {})
    expect(r.level).toBe("allow") // git 默认 allow
  })
})
