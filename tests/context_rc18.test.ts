/** RC-18 K37/K38/K39/K40 — context batch (staged.ts / kernel.ts).
 *
 *  K37 STAGED_FILES_HASH_REFRESHED — file cache freshness (mtime revalidation)
 *  K38 STAGED_CONTEXT_RELEVANCE_RANKED — relevance ranking vs current prompt
 *  K39 KERNEL_TAIL_PRESERVED — project kernel head+tail, never silent drop
 *  K40 FORK_STABLE_CONTEXT_IMMUTABLE — mutable files never in the stable part
 *
 *  NOTE on K37 test mechanics: on this WSL2 ext4 fs, a rewrite that lands in
 *  the same journal transaction as the file-creation burst may NOT bump
 *  mtime/ctime (verified empirically). Production edits are spaced out and
 *  update mtime normally, so mtime is the correct cheap signal — tests use
 *  explicit `utimesSync` (timestamp control) to bump mtime deterministically.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { StagedContextManager } from "../src/context/staged"
import { buildContextKernel } from "../src/context/kernel"

const roots: string[] = []

function tmpProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rc18-context-"))
  roots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

/** Rewrite a file AND force an mtime bump (deterministic on this fs). */
function rewriteFile(root: string, rel: string, content: string) {
  const full = join(root, rel)
  writeFileSync(full, content)
  utimesSync(full, new Date(), new Date())
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// ── K37 STAGED_FILES_HASH_REFRESHED ──

describe("K37 staged file cache freshness", () => {
  test("refreshes staged content when the file changes on disk", () => {
    const root = tmpProject({ "src/a.ts": "version-one" })
    const staged = new StagedContextManager(root)
    staged.markLoaded("src/a.ts")
    expect(staged.buildContext().warm[0]!.content).toContain("version-one")

    rewriteFile(root, "src/a.ts", "version-two")
    expect(staged.buildContext().warm[0]!.content).toContain("version-two")
  })

  test("serves from cache without re-reading when mtime is unchanged", () => {
    const root = tmpProject({ "src/a.ts": "stable-content" })
    const staged = new StagedContextManager(root)
    const readSpy = spyOn(staged, "readFileContent")
    staged.markLoaded("src/a.ts")
    expect(readSpy).toHaveBeenCalledTimes(1)

    staged.buildContext()
    staged.buildContext()
    expect(readSpy).toHaveBeenCalledTimes(1) // untouched → cache, no re-read

    rewriteFile(root, "src/a.ts", "changed-content")
    staged.buildContext()
    expect(readSpy).toHaveBeenCalledTimes(2) // mtime moved → re-read
  })

  test("legacy cache entry without freshness meta is refreshed", () => {
    const root = tmpProject({ "src/a.ts": "disk-content" })
    const staged = new StagedContextManager(root)
    // Backward compatibility: a plain-string entry (no mtime meta) is treated
    // as needing refresh on next use.
    staged.loadedFiles.set("src/a.ts", "stale-legacy-content")
    expect(staged.buildContext().warm[0]!.content).toContain("disk-content")
  })

  test("refreshLoadedFiles reports refreshed vs reused per file", () => {
    const root = tmpProject({ "src/a.ts": "v1", "src/b.ts": "b" })
    const staged = new StagedContextManager(root)
    staged.markLoaded("src/a.ts")
    staged.markLoaded("src/b.ts")
    expect(staged.refreshLoadedFiles()).toEqual({ refreshed: [], reused: ["src/a.ts", "src/b.ts"] })

    rewriteFile(root, "src/a.ts", "v2")
    expect(staged.refreshLoadedFiles()).toEqual({ refreshed: ["src/a.ts"], reused: ["src/b.ts"] })
  })
})

// ── K38 STAGED_CONTEXT_RELEVANCE_RANKED ──

describe("K38 staged context relevance ranking", () => {
  function stagedWithTwoUtils(): StagedContextManager {
    // Both paths land in the same mechanical band (UTIL, priority 2).
    const staged = new StagedContextManager(tmpProject({}))
    staged.loadedFiles.set("src/util-plumb.ts", "handles the retry and backoff loop")
    staged.loadedFiles.set("src/util-cfg.ts", "reads configuration values")
    return staged
  }

  test("ranks the file matching the prompt first within the same band", () => {
    const staged = stagedWithTwoUtils()
    const ctx = staged.buildContext("fix the retry backoff logic please")
    const sources = ctx.warm.map(l => l.source)
    expect(sources.indexOf("src/util-plumb.ts")).toBeLessThan(sources.indexOf("src/util-cfg.ts"))
  })

  test("keeps original insertion order when no prompt is given (no degradation)", () => {
    const staged = stagedWithTwoUtils()
    const ctx = staged.buildContext()
    expect(ctx.warm.map(l => l.source)).toEqual(["src/util-plumb.ts", "src/util-cfg.ts"])
  })

  test("mechanical baseline still dominates relevance (entry beats generic)", () => {
    const staged = new StagedContextManager(tmpProject({}))
    staged.loadedFiles.set("main.ts", "unrelated content")
    staged.loadedFiles.set("util-helper.ts", "retry logic backoff handling")
    const ctx = staged.buildContext("retry logic backoff handling")
    const sources = ctx.warm.map(l => l.source)
    expect(sources[0]).toBe("main.ts") // priority 0 wins even with zero relevance
    expect(sources.indexOf("util-helper.ts")).toBe(1)
  })

  test("prompt with only function words falls back to mechanical order", () => {
    const staged = stagedWithTwoUtils()
    const ctx = staged.buildContext("please do it for me")
    expect(ctx.warm.map(l => l.source)).toEqual(["src/util-plumb.ts", "src/util-cfg.ts"])
  })
})

// ── K39 KERNEL_TAIL_PRESERVED ──

describe("K39 project kernel tail preservation", () => {
  test("long kernel file keeps its tail in the text and is annotated in meta", () => {
    const root = tmpProject({ "AGENTS.md": "head-line\n" + "middle-".repeat(1200) + "\ntail-sentinel-END" })
    const kernel = buildContextKernel(root)
    expect(kernel.text).toContain("tail-sentinel-END")
    expect(kernel.text).toContain("omitted")
    expect(kernel.sections).toContain("AGENTS.md")
    const note = kernel.fileNotes?.find(n => n.file === "AGENTS.md")
    expect(note).toBeDefined()
    expect(note!.truncated).toBe(true)
    expect(note!.totalChars).toBeGreaterThan(3000)
  })

  test("small kernel file is read in full with no truncation note", () => {
    const root = tmpProject({ "AGENTS.md": "short rules" })
    const kernel = buildContextKernel(root)
    expect(kernel.text).toContain("short rules")
    expect(kernel.fileNotes).toBeUndefined()
  })

  test("hash stays deterministic across builds", () => {
    const root = tmpProject({ "AGENTS.md": "head\n" + "mid-".repeat(900) + "\nend" })
    expect(buildContextKernel(root).hash).toBe(buildContextKernel(root).hash)
  })
})

// ── K40 FORK_STABLE_CONTEXT_IMMUTABLE ──

describe("K40 forkStableContext immutability", () => {
  test("mutable loaded file content stays out of the stable part", () => {
    const root = tmpProject({ "src/a.ts": "FILE-CONTENT-MARKER-xyz" })
    const staged = new StagedContextManager(root)
    staged.markLoaded("src/a.ts")
    const fork = staged.forkStableContext({ description: "inspect src/a.ts" })

    expect(fork.stableContext).not.toContain("FILE-CONTENT-MARKER-xyz")
    // Immutable source still copied: project skeleton.
    expect(fork.stableContext).toContain("Target project:")
    // Mutable files ride in the volatile part instead.
    expect(fork.volatileContext).toContain("FILE-CONTENT-MARKER-xyz")
    expect(fork.cachePointIndex).toBe(fork.stableContext.split("\n").length)
  })

  test("fork revalidates cached files against disk before rendering", () => {
    const root = tmpProject({ "src/a.ts": "old-content" })
    const staged = new StagedContextManager(root)
    staged.markLoaded("src/a.ts")

    rewriteFile(root, "src/a.ts", "new-content-on-disk")
    const fork = staged.forkStableContext({ description: "read src/a.ts" })
    expect(fork.stableContext).not.toContain("new-content-on-disk")
    expect(fork.volatileContext).toContain("new-content-on-disk")
    expect(fork.volatileContext).not.toContain("old-content")
  })

  test("fork without loaded files keeps the original return shape", () => {
    const staged = new StagedContextManager(tmpProject({}))
    const fork = staged.forkStableContext({ description: "explain the design" })
    expect(fork.stableContext).toContain("Target project:")
    expect(fork.volatileContext).toContain("## Sub-task")
    expect(fork.volatileContext).toContain("explain the design")
    expect(fork.cachePointIndex).toBe(fork.stableContext.split("\n").length)
  })
})
