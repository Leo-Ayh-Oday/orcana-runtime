import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parsePorcelainV2 } from "../../src/tools/git"
import { GIT_STATUS, GIT_ADD, GIT_COMMIT } from "../../src/tools/git"

// RT-8: git 2.0 — porcelain=v2 structured status, risk-separated writers.

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rt8-git-"))
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
  git(["init", "-q"])
  git(["config", "user.email", "test@example.com"])
  git(["config", "user.name", "RT8 Test"])
  return dir
}

const SAVED_CWD = process.cwd()

function inRepo(dir: string) {
  // Tool functions resolve git against cwd — tests run inside the repo dir.
  process.chdir(dir)
  return () => process.chdir(SAVED_CWD)
}

afterEach(() => process.chdir(SAVED_CWD))

describe("RT-8 porcelain v2 parsing", () => {
  test("parses branch, staged, unstaged, untracked", () => {
    const state = parsePorcelainV2(
      "# branch.head main\n# branch.ab +2 -1\n1 M. N... 100644 100644 100644 aaaa bbbb a.ts\n1 .M N... 100644 100644 100644 cccc dddd b.ts\n? untracked.txt\n",
    )
    expect(state.branch).toBe("main")
    expect(state.staged).toEqual(["a.ts"])
    expect(state.unstaged).toEqual(["b.ts"])
    expect(state.untracked).toEqual(["untracked.txt"])
    expect(state.dirty).toBe(true)
  })

  test("parses conflicts as a separate class", () => {
    const state = parsePorcelainV2("1 UU N... 100644 100644 100644 x y conflicted.ts\n")
    expect(state.conflicts).toEqual(["conflicted.ts"])
    expect(state.staged).toEqual([])
    expect(state.unstaged).toEqual([])
  })

  test("clean tree is not dirty", () => {
    expect(parsePorcelainV2("# branch.head main\n").dirty).toBe(false)
  })
})

describe("RT-8 git tools", () => {
  test("git_status returns structured state from a real repo", async () => {
    const dir = initRepo()
    const restore = inRepo(dir)
    try {
      writeFileSync(join(dir, "base.txt"), "v1\n")
      execFileSync("git", ["add", "base.txt"], { cwd: dir })
      execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir })
      writeFileSync(join(dir, "base.txt"), "v2\n")
      writeFileSync(join(dir, "new.txt"), "n\n")

      const result = await GIT_STATUS.execute!({})
      expect(result.success).toBe(true)
      const state = (result.metadata as { state: { branch: string; staged: string[]; unstaged: string[]; untracked: string[]; conflicts: string[]; dirty: boolean } }).state
      expect(state.branch).toBe("main")
      expect(state.unstaged).toContain("base.txt")
      expect(state.untracked).toContain("new.txt")
      expect(state.dirty).toBe(true)
      expect(result.content).toContain("base.txt")
    } finally {
      restore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("git_diff reports structured numstat", async () => {
    const dir = initRepo()
    const restore = inRepo(dir)
    try {
      writeFileSync(join(dir, "f.ts"), "line1\nline2\nline3\n")
      execFileSync("git", ["add", "f.ts"], { cwd: dir })
      execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir })
      writeFileSync(join(dir, "f.ts"), "line1\nline2 modified\nline3\nline4\n")

      const result = await GIT_DIFF.execute!({})
      expect(result.success).toBe(true)
      const stat = (result.metadata as { stat: Array<{ path: string; additions: number; deletions: number }> }).stat
      expect(stat.length).toBe(1)
      expect(stat[0]!.path).toBe("f.ts")
      expect(stat[0]!.additions).toBe(2)
      expect(stat[0]!.deletions).toBe(1)
      expect(result.content).toContain("f.ts")
    } finally {
      restore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("mutating git tools are risk-separated (confirmation required)", () => {
    expect(GIT_STATUS.isReadonly).toBe(true)
    expect(GIT_ADD.isReadonly).toBe(false)
    expect(GIT_ADD.requiresConfirmation).toBe(true)
    expect(GIT_COMMIT.isReadonly).toBe(false)
    expect(GIT_COMMIT.requiresConfirmation).toBe(true)
  })
})

// Imported here to keep the tool under test in scope.
import { GIT_DIFF } from "../../src/tools/git"
