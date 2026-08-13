/**
 * AK2-R5 Correction Gate —— World/CAS 层 R5-00 先红反例冻结。
 *
 * - R5-00-10：raw bytes 恰为合法 FileManifest JSON 时，snapshot 物化必须
 *   逐字节一致（R5-07：不得通过全局可变 isManifest 推断文件语义；
 *   NONDETERMINISTIC_SNAPSHOT = 0 / MUTABLE_CONTENT_INTERPRETATION = 0）。
 * - R5-00-11：invalid final namespace 被拒绝后不得留下 CAS file-only
 *   residue（R5-08：final namespace validation 必须在 delta CAS 物理写入前）。
 * - R5-00-12：maxFileChunks 超限的 manifest 必须在第二份数组分配/逐项
 *   normalize/打开目标文件前拒绝（R5-08）。
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canonicalJson } from "../../../src/kernel/world/canonical"
import { createFileManifest } from "../../../src/kernel/world/manifests"
import { DEFAULT_PROJECTION_LIMITS, ProjectionError } from "../../../src/kernel/projection/contracts"
import { SnapshotMaterializer } from "../../../src/kernel/projection/materializer"
import { createTestWorldStore } from "./helpers"

/** 物理 CAS 对象文件清单（root/cas/sha256/<prefix>/<hex>）。 */
function physicalObjects(root: string): string[] {
  const out: string[] = []
  const prefixDir = join(root, "cas", "sha256")
  for (const prefix of readdirSync(prefixDir)) {
    for (const file of readdirSync(join(prefixDir, prefix))) {
      out.push(`${prefix}/${file}`)
    }
  }
  return out.sort()
}

describe("AK2-R5 World/CAS 反例（R5-00 先红冻结）", () => {
  test("R5-00-10：raw bytes 恰为合法 FileManifest JSON → snapshot 物化必须逐字节一致（promotion/GC/recovery 后亦然）", () => {
    const ctx = createTestWorldStore()
    ctx.store.createWorld({ worldId: "w10", branchId: "b", rootObjectId: "r", owner: "o", purpose: "p" })
    // raw bytes 恰好是 canonical 的 FileManifest JSON（size 0 / chunks []）。
    const rawBytes = Buffer.from(
      canonicalJson({ schemaVersion: 1, type: "file", mediaType: "application/octet-stream", size: 0, chunks: [] }),
      "utf8",
    )
    const rawDigest = ctx.store.cas.put(rawBytes, "application/octet-stream").digest
    ctx.store.compareAndCommit({
      worldId: "w10",
      branchId: "b",
      baseRevision: 0n,
      actor: "a",
      mutations: [
        { type: "object.put", objectId: "f1", objectType: "file", path: "manifest.json", contentRef: rawDigest },
      ],
    })
    ctx.store.createSnapshot("w10", "b")
    const snapshot = ctx.store.snapshots.getForRevision("w10", "b", 1n)!
    const materialize = (baseDir: string): void => {
      new SnapshotMaterializer({
        getSnapshot: id => ctx.store.snapshots.get(id),
        getCasRecord: digest => ctx.store.cas.record(digest),
        readCasObject: digest => ctx.store.cas.get(digest),
      }).materialize(snapshot.snapshotId, baseDir)
    }
    const baseOf = (label: string): string => {
      const dir = mkdtempSync(join(tmpdir(), `ak2-r5-${label}-`))
      return dir
    }
    // 第一次物化：raw bytes。
    const base1 = baseOf("raw1")
    materialize(base1)
    expect(readFileSync(join(base1, "manifest.json"))).toEqual(rawBytes)
    // promotion：相同 digest 调用 putManifest（全局 isManifest 翻转）。
    ctx.store.cas.putManifest(rawBytes, [])
    expect(ctx.store.cas.record(rawDigest)!.isManifest).toBe(true)
    // 原 snapshot 再次物化必须逐字节一致 —— RED at baseline（materializer
    // 按 isManifest 双重解释 → 0 字节文件）。
    const base2 = baseOf("raw2")
    materialize(base2)
    const second = readFileSync(join(base2, "manifest.json"))
    expect(second).toEqual(rawBytes)
    if (!second.equals(rawBytes)) {
      throw new Error(
        "R5-00-10 RED: re-materialization after manifest promotion reinterpreted raw bytes via the mutable isManifest flag (NONDETERMINISTIC_SNAPSHOT)",
      )
    }
    // GC + recovery 后仍必须逐字节一致。
    ctx.store.cas.gc()
    ctx.store.cas.recover()
    const base3 = baseOf("raw3")
    materialize(base3)
    expect(readFileSync(join(base3, "manifest.json"))).toEqual(rawBytes)
    for (const dir of [base1, base2, base3]) rmSync(dir, { recursive: true, force: true })
    ctx.cleanup()
  })

  test("R5-00-11：invalid final namespace 拒绝后 revision/ledger 不变、无 CAS record、无 owner link、无物理 CAS/staging residue", () => {
    const ctx = createTestWorldStore()
    ctx.store.createWorld({ worldId: "w11", branchId: "b", rootObjectId: "r", owner: "o", purpose: "p" })
    const d1 = ctx.store.cas.put(Buffer.from("a\n", "utf8"), "text/plain").digest
    ctx.store.compareAndCommit({
      worldId: "w11",
      branchId: "b",
      baseRevision: 0n,
      actor: "a",
      mutations: [
        { type: "object.put", objectId: "src", objectType: "directory", path: "src" },
        { type: "object.put", objectId: "a", objectType: "file", path: "src/a.ts", contentRef: d1 },
      ],
    })
    const beforePhysical = physicalObjects(ctx.root)
    const beforeRecords = ctx.store.cas.list().map(record => record.digest).sort()
    const commitId = "commit-invalid-r5"
    let commitError: unknown
    try {
      ctx.store.compareAndCommit({
        worldId: "w11",
        branchId: "b",
        baseRevision: 1n,
        actor: "a",
        commitId,
        mutations: [
          // 既有 FILE "src/a.ts" 下声明 directory —— final state 非 directory 祖先。
          { type: "object.put", objectId: "bad", objectType: "directory", path: "src/a.ts/sub" },
        ],
      })
    } catch (error) {
      commitError = error
    }
    expect(commitError).toBeDefined()
    // revision / ledger / commit row 不变。
    expect(ctx.store.getWorld("w11")!.currentRevision).toBe(1n)
    expect(ctx.store.getCommit(commitId)).toBeUndefined()
    // 无新 CAS record。
    expect(ctx.store.cas.list().map(record => record.digest).sort()).toEqual(beforeRecords)
    // 无物理 CAS file / staging residue —— RED at baseline（delta 文件残留）。
    expect(physicalObjects(ctx.root)).toEqual(beforePhysical)
    if (physicalObjects(ctx.root).join(",") !== beforePhysical.join(",")) {
      throw new Error(
        "R5-00-11 RED: invalid namespace commit left a physical CAS file-only residue (validation must precede delta CAS write)",
      )
    }
    expect(readdirSync(join(ctx.root, "recovery", "cas-staging")).length).toBe(0)
    // integrity 干净（无 unreachable/file-only 泄漏）。
    expect(ctx.store.verifyIntegrity()).toEqual([])
    ctx.cleanup()
  })

  test("R5-00-12：maxFileChunks 超限 manifest 必须在第二份数组分配/逐项 normalize/打开目标文件前拒绝", () => {
    const ctx = createTestWorldStore()
    ctx.store.createWorld({ worldId: "w12", branchId: "b", rootObjectId: "r", owner: "o", purpose: "p" })
    // 5000 chunks（> maxFileChunks 4096），logical size 5000 bytes。
    const content = Buffer.alloc(5000, 0x61)
    const fm = createFileManifest(ctx.store.cas, content, "text/plain", 1)
    expect(fm.manifest.chunks.length).toBeGreaterThan(DEFAULT_PROJECTION_LIMITS.maxFileChunks)
    ctx.store.compareAndCommit({
      worldId: "w12",
      branchId: "b",
      baseRevision: 0n,
      actor: "a",
      mutations: [
        { type: "object.put", objectId: "big", objectType: "file", path: "big.bin", contentRef: fm.digest },
      ],
    })
    ctx.store.createSnapshot("w12", "b")
    const snapshot = ctx.store.snapshots.getForRevision("w12", "b", 1n)!
    const chunkDigests = new Set(fm.manifest.chunks.map(chunk => chunk.digest))
    const reads: string[] = []
    const materializer = new SnapshotMaterializer({
      getSnapshot: id => ctx.store.snapshots.get(id),
      getCasRecord: digest => ctx.store.cas.record(digest),
      readCasObject: digest => {
        reads.push(digest)
        return ctx.store.cas.get(digest)
      },
    })
    const base = mkdtempSync(join(tmpdir(), "ak2-r5-chunks-"))
    let mError: unknown
    try {
      materializer.materialize(snapshot.snapshotId, base)
    } catch (error) {
      mError = error
    }
    expect(mError).toBeDefined()
    expect((mError as ProjectionError).code).toBe("PROJECTION_RESOURCE_LIMIT")
    // 目标文件不得被创建 —— RED at baseline（count 检查在 open 之后 → 空文件残留）。
    expect(existsSync(join(base, "big.bin"))).toBe(false)
    if (existsSync(join(base, "big.bin"))) {
      throw new Error(
        "R5-00-12 RED: maxFileChunks rejection happened after the target file was opened (file residue); chunk count must be checked before open/normalize",
      )
    }
    // 没有任何 chunk 被读取（也没有 chunk CAS put —— materializer 不写 CAS）。
    expect(reads.some(digest => chunkDigests.has(digest))).toBe(false)
    rmSync(base, { recursive: true, force: true })
    ctx.cleanup()
  })
})
