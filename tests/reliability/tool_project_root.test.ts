/** RC-19 Phase 2 fault baseline — Tool ProjectRoot Authority.
 *
 *  Invariants:
 *    D7  TOOL_PATH_BASE_BOUND      — relative tool paths resolve against
 *        ToolExecutionContext.projectRoot, never against process.cwd().
 *    NEW CROSS_PROJECT_WRITE       — a write must never land outside projectRoot
 *        (including when the process cwd is a different project).
 *    NEW CROSS_PROJECT_READ        — reads must never serve files from outside
 *        projectRoot when cwd points elsewhere.
 *    NEW CWD_DEPENDENT_TOOL_RESULT — the same tool call must produce the same
 *        result regardless of the process cwd.
 *
 *  Fixture (directive §6.4):
 *    /tmp/orcana-eval/project-A  — the authoritative projectRoot
 *    /tmp/orcana-eval/project-B  — the decoy project the process cwd points at
 *
 *  Every test deliberately `process.chdir(project-B)` and asserts the tool
 *  only ever touches project-A.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { READ_FILE, WRITE_FILE } from "../../src/tools/file"
import { buildTools } from "../../src/tools/registry"
import type { ToolExecutionContext } from "../../src/harness/capabilities/execution-context"

const EVAL_ROOT = "/tmp/orcana-eval"
const PROJECT_A = join(EVAL_ROOT, "project-A")
const PROJECT_B = join(EVAL_ROOT, "project-B")
const OUTSIDE = join(EVAL_ROOT, "outside")

const SAVED_CWD = process.cwd()

beforeAll(() => {
  rmSync(EVAL_ROOT, { recursive: true, force: true })
  mkdirSync(join(PROJECT_A, "src"), { recursive: true })
  mkdirSync(join(PROJECT_B, "src"), { recursive: true })
  mkdirSync(OUTSIDE, { recursive: true })
  writeFileSync(join(PROJECT_A, "src", "a.txt"), "CONTENT-FROM-A")
  writeFileSync(join(PROJECT_B, "src", "a.txt"), "CONTENT-FROM-B")
  writeFileSync(join(PROJECT_B, "marker.txt"), "DECOY")
})

afterAll(() => {
  process.chdir(SAVED_CWD)
  rmSync(EVAL_ROOT, { recursive: true, force: true })
})

// The harness ToolExecutionContext (projectRoot etc.) is the RT-2 target; the
// registry's execute() signature still consumes the legacy {abortSignal}
// context. The intersection keeps the harness identity while satisfying the
// legacy param type — Phase 2 unifies the two under resolveToolPath().
function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext & { abortSignal: AbortSignal } {
  return {
    runId: "run-1",
    sessionId: "sess-1",
    projectRoot: PROJECT_A,
    signal: new AbortController().signal,
    abortSignal: new AbortController().signal,
    ...overrides,
  } as ToolExecutionContext & { abortSignal: AbortSignal }
}

const read = buildTools(READ_FILE, WRITE_FILE)[0]!
const write = buildTools(READ_FILE, WRITE_FILE)[1]!

describe("D7 TOOL_PATH_BASE_BOUND — relative paths bind to projectRoot, not cwd", () => {
  test("read_file with cwd=project-B reads project-A content when projectRoot=project-A", async () => {
    process.chdir(PROJECT_B) // decoy cwd
    const result = await read.execute({ path: "src/a.txt" }, makeContext())
    expect(result.success).toBe(true)
    // The file that exists at that relative path under cwd (B) is DIFFERENT
    // from the one under projectRoot (A) — a cwd-dependent tool reads B.
    expect(result.content).toContain("CONTENT-FROM-A")
  })

  test("write_file with cwd=project-B lands inside project-A, not project-B", async () => {
    process.chdir(PROJECT_B)
    const result = await write.execute(
      { path: "src/out.txt", content: "written-into-A", confirm: true },
      makeContext(),
    )
    expect(result.success).toBe(true)
    expect(existsSync(join(PROJECT_A, "src", "out.txt"))).toBe(true)
    expect(existsSync(join(PROJECT_B, "src", "out.txt"))).toBe(false)
  })

  test("same tool call yields the same result regardless of process cwd", async () => {
    const params = { path: "src/a.txt" }
    process.chdir(PROJECT_A)
    const resultA = await read.execute(params, makeContext())
    process.chdir(PROJECT_B)
    const resultB = await read.execute(params, makeContext())
    expect(resultA.content).toBe(resultB.content)
  })
})

describe("NEW CROSS_PROJECT_READ — projectRoot is the read boundary", () => {
  test("relative ..\\ traversal above projectRoot is rejected", async () => {
    process.chdir(PROJECT_B)
    const result = await read.execute({ path: "../outside/marker.txt" }, makeContext())
    expect(result.success).toBe(false)
  })

  test("absolute path outside projectRoot (inside cwd) is rejected", async () => {
    process.chdir(PROJECT_B)
    const result = await read.execute({ path: join(PROJECT_B, "marker.txt") }, makeContext())
    // marker.txt exists on disk at that absolute path — but it is outside the
    // authoritative projectRoot, so the tool must not read it.
    expect(result.success).toBe(false)
  })

  test("absolute path inside projectRoot is allowed", async () => {
    process.chdir(PROJECT_B)
    const result = await read.execute({ path: join(PROJECT_A, "src", "a.txt") }, makeContext())
    expect(result.success).toBe(true)
    expect(result.content).toContain("CONTENT-FROM-A")
  })
})

describe("NEW CROSS_PROJECT_WRITE — projectRoot is the write boundary", () => {
  test("write via relative ..\\ escape above projectRoot is rejected", async () => {
    process.chdir(PROJECT_B)
    const result = await write.execute(
      { path: "../outside/evil.txt", content: "escape", confirm: true },
      makeContext(),
    )
    expect(result.success).toBe(false)
    expect(existsSync(join(OUTSIDE, "evil.txt"))).toBe(false)
  })

  test("absolute write outside projectRoot but inside cwd is rejected", async () => {
    process.chdir(PROJECT_B)
    const result = await write.execute(
      { path: join(PROJECT_B, "evil.txt"), content: "cross-project", confirm: true },
      makeContext(),
    )
    expect(result.success).toBe(false)
    expect(existsSync(join(PROJECT_B, "evil.txt"))).toBe(false)
  })
})

describe("NEW SYMLINK_PROJECT_ESCAPE — symlinks cannot walk out of projectRoot", () => {
  test("read through a symlink pointing outside projectRoot is rejected", async () => {
    process.chdir(PROJECT_A)
    const link = join(PROJECT_A, "src", "escape-link.txt")
    try { symlinkSync(join(OUTSIDE, "symlink-target.txt"), link) } catch { /* exists */ }
    writeFileSync(join(OUTSIDE, "symlink-target.txt"), "outside-secret")
    const result = await read.execute({ path: "src/escape-link.txt" }, makeContext())
    expect(result.success).toBe(false)
  })

  test("non-existing target still reports a clean not-found inside the project", async () => {
    process.chdir(PROJECT_A)
    const result = await read.execute({ path: "src/does-not-exist.ts" }, makeContext())
    expect(result.success).toBe(false)
  })
})
