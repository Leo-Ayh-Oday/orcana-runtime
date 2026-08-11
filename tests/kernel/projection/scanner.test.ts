/** AK2-T04 — Deterministic Delta Scanner 测试。 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectionError } from "../../../src/kernel/projection/contracts"
import {
  scanProjectionDelta,
  type ProjectionScanInput,
} from "../../../src/kernel/projection/scanner"
import type { MaterializedSectionEntry } from "../../../src/kernel/projection/materializer"
import type { CasDigest } from "../../../src/kernel/world"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ak2-scan-${label}-`))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 内存 CAS（确定性 digest，put 可禁用模拟缺失）。 */
class MemCas {
  readonly objects = new Map<string, Buffer>()
  failPuts = false
  put(content: Uint8Array, _mediaType = "application/octet-stream") {
    if (this.failPuts) throw new Error("CAS put denied")
    const bytes = Buffer.from(content)
    const digest = `sha256:${hash(bytes)}` as CasDigest
    if (!this.objects.has(digest)) this.objects.set(digest, bytes)
    return { digest, size: bytes.byteLength, mediaType: "", mediaTypes: [], isManifest: false, createdAt: 0, refCount: 0 }
  }
  has(digest: CasDigest): boolean {
    return this.objects.has(digest)
  }
}

import { createHash } from "node:crypto"
function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

interface ScanHarness {
  readonly base: string
  readonly merged: string
  readonly cas: MemCas
  readonly baseIndex: Map<string, MaterializedSectionEntry>
  scan(): ReturnType<typeof scanProjectionDelta>
}

function harness(worldId = "w", branchId = "b", baseRevision = 1n): ScanHarness {
  const root = tmpRoot("h")
  const base = join(root, "base")
  const merged = join(root, "merged")
  mkdirSync(base)
  mkdirSync(merged)
  const cas = new MemCas()
  const baseIndex = new Map<string, MaterializedSectionEntry>()
  const scan = (): ReturnType<typeof scanProjectionDelta> =>
    scanProjectionDelta({
      baseDir: base,
      mergedDir: merged,
      baseIndex,
      cas,
      worldId,
      branchId,
      baseRevision,
    })
  return { base, merged, cas, baseIndex, scan }
}

function buildBase(h: ScanHarness, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(h.base, ...rel.split("/"))
    mkdirSync(join(h.base, ...rel.split("/").slice(0, -1)), { recursive: true })
    writeFileSync(full, content, "utf8")
    h.baseIndex.set(rel, { id: `obj-${rel.replace(/\//g, "-")}`, kind: "file", contentRef: h.cas.put(Buffer.from(content, "utf8"), "text/plain").digest })
  }
}

describe("AK2-T04 create/write/delete", () => {
  test("create + write + delete 组合", () => {
    const h = harness()
    buildBase(h, { "keep.txt": "same", "gone.txt": "bye", "changed.txt": "v1" })
    const { scan } = h
    writeFileSync(join(h.merged, "keep.txt"), "same")
    writeFileSync(join(h.merged, "new.txt"), "hello")
    writeFileSync(join(h.merged, "changed.txt"), "v2")

    const result = scan()
    expect(result.entries).toContainEqual({ kind: "create", path: "new.txt", objectId: expect.stringMatching(/^obj:file:/), objectType: "file", contentRef: expect.stringMatching(/^sha256:/) })
    expect(result.entries).toContainEqual({ kind: "delete", path: "gone.txt", objectId: "obj-gone.txt", objectType: "file" })
    expect(result.entries).toContainEqual({ kind: "write", path: "changed.txt", objectId: "obj-changed.txt", contentRef: expect.stringMatching(/^sha256:/) })
    expect(result.entries.filter(e => e.kind === "write")).toHaveLength(1)
    // 所有 mutations 的 contentRef 都在 CAS 中（DELTA_WITHOUT_CAS=0）。
    for (const mutation of result.mutations) {
      if ("contentRef" in mutation && mutation.contentRef) {
        expect(h.cas.has(mutation.contentRef)).toBe(true)
      }
    }
  })

  test("empty file create", () => {
    const h = harness()
    writeFileSync(join(h.merged, "empty.txt"), "")
    const result = h.scan()
    const create = result.entries.find(e => e.kind === "create")!
    expect(create).toMatchObject({ path: "empty.txt", objectType: "file" })
    expect((create as { contentRef?: string }).contentRef).toMatch(/^sha256:/)
  })

  test("binary file write", () => {
    const h = harness()
    buildBase(h, { "bin.dat": "old" })
    const bytes = Buffer.from([0, 1, 2, 255, 254, 0, 128])
    writeFileSync(join(h.merged, "bin.dat"), bytes)
    const result = h.scan()
    const write = result.entries.find(e => e.kind === "write")!
    expect(write).toMatchObject({ path: "bin.dat", objectId: "obj-bin.dat" })
  })

  test("nested directory create/delete", () => {
    const h = harness()
    buildBase(h, { "a/b/c.txt": "x" })
    mkdirSync(join(h.merged, "a/b"), { recursive: true })
    writeFileSync(join(h.merged, "a/b/c.txt"), "x")
    // merged 多一层新目录。
    mkdirSync(join(h.merged, "a/newdir"), { recursive: true })
    writeFileSync(join(h.merged, "a/newdir/d.txt"), "d")
    const result = h.scan()
    expect(result.entries).toContainEqual(expect.objectContaining({ kind: "create", path: "a/newdir", objectType: "directory" }))
    expect(result.entries).toContainEqual(expect.objectContaining({ kind: "create", path: "a/newdir/d.txt", objectType: "file" }))
    // 删除目录。
    const h2 = harness()
    buildBase(h2, { "del/dir/f.txt": "f", "del/dir/g.txt": "g" })
    const result2 = h2.scan()
    // merged 为空 → 全部删除。
    expect(result2.entries).toContainEqual(expect.objectContaining({ kind: "delete", path: "del/dir/f.txt", objectType: "file" }))
    expect(result2.entries).toContainEqual(expect.objectContaining({ kind: "delete", path: "del/dir/g.txt", objectType: "file" }))
    expect(result2.entries).toContainEqual(expect.objectContaining({ kind: "delete", path: "del/dir", objectType: "directory" }))
  })
})

describe("AK2-T04 rename 推断", () => {
  test("unique rename：deleted 与 created 唯一同 digest pair → rename", () => {
    const h = harness()
    buildBase(h, { "old.txt": "content" })
    const digest = h.baseIndex.get("old.txt")!.contentRef!
    writeFileSync(join(h.merged, "new.txt"), "content")
    const result = h.scan()
    expect(result.entries).toContainEqual({ kind: "rename", oldPath: "old.txt", newPath: "new.txt", objectId: "obj-old.txt", contentRef: digest })
    expect(result.entries.filter(e => e.kind === "delete" || e.kind === "create")).toHaveLength(0)
    // mutation 保留 object identity + 新 path。
    expect(result.mutations).toEqual([
      expect.objectContaining({ type: "object.put", objectId: "obj-old.txt", path: "new.txt", contentRef: digest }),
    ])
  })

  test("ambiguous rename：deleted 侧同 digest 多个 → delete+create", () => {
    const h = harness()
    buildBase(h, { "a1.txt": "same", "a2.txt": "same" })
    writeFileSync(join(h.merged, "b1.txt"), "same")
    writeFileSync(join(h.merged, "b2.txt"), "same")
    const result = h.scan()
    expect(result.entries.filter(e => e.kind === "rename")).toHaveLength(0)
    expect(result.entries.filter(e => e.kind === "delete")).toHaveLength(2)
    expect(result.entries.filter(e => e.kind === "create")).toHaveLength(2)
  })

  test("ambiguous rename：created 侧同 digest 多个 → delete+create", () => {
    const h = harness()
    buildBase(h, { "a1.txt": "same" })
    writeFileSync(join(h.merged, "b1.txt"), "same")
    writeFileSync(join(h.merged, "b2.txt"), "same")
    const result = h.scan()
    expect(result.entries.filter(e => e.kind === "rename")).toHaveLength(0)
  })

  test("rename + 新内容写入同时发生（非唯一 pair 不推断）", () => {
    const h = harness()
    buildBase(h, { "old.txt": "content" })
    writeFileSync(join(h.merged, "new.txt"), "content")
    writeFileSync(join(h.merged, "extra.txt"), "brand-new")
    const result = h.scan()
    expect(result.entries).toContainEqual(expect.objectContaining({ kind: "rename", oldPath: "old.txt", newPath: "new.txt" }))
    expect(result.entries).toContainEqual(expect.objectContaining({ kind: "create", path: "extra.txt" }))
  })
})

describe("AK2-T04 确定性", () => {
  test("同一输入两次扫描：entries/mutations/digest 完全一致", () => {
    const h = harness()
    buildBase(h, { "a.txt": "1", "b/c.txt": "2" })
    writeFileSync(join(h.merged, "a.txt"), "1")
    mkdirSync(join(h.merged, "b"), { recursive: true })
    writeFileSync(join(h.merged, "b/c.txt"), "2")
    writeFileSync(join(h.merged, "d.txt"), "new")
    const first = h.scan()
    const second = h.scan()
    expect(second.deltaDigest).toBe(first.deltaDigest)
    expect(second.entries).toEqual(first.entries)
    expect(second.mutations).toEqual(first.mutations)
  })

  test("deltaDigest 与 store 的 canonical world-delta 编码一致", () => {
    const h = harness()
    buildBase(h, { "old.txt": "content" })
    writeFileSync(join(h.merged, "new.txt"), "content")
    const result = h.scan()
    const { canonicalJson, sha256Digest } = require("../../../src/kernel/world/canonical") as typeof import("../../../src/kernel/world/canonical")
    const expected = sha256Digest(
      Buffer.from(
        canonicalJson({
          schemaVersion: 1,
          type: "world-delta",
          worldId: "w",
          branchId: "b",
          baseRevision: "1",
          mutations: result.mutations,
        }),
        "utf8",
      ),
    )
    expect(result.deltaDigest).toBe(expected)
  })

  test("object identity preservation：write 保留 base objectId", () => {
    const h = harness()
    buildBase(h, { "app.ts": "v1" })
    writeFileSync(join(h.merged, "app.ts"), "v2")
    const result = h.scan()
    const write = result.entries.find(e => e.kind === "write")!
    expect((write as { objectId: string }).objectId).toBe("obj-app.ts")
  })
})

describe("AK2-T04 故障", () => {
  test("symlink 出现在 merged → 拒绝", () => {
    const h = harness()
    writeFileSync(join(h.merged, "real.txt"), "x")
    symlinkSync("real.txt", join(h.merged, "link.txt"))
    try {
      h.scan()
      throw new Error("expected DELTA_SCAN_FAILED")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("DELTA_SCAN_FAILED")
    }
  })

  test("symlink 出现在 base → 拒绝", () => {
    const h = harness()
    writeFileSync(join(h.base, "real.txt"), "x")
    symlinkSync("real.txt", join(h.base, "link.txt"))
    try {
      h.scan()
      throw new Error("expected DELTA_SCAN_FAILED")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("DELTA_SCAN_FAILED")
    }
  })

  test("FIFO 出现在 merged → 拒绝", () => {
    const h = harness()
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process")
    try {
      execFileSync("mkfifo", [join(h.merged, "pipe")])
    } catch {
      return // 平台不支持则跳过（Linux 支持）
    }
    try {
      h.scan()
      throw new Error("expected DELTA_SCAN_FAILED")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("DELTA_SCAN_FAILED")
    }
  })

  test("content CAS 缺失（put 拒绝）→ 拒绝", () => {
    const h = harness()
    writeFileSync(join(h.merged, "new.txt"), "content")
    h.cas.failPuts = true
    try {
      h.scan()
      throw new Error("expected failure")
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
    }
  })

  test("空 delta（无任何变化）→ 拒绝", () => {
    const h = harness()
    try {
      h.scan()
      throw new Error("expected DELTA_SCAN_FAILED")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("DELTA_SCAN_FAILED")
    }
  })
})
