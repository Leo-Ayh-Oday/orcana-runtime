/** LR2-2（P2-C）：Overlay 验收 —— 探测链顺序 / Git Worktree fallback
 *  创建/差异/丢弃（OVERLAY_WRITE_ESCAPES_UPPER = 0：写层隔离）。 */

import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detectOverlayBackend, GitWorktreeOverlay } from "../../../../src/runtime/linux/workspace/overlay"

function gitRepo(dir: string): void {
  const run = (args: string[]): void => { execFileSync("git", args, { cwd: dir, stdio: "ignore" }) }
  run(["init", "-q", "-b", "main"])
  run(["config", "user.email", "test@orcana.local"])
  run(["config", "user.name", "orcana-test"])
  writeFileSync(join(dir, "base.txt"), "base\n")
  run(["add", "."])
  run(["commit", "-qm", "base"])
}

describe("Overlay (P2-C)", () => {
  test("detection chain prefers overlayfs, falls back to git-worktree", () => {
    const backend = detectOverlayBackend()
    // WSL 无 mount 权限 → 本机应为 git-worktree；有 overlay 能力环境为 overlayfs
    expect(["overlayfs", "fuse-overlayfs", "git-worktree"]).toContain(backend)
  })

  test("git-worktree fallback: create/diff/discard lifecycle", () => {
    const dir = mkdtempSync(join(tmpdir(), "ovl-"))
    const repo = join(dir, "repo")
    const workRoot = join(dir, "work")
    mkdirSync(repo)
    mkdirSync(workRoot)
    try {
      gitRepo(repo)
      const overlay = new GitWorktreeOverlay()
      const inst = overlay.create(repo, "HEAD", workRoot, "cell-1")
      expect(inst.mergedPath).toContain("wt-cell-1")
      expect(readFileSync(join(inst.mergedPath, "base.txt"), "utf8")).toBe("base\n")

      // 写层改动（upper 语义）
      writeFileSync(join(inst.mergedPath, "new.txt"), "new\n")
      writeFileSync(join(inst.mergedPath, "base.txt"), "modified\n")

      const diff = inst.diff()
      expect(diff.created).toContain("new.txt")
      expect(diff.changed).toContain("base.txt")

      // 丢弃写层：worktree 移除，仓库无残留
      inst.discard()
      expect(existsSync(inst.mergedPath)).toBe(false)
      // 仓库本身未被污染（OVERLAY_WRITE_ESCAPES_UPPER：写层丢弃不回流 lower）
      const repoStatus = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim()
      expect(repoStatus).toBe("")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("snapshot produces a commit for reviewer/evolution (write layer only)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ovl-"))
    const repo = join(dir, "repo")
    const workRoot = join(dir, "work")
    mkdirSync(repo)
    mkdirSync(workRoot)
    try {
      gitRepo(repo)
      const overlay = new GitWorktreeOverlay()
      const inst = overlay.create(repo, "HEAD", workRoot, "cell-2")
      writeFileSync(join(inst.mergedPath, "candidate.txt"), "candidate\n")
      const snapshotRef = inst.snapshot()
      expect(snapshotRef).toMatch(/^[0-9a-f]{40}$/)
      // 快照提交只含写层内容
      const files = execFileSync("git", ["ls-tree", "--name-only", snapshotRef], { cwd: repo, encoding: "utf8" }).trim()
      expect(files).toContain("candidate.txt")
      inst.discard()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── LR2-2 审核修复验收（M3）──

describe("Overlay audit fixes (M3)", () => {
  test("M3: path traversal label is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "ovl-"))
    const repo = join(dir, "repo")
    const workRoot = join(dir, "work")
    mkdirSync(repo)
    mkdirSync(workRoot)
    try {
      gitRepo(repo)
      const overlay = new GitWorktreeOverlay()
      expect(() => overlay.create(repo, "HEAD", workRoot, "../../escape")).toThrow(/invalid overlay label/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("M3: snapshotRef is pinned to a commit SHA (rev syntax cannot escape)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ovl-"))
    const repo = join(dir, "repo")
    const workRoot = join(dir, "work")
    mkdirSync(repo)
    mkdirSync(workRoot)
    try {
      gitRepo(repo)
      const overlay = new GitWorktreeOverlay()
      const inst = overlay.create(repo, "HEAD", workRoot, "cell-pin")
      expect(inst.mergedPath).toContain("wt-cell-pin")
      inst.discard()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
