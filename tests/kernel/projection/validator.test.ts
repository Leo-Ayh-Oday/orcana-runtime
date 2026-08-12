/** AK2-T05 — Commit Validator 表驱动（delta 来自真实 scanner）。 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectionError } from "../../../src/kernel/projection/contracts"
import { validateProjectionCommit, type ProjectionExecutionOutcome, type ProjectionValidationInput } from "../../../src/kernel/projection/validator"
import { scanProjectionDelta } from "../../../src/kernel/projection/scanner"
import type { WorldProjectionPlan } from "../../../src/kernel/projection/contracts"
import type { AgentWorld, WorldBranch, WorldSnapshot } from "../../../src/kernel/world"
import type { CasDigest } from "../../../src/kernel/world"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ak2-val-${label}-`))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

class MemCas {
  readonly objects = new Map<string, Buffer>()
  put(content: Uint8Array, _mediaType = "application/octet-stream") {
    const { createHash } = require("node:crypto") as typeof import("node:crypto")
    const bytes = Buffer.from(content)
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as CasDigest
    if (!this.objects.has(digest)) this.objects.set(digest, bytes)
    return { digest, size: bytes.byteLength, mediaType: "", mediaTypes: [], isManifest: false, createdAt: 0, refCount: 0 }
  }
  has(digest: CasDigest): boolean {
    return this.objects.has(digest)
  }
}

const plan: WorldProjectionPlan = {
  projectionId: "proj-1",
  worldId: "w",
  branchId: "b",
  snapshotId: "snapshot:1",
  actor: "actor:test",
  mode: "native",
  writableRoots: ["src"],
  readonlyRoots: ["docs"],
  expectedOutputs: ["src/out.txt"],
  graphCompletionAllowed: false,
}

const snapshot: WorldSnapshot = {
  snapshotId: "snapshot:1",
  worldId: "w",
  branchId: "b",
  revision: 1n,
  manifestDigest: "sha256:m" as CasDigest,
  filesystemDigest: "sha256:f" as CasDigest,
  memoryDigest: "sha256:x" as CasDigest,
  taskStateDigest: "sha256:x" as CasDigest,
  capabilityStateDigest: "sha256:x" as CasDigest,
  serviceStateDigest: "sha256:x" as CasDigest,
  artifactStateDigest: "sha256:x" as CasDigest,
  createdAt: 1,
}

const world: AgentWorld = {
  worldId: "w",
  currentRevision: 1n,
  currentBranchId: "b",
  rootObjectId: "root-1",
  createdAt: 1,
  updatedAt: 1,
  status: "active",
}

const branch: WorldBranch = {
  branchId: "b",
  worldId: "w",
  baseRevision: 0n,
  headRevision: 1n,
  owner: "o",
  purpose: "p",
  status: "active",
  createdAt: 1,
}

const outcome: ProjectionExecutionOutcome = {
  exitCode: 0,
  timedOut: false,
  cancelled: false,
  violation: false,
}

/** 构建 merged 目录（base 空）并扫描 delta。 */
function buildDelta(files: Record<string, string>): { delta: ReturnType<typeof scanProjectionDelta>; merged: string } {
  const root = tmpRoot("delta")
  const base = join(root, "base")
  const merged = join(root, "merged")
  mkdirSync(base)
  mkdirSync(merged)
  const cas = new MemCas()
  for (const [rel, content] of Object.entries(files)) {
    const full = join(merged, ...rel.split("/"))
    mkdirSync(join(merged, ...rel.split("/").slice(0, -1)), { recursive: true })
    writeFileSync(full, content, "utf8")
  }
  const delta = scanProjectionDelta({
    baseDir: base,
    mergedDir: merged,
    baseIndex: new Map(),
    cas,
    worldId: "w",
    branchId: "b",
    baseRevision: 1n,
  })
  return { delta, merged }
}

function run(input: Partial<ProjectionValidationInput>): ProjectionValidationInput {
  return {
    plan,
    snapshot,
    world,
    branch,
    currentRevision: 1n,
    delta: buildDelta({ "src/out.txt": "out" }).delta,
    mergedDir: buildDelta({ "src/out.txt": "out" }).merged,
    outcome,
    ...input,
  }
}

describe("AK2-T05 validator 通过路径", () => {
  test("合法 delta + expected output 存在 → ok", () => {
    const { delta, merged } = buildDelta({ "src/out.txt": "generated" })
    const result = validateProjectionCommit(run({ delta, mergedDir: merged }))
    expect(result.ok).toBe(true)
  })
})

describe("AK2-T05 validator 拒绝表（fail-closed）", () => {
  const cases: Array<[string, Partial<ProjectionValidationInput>, import("../../../src/kernel/projection/contracts").ProjectionErrorCode]> = [
    [
      "readonly 路径写入",
      { delta: buildDelta({ "docs/readme.md": "tampered" }).delta },
      "VALIDATION_REJECTED",
    ],
    [
      "writable 之外写入（unexpected）",
      { delta: buildDelta({ "vendor/x.txt": "x" }).delta },
      "VALIDATION_REJECTED",
    ],
    [
      "rename 旧路径在 readonly",
      { delta: buildDelta({ "docs/a.md": "same", "src/b.md": "same" }).delta },
      "VALIDATION_REJECTED",
    ],
    [
      "expected output 缺失",
      { mergedDir: buildDelta({ "src/other.txt": "x" }).merged },
      "VALIDATION_REJECTED",
    ],
    [
      "expected output 是 symlink",
      {
        mergedDir: (() => {
          const { delta, merged } = buildDelta({ "src/out.txt": "x" })
          rmSync(join(merged, "src/out.txt"))
          symlinkSync("other", join(merged, "src/out.txt"))
          return merged
        })(),
      },
      "VALIDATION_REJECTED",
    ],
    [
      "exitCode != 0",
      { outcome: { exitCode: 1, timedOut: false, cancelled: false, violation: false } },
      "EXECUTION_FAILED",
    ],
    [
      "timeout",
      { outcome: { exitCode: 0, timedOut: true, cancelled: false, violation: false } },
      "EXECUTION_FAILED",
    ],
    [
      "cancelled",
      { outcome: { exitCode: 0, timedOut: false, cancelled: true, violation: false } },
      "EXECUTION_CANCELLED",
    ],
    [
      "violation",
      { outcome: { exitCode: 0, timedOut: false, cancelled: false, violation: true } },
      "EXECUTION_FAILED",
    ],
    [
      "stale head（currentRevision != snapshot.revision）",
      { currentRevision: 2n },
      "WORLD_HEAD_MOVED",
    ],
    [
      "snapshot 身份不匹配",
      { snapshot: { ...snapshot, worldId: "other" } },
      "SNAPSHOT_MISMATCH",
    ],
    [
      "world 非 active",
      { world: { ...world, status: "suspended" } },
      "VALIDATION_REJECTED",
    ],
  ]
  test.each(cases)("%s → %s", (_label, partial, code) => {
    try {
      validateProjectionCommit(run(partial))
    } catch (error) {
      expect((error as ProjectionError).code).toBe(code)
      return
    }
    throw new Error(`expected ProjectionError(${code})`)
  })
})
