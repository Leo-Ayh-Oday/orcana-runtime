import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseUnifiedDiff, applyDiffString, applyParsedFilePatch, resetCommittedKeys, isKeyCommitted } from "../../src/tools/apply-patch"
import { computeBaseHash } from "../../src/agent/patch-transaction"
import { executeApplyPatchTransaction } from "../../src/tools/apply-patch"

// RT-6: unified-diff application — freshness, path-escape rejection,
// dry-run, idempotent transactions.

const DIFF = [
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " export const a = 1",
  "+export const b = 2",
  " export const c = 3",
  " export const d = 4",
].join("\n")

afterEach(() => resetCommittedKeys())

describe("RT-6 parseUnifiedDiff", () => {
  test("parses file header + hunks with additions", () => {
    const parsed = parseUnifiedDiff(DIFF)
    expect(parsed.errors).toEqual([])
    expect(parsed.files).toHaveLength(1)
    expect(parsed.files[0]!.path).toBe("src/a.ts")
    expect(parsed.files[0]!.hunks).toHaveLength(1)
    const hunk = parsed.files[0]!.hunks[0]!
    expect(hunk.oldStart).toBe(1)
    expect(hunk.lines.filter((l) => l.type === "add")).toHaveLength(1)
    expect(hunk.lines.filter((l) => l.type === "context")).toHaveLength(3)
  })

  test("malformed hunks are reported, never guessed", () => {
    const parsed = parseUnifiedDiff("+++ b/x.ts\n@@ -oops @@\n+line\n")
    expect(parsed.errors.length).toBeGreaterThan(0)
  })
})

describe("RT-6 applyDiffString", () => {
  test("applies a patch and reports structured stats", () => {
    const cwd = mkdtempSync(join(tmpdir(), "rt6-"))
    try {
      mkdirSync(join(cwd, "src"), { recursive: true })
      writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1\nexport const c = 3\nexport const d = 4\n")
      const out = applyDiffString(DIFF, { projectRoot: cwd })
      expect(out.errors).toEqual([])
      expect(out.files).toHaveLength(1)
      expect(out.files[0]!.applied).toBe(true)
      expect(out.files[0]!.additions).toBe(1)
      expect(out.totalAdditions).toBe(1)
      const content = readFileSync(join(cwd, "src", "a.ts"), "utf-8")
      expect(content).toContain("export const b = 2")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("path escape is rejected before any write", () => {
    const cwd = mkdtempSync(join(tmpdir(), "rt6-esc-"))
    try {
      const evil = "+++ b/../escape.txt\n@@ -0,0 +1 @@\n+owned\n"
      const out = applyDiffString(evil, { projectRoot: cwd })
      expect(out.files[0]!.applied).toBe(false)
      expect(out.files[0]!.error).toContain("outside writable roots")
      expect(existsSync(join(cwd, "..", "escape.txt"))).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("base hash mismatch blocks the patch (stale base)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "rt6-base-"))
    try {
      mkdirSync(join(cwd, "src"), { recursive: true })
      writeFileSync(join(cwd, "src", "a.ts"), "line1\nline2\nline3\n")
      const stale = computeBaseHash("DIFFERENT CONTENT")
      const out = applyDiffString(DIFF, { projectRoot: cwd, expectedBaseHashes: { "src/a.ts": stale } })
      expect(out.files[0]!.applied).toBe(false)
      expect(out.files[0]!.error).toContain("base hash mismatch")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("dry run never touches the workspace", () => {
    const cwd = mkdtempSync(join(tmpdir(), "rt6-dry-"))
    try {
      mkdirSync(join(cwd, "src"), { recursive: true })
      writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1\nexport const c = 3\nexport const d = 4\n")
      const out = applyDiffString(DIFF, { projectRoot: cwd, dryRun: true })
      expect(out.files[0]!.applied).toBe(true)
      expect(out.dryRun).toBe(true)
      const content = readFileSync(join(cwd, "src", "a.ts"), "utf-8")
      expect(content).not.toContain("export const b = 2")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("new-file patch creates the file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "rt6-new-"))
    try {
      const create = "+++ b/hello.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n"
      const out = applyDiffString(create, { projectRoot: cwd })
      expect(out.files[0]!.applied).toBe(true)
      expect(readFileSync(join(cwd, "hello.txt"), "utf-8")).toBe("hello\nworld")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe("RT-6 apply_patch_transaction idempotency", () => {
  test("same idempotencyKey replays as already-applied", () => {
    const cwd = mkdtempSync(join(tmpdir(), "rt6-txn-"))
    try {
      const result1 = executeApplyPatchTransaction({
        patches: [{ diff: DIFF }],
        idempotencyKey: "txn-1",
      }, cwd)
      expect(result1.success).toBe(true)
      expect(isKeyCommitted("txn-1")).toBe(true)

      const result2 = executeApplyPatchTransaction({
        patches: [{ diff: DIFF }],
        idempotencyKey: "txn-1",
      }, cwd)
      expect(result2.success).toBe(true)
      expect((result2.metadata as { idempotent: boolean }).idempotent).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("failing patch rolls back the whole transaction", () => {
    const cwd = mkdtempSync(join(tmpdir(), "rt6-rb-"))
    try {
      const good = "+++ b/new1.txt\n@@ -0,0 +1 @@\n+first\n"
      const bad = "+++ b/../escape.txt\n@@ -0,0 +1 @@\n+owned\n"
      const result = executeApplyPatchTransaction({
        patches: [{ diff: good }, { diff: bad }],
      }, cwd)
      expect(result.success).toBe(false)
      expect(existsSync(join(cwd, "new1.txt"))).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe("RT-6 applyParsedFilePatch helper", () => {
  test("absolute path outside root is rejected by the boundary", () => {
    const cwd = mkdtempSync(join(tmpdir(), "rt6-abs-"))
    try {
      const parsed = parseUnifiedDiff("+++ b//etc/passwd\n@@ -0,0 +1 @@\n+x\n")
      const out = applyParsedFilePatch(parsed.files[0]!, { projectRoot: cwd })
      expect(out.applied).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
