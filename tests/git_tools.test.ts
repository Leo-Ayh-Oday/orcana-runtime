import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { GIT_ADD, GIT_COMMIT, GIT_SHOW } from "../src/tools/git"
import {
  createRuntimeExecutionContext,
  runWithRuntimeExecutionContext,
  setExecutionAuthority,
} from "../src/runtime/execution-context"
import type { TrustedExecutionAuthority } from "../src/runtime/linux/contracts"

const originalCwd = process.cwd()
let activeRoot: string | null = null

/** Git tools run through the managed Linux executor — they need a trusted
 *  authority and the repo must live inside the workspace root. */
function withTestAuthority<T>(fn: () => T | Promise<T>): Promise<T> {
  const context = createRuntimeExecutionContext()
  return runWithRuntimeExecutionContext(context, async () => {
    const authority: TrustedExecutionAuthority = {
      identity: { runId: "git-test", nodeRunId: "git-test-0", attempt: 1 },
      workspace: {
        workspaceId: "git-ws",
        projectId: "git-proj",
        hostRoot: process.cwd(),
        kind: "main",
        access: "readwrite",
        physicalWorkspaceKey: "wp_test",
        ownerFiles: [],
      },
    }
    setExecutionAuthority(authority)
    return await fn()
  })
}

function makeRepo(): string {
  const root = mkdtempSync(join(process.cwd(), ".git-tools-test-"))
  execFileSync("git", ["init", "-q"], { cwd: root })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root })
  writeFileSync(join(root, "a.txt"), "hello\n")
  execFileSync("git", ["add", "a.txt"], { cwd: root })
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: root })
  return root
}

// The git tools run against process.cwd(); point them at the temp repo.
function enterRepo(): string {
  const root = makeRepo()
  activeRoot = root
  process.chdir(root)
  return root
}

afterEach(() => {
  process.chdir(originalCwd)
  if (activeRoot) {
    rmSync(activeRoot, { recursive: true, force: true })
    activeRoot = null
  }
})

describe("git tools — argv-based execution", () => {
  test("git_commit message with shell metacharacters is stored literally, not executed", async () => {
    const root = enterRepo()
    const marker = join(root, "pwned-by-message")
    writeFileSync(join(root, "a.txt"), "hello\nchanged\n") // make something to commit
    const message = `test message; touch ${JSON.stringify(marker)}`
    const result = await withTestAuthority(() => GIT_COMMIT.execute({ message, all: true }))
    expect(result.success).toBe(true)
    // The shell metacharacters must NOT have been interpreted.
    expect(existsSync(marker)).toBe(false)
    // The literal message must be what git recorded.
    const log = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: root, encoding: "utf-8" }).trim()
    expect(log).toBe(message)
  })

  test("git_show with a crafted ref does not shell out", async () => {
    enterRepo()
    // A ref containing a command substitution would execute if shell-interpolated.
    const result = await withTestAuthority(() => GIT_SHOW.execute({ ref: "HEAD; echo injected" }))
    expect(result.success).toBe(false) // git rejects the invalid ref via argv, no shell involved
  })

  test("git_add requires path or all=true", async () => {
    enterRepo()
    const result = await withTestAuthority(() => GIT_ADD.execute({}))
    expect(result.success).toBe(false)
    expect(result.content).toContain("required")
  })
})
