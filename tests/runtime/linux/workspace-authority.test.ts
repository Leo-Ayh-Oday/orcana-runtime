/** R2 PR-9：Workspace Authority 测试（EA-004..EA-013 子集）。
 *  验证宿主路径权威：相对 cwd 解析、逃逸拒绝、稳定 workspaceId。 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WorkspaceAuthorityRegistry } from "../../../src/runtime/linux/workspace/workspace-authority"
import { LinuxExecutionError } from "../../../src/runtime/linux/errors"

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "wa-test-"))
}

describe("WorkspaceAuthorityRegistry (R2 PR-9)", () => {
  test("EA-004 relative cwd resolves inside workspace", () => {
    const root = freshRoot()
    try {
      mkdirSync(join(root, "src"))
      const registry = new WorkspaceAuthorityRegistry()
      const ws = registry.registerMainWorkspace({ projectId: "p", hostRoot: root, access: "readwrite" })
      expect(registry.resolveCwd(ws, ".")).toBe(root)
      expect(registry.resolveCwd(ws, "src")).toBe(join(root, "src"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("EA-005 absolute cwd rejected (INV-B)", () => {
    const root = freshRoot()
    try {
      const registry = new WorkspaceAuthorityRegistry()
      const ws = registry.registerMainWorkspace({ projectId: "p", hostRoot: root, access: "readwrite" })
      expect(() => registry.resolveCwd(ws, "/")).toThrow(LinuxExecutionError)
      expect(() => registry.resolveCwd(ws, "/home/user")).toThrow(/WORKSPACE_PATH_ESCAPE/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("EA-007 parent traversal rejected", () => {
    const root = freshRoot()
    try {
      mkdirSync(join(root, "src"))
      const registry = new WorkspaceAuthorityRegistry()
      const ws = registry.registerMainWorkspace({ projectId: "p", hostRoot: root, access: "readwrite" })
      expect(() => registry.resolveCwd(ws, "../outside")).toThrow(/WORKSPACE_PATH_ESCAPE/)
      expect(() => registry.resolveCwd(ws, "src/../../etc")).toThrow(/WORKSPACE_PATH_ESCAPE/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("EA-008 symlink escaping workspace rejected", () => {
    const root = freshRoot()
    const outside = freshRoot()
    try {
      mkdirSync(join(root, "linkdir"))
      symlinkSync(outside, join(root, "linkdir", "escape"))
      const registry = new WorkspaceAuthorityRegistry()
      const ws = registry.registerMainWorkspace({ projectId: "p", hostRoot: root, access: "readwrite" })
      expect(() => registry.resolveCwd(ws, "linkdir/escape")).toThrow(/WORKSPACE_PATH_ESCAPE/)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("EA-006 missing cwd rejected", () => {
    const root = freshRoot()
    try {
      const registry = new WorkspaceAuthorityRegistry()
      const ws = registry.registerMainWorkspace({ projectId: "p", hostRoot: root, access: "readwrite" })
      expect(() => registry.resolveCwd(ws, "does-not-exist")).toThrow(/WORKSPACE_CWD_MISSING/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("EA-009 same physical root yields same workspaceId", () => {
    const root = freshRoot()
    try {
      const a = new WorkspaceAuthorityRegistry().registerMainWorkspace({ projectId: "p", hostRoot: root, access: "readwrite" })
      const b = new WorkspaceAuthorityRegistry().registerMainWorkspace({ projectId: "p", hostRoot: root, access: "readwrite" })
      expect(a.workspaceId).toBe(b.workspaceId)
      expect(a.workspaceId.startsWith("ws_")).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("EA-010 different physical roots yield different workspaceIds", () => {
    const a = freshRoot()
    const b = freshRoot()
    try {
      const wa = new WorkspaceAuthorityRegistry().registerMainWorkspace({ projectId: "p", hostRoot: a, access: "readwrite" })
      const wb = new WorkspaceAuthorityRegistry().registerMainWorkspace({ projectId: "p", hostRoot: b, access: "readwrite" })
      expect(wa.workspaceId).not.toBe(wb.workspaceId)
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  test("registration rejects /, HOME root, credential paths", () => {
    const root = freshRoot()
    try {
      const registry = new WorkspaceAuthorityRegistry()
      expect(() => registry.registerMainWorkspace({ projectId: "p", hostRoot: "/", access: "readwrite" })).toThrow(/must not be \//)
      const home = process.env.HOME ?? "/nonexistent"
      if (home !== "/nonexistent") {
        expect(() => registry.registerMainWorkspace({ projectId: "p", hostRoot: home, access: "readwrite" })).toThrow(/HOME/)
      }
      mkdirSync(join(root, "cred"))
      mkdirSync(join(root, "cred", ".ssh"))
      expect(() => registry.registerMainWorkspace({ projectId: "p", hostRoot: join(root, "cred", ".ssh"), access: "readwrite" })).toThrow(/credential/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("EA-013 ownerFiles only from authority; verifyOwnerFiles enforces", () => {
    const root = freshRoot()
    try {
      writeFileSync(join(root, "owned.txt"), "x")
      const registry = new WorkspaceAuthorityRegistry()
      const ws = registry.registerMainWorkspace({ projectId: "p", hostRoot: root, access: "readwrite", ownerFiles: ["owned.txt"] })
      registry.verifyOwnerFiles(ws, ["owned.txt"])
      expect(() => registry.verifyOwnerFiles(ws, ["other.txt"])).toThrow(/WORKSPACE_OWNER_FILE_VIOLATION/)
      const readonlyWs = registry.registerMainWorkspace({ projectId: "p2", hostRoot: root, access: "readonly" })
      expect(() => registry.verifyReadonly(readonlyWs)).toThrow(/WORKSPACE_READONLY/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("LNXF-R2 9.2: physical workspace key (single-writer identity)", () => {
  test("same physical root registers the same physicalWorkspaceKey", () => {
    const root = mkdtempSync(join(tmpdir(), "lnxf-pwk-"))
    try {
      const registry = new WorkspaceAuthorityRegistry()
      const a = registry.registerMainWorkspace({ projectId: "p1", hostRoot: root, access: "readwrite" })
      const b = registry.registerMainWorkspace({ projectId: "p2", hostRoot: root, access: "readwrite" })
      expect(a.physicalWorkspaceKey).toBe(b.physicalWorkspaceKey)
      expect(a.physicalWorkspaceKey.startsWith("wp_")).toBe(true)
      expect(a.workspaceId).not.toBe(b.workspaceId) // 逻辑身份仍区分
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  test("different physical roots get different keys", () => {
    const r1 = mkdtempSync(join(tmpdir(), "lnxf-pwk1-"))
    const r2 = mkdtempSync(join(tmpdir(), "lnxf-pwk2-"))
    try {
      const registry = new WorkspaceAuthorityRegistry()
      const a = registry.registerMainWorkspace({ projectId: "p", hostRoot: r1, access: "readwrite" })
      const b = registry.registerMainWorkspace({ projectId: "p", hostRoot: r2, access: "readwrite" })
      expect(a.physicalWorkspaceKey).not.toBe(b.physicalWorkspaceKey)
    } finally {
      try { rmSync(r1, { recursive: true, force: true }) } catch { /* best-effort */ }
      try { rmSync(r2, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })
})
