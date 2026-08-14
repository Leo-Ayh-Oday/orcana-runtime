/**
 * AK2-R6 Correction Gate —— World/CAS 层 R6-00 先红反例冻结。
 *
 * - R6-00-11：同一 raw FileManifest JSON —— A(commit→snapshot→promotion) 与
 *   B(commit→promotion→snapshot) 的 filesystemDigest 与物化 bytes 必须一致
 *   （R6-06：representation 必须是 World revision 的持久事实 —— snapshot
 *   不得从可变 cas.record(...).isManifest 推断）。
 * - R6-00-12：已有 revision snapshot 在 promotion 后再次 createSnapshot →
 *   必须幂等返回 existing，且无新增物理 CAS residue（R6-07：existing 检查
 *   必须在任何 CAS put 之前）。
 * - R6-00-13：合法 namespace + 不存在 contentRef → commit 拒绝，
 *   revision/ledger/CAS record/link/物理对象均不变（R6-07：compareAndCommit
 *   在 delta CAS 物理写入前统一 preflight 引用）。
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canonicalJson } from "../../../src/kernel/world/canonical"
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

describe("AK2-R6 World/CAS 反例（R6-00 先红冻结）", () => {
  test("R6-00-11：同一 raw FileManifest JSON —— commit→snapshot→promotion 与 commit→promotion→snapshot 的 filesystemDigest 与物化 bytes 必须一致", () => {
    // 文件内容 = canonical FileManifest JSON（引用一个真实 chunk）。
    const chunkContent = "hello"
    const build = (worldId: string): { ctx: ReturnType<typeof createTestWorldStore>; rawDigest: import("../../../src/kernel/world/contracts").CasDigest } => {
      const ctx = createTestWorldStore()
      ctx.store.createWorld({ worldId, branchId: "b", rootObjectId: "r", owner: "o", purpose: "p" })
      const chunkDigest = ctx.store.cas.put(Buffer.from(chunkContent, "utf8"), "application/octet-stream").digest
      const jsonBytes = Buffer.from(
        canonicalJson({
          schemaVersion: 1,
          type: "file",
          mediaType: "application/octet-stream",
          size: chunkContent.length,
          chunks: [{ digest: chunkDigest, offset: 0, size: chunkContent.length }],
        }),
        "utf8",
      )
      const rawDigest = ctx.store.cas.put(jsonBytes, "application/octet-stream").digest
      ctx.store.compareAndCommit({
        worldId,
        branchId: "b",
        baseRevision: 0n,
        actor: "a",
        mutations: [
          { type: "object.put", objectId: "f1", objectType: "file", path: "a.json", contentRef: rawDigest },
        ],
      })
      return { ctx, rawDigest }
    }
    const promote = (ctx: ReturnType<typeof createTestWorldStore>, rawDigest: import("../../../src/kernel/world/contracts").CasDigest): void => {
      // promotion：相同 bytes 以 manifest 身份注册（isManifest 翻转）。
      const bytes = ctx.store.cas.get(rawDigest)
      const manifest = JSON.parse(bytes.toString("utf8")) as { chunks: Array<{ digest: import("../../../src/kernel/world/contracts").CasDigest }> }
      ctx.store.cas.putManifest(bytes, manifest.chunks.map(chunk => chunk.digest))
      expect(ctx.store.cas.record(rawDigest)!.isManifest).toBe(true)
    }
    // A：commit → snapshot → promotion。
    const a = build("wA")
    const sA = a.ctx.store.createSnapshot("wA", "b")
    promote(a.ctx, a.rawDigest)
    // B：commit → promotion → snapshot。
    const b = build("wB")
    promote(b.ctx, b.rawDigest)
    const sB = b.ctx.store.createSnapshot("wB", "b")

    // filesystemDigest 与 manifestDigest 必须一致（representation 是 World
    // revision 的持久事实，与 promotion 时序无关）。
    expect(sA.filesystemDigest).toBe(sB.filesystemDigest)
    if (sA.filesystemDigest !== sB.filesystemDigest) {
      throw new Error(
        "R6-00-11 RED: filesystemDigest depends on promotion ordering (snapshot derived representation from mutable cas.record(...).isManifest)",
      )
    }
    expect(sA.manifestDigest).toBe(sB.manifestDigest)
    // 物化 bytes 必须逐字节一致。
    const materialize = (ctx: ReturnType<typeof createTestWorldStore>, snapshotId: string): Buffer => {
      const baseDir = mkdtempSync(join(tmpdir(), "ak2-r6-00-11-"))
      try {
        new SnapshotMaterializer({
          getSnapshot: id => ctx.store.snapshots.get(id),
          getCasRecord: digest => ctx.store.cas.record(digest),
          readCasObject: digest => ctx.store.cas.get(digest),
        }).materialize(snapshotId, baseDir)
        return readFileSync(join(baseDir, "a.json"))
      } finally {
        rmSync(baseDir, { recursive: true, force: true })
      }
    }
    const bytesA = materialize(a.ctx, sA.snapshotId)
    const bytesB = materialize(b.ctx, sB.snapshotId)
    expect(bytesA.equals(bytesB)).toBe(true)
    if (!bytesA.equals(bytesB)) {
      throw new Error("R6-00-11 RED: materialized bytes differ between promotion orderings")
    }
    a.ctx.cleanup()
    b.ctx.cleanup()
  })

  test("R6-00-12：已有 revision snapshot 在 promotion 后再次 createSnapshot → 幂等返回 existing 且无新增物理 CAS residue", () => {
    const ctx = createTestWorldStore()
    ctx.store.createWorld({ worldId: "w-w12", branchId: "b", rootObjectId: "r", owner: "o", purpose: "p" })
    const rawBytes = Buffer.from(
      canonicalJson({ schemaVersion: 1, type: "file", mediaType: "application/octet-stream", size: 0, chunks: [] }),
      "utf8",
    )
    const rawDigest = ctx.store.cas.put(rawBytes, "application/octet-stream").digest
    ctx.store.compareAndCommit({
      worldId: "w-w12",
      branchId: "b",
      baseRevision: 0n,
      actor: "a",
      mutations: [
        { type: "object.put", objectId: "f1", objectType: "file", path: "a.json", contentRef: rawDigest },
      ],
    })
    const s1 = ctx.store.createSnapshot("w-w12", "b")
    const before = physicalObjects(ctx.root).length
    // promotion：相同 bytes 以 manifest 身份注册（isManifest 翻转）。
    ctx.store.cas.putManifest(rawBytes, [])
    expect(ctx.store.cas.record(rawDigest)!.isManifest).toBe(true)
    // 再次 createSnapshot 必须幂等返回 existing，且零新增物理对象。
    let s2: import("../../../src/kernel/world/contracts").WorldSnapshot | undefined
    let s2Error: unknown
    try {
      s2 = ctx.store.createSnapshot("w-w12", "b")
    } catch (error) {
      s2Error = error
    }
    expect(s2Error).toBeUndefined()
    if (s2Error !== undefined) {
      throw new Error(
        "R6-00-12 RED: second createSnapshot after promotion did not return the existing snapshot idempotently (derivation drifted from the durable revision fact)",
      )
    }
    expect(s2!.snapshotId).toBe(s1.snapshotId)
    expect(s2!.filesystemDigest).toBe(s1.filesystemDigest)
    const after = physicalObjects(ctx.root).length
    expect(after).toBe(before)
    if (after !== before) {
      throw new Error(`R6-00-12 RED: second createSnapshot left ${after - before} new physical CAS object(s) (manifests written before the existing-snapshot check)`)
    }
    ctx.cleanup()
  })

  test("R6-00-13：合法 namespace + 不存在 contentRef → commit 拒绝；revision/ledger/CAS record/link/物理对象均不变", () => {
    const ctx = createTestWorldStore()
    ctx.store.createWorld({ worldId: "w13", branchId: "b", rootObjectId: "r", owner: "o", purpose: "p" })
    const missingRef = `sha256:${"ab".repeat(32)}` as import("../../../src/kernel/world/contracts").CasDigest
    const beforePhysical = physicalObjects(ctx.root).length
    const beforeCas = ctx.store.cas.list().length
    const beforeLinks = ctx.store.cas.list().reduce((sum, record) => sum + record.refCount, 0)
    const beforeEvents = ctx.store.ledger.list("w13").length
    let commitError: unknown
    try {
      ctx.store.compareAndCommit({
        worldId: "w13",
        branchId: "b",
        baseRevision: 0n,
        actor: "a",
        mutations: [
          { type: "object.put", objectId: "f1", objectType: "file", path: "a.txt", contentRef: missingRef },
        ],
      })
    } catch (error) {
      commitError = error
    }
    expect(commitError).toBeDefined()
    if (commitError === undefined) {
      throw new Error("R6-00-13 RED: commit with a missing contentRef succeeded")
    }
    expect((commitError as Error & { code?: string }).code).toBe("CAS_INTEGRITY_ERROR")
    // revision/ledger/CAS record/link/物理对象均不变。
    expect(ctx.store.getWorld("w13")!.currentRevision).toBe(0n)
    expect(ctx.store.getBranch("w13", "b")!.headRevision).toBe(0n)
    expect(ctx.store.ledger.list("w13").length).toBe(beforeEvents)
    expect(ctx.store.cas.list().length).toBe(beforeCas)
    expect(ctx.store.cas.list().reduce((sum, record) => sum + record.refCount, 0)).toBe(beforeLinks)
    const afterPhysical = physicalObjects(ctx.root).length
    expect(afterPhysical).toBe(beforePhysical)
    if (afterPhysical !== beforePhysical) {
      throw new Error(`R6-00-13 RED: failed commit left ${afterPhysical - beforePhysical} physical CAS residue (contentRef validated only after delta CAS write)`)
    }
    ctx.cleanup()
  })
})