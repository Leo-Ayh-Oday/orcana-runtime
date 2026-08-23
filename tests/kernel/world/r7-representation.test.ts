/**
 * AK2-R7 Correction Gate —— World/CAS 层 R7-00 先红反例冻结。
 *
 * - R7-00-10: legacy file commit（无 representation）→ CAS manifest
 *   promotion → verify/reopen 不得产生 LEDGER_DB_DIVERGENCE（replay 不得
 *   再次读取可变 CAS.isManifest；ledger 必须携带 commit 时一次性解析的
 *   representation）。
 * - R7-00-11: raw JSON 使用显式 representation:"file-manifest" 提交必须在
 *   delta CAS 写入前拒绝（未 attest 的 CAS record 不构成 file-manifest）。
 * - R7-00-12: directory manifest 冒充 FileManifest 必须拒绝（type 必须为
 *   "file" 且 canonical schema 一致）。
 * - R7-00-13: 合法 FileManifest 经 GC/recovery 后 chunks 仍可达并可物化；
 *   未 attest 的 raw 提交必须被 preflight 拒绝（否则 GC 会收集 chunks）。
 * - R7-00-14: existing snapshot 的任一 manifest bytes/link 缺失时再次
 *   createSnapshot 必须 fail-closed（不得静默返回损坏 snapshot；不得留下
 *   新 CAS residue）。
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

/** canonical FileManifest JSON（引用一个真实 chunk）。 */
function fileManifestBytes(chunkDigest: string, size = 5): Buffer {
  return Buffer.from(
    canonicalJson({
      schemaVersion: 1,
      type: "file",
      mediaType: "application/octet-stream",
      size,
      chunks: [{ digest: chunkDigest, offset: 0, size }],
    }),
    "utf8",
  )
}

function materialize(ctx: ReturnType<typeof createTestWorldStore>, snapshotId: string, fileName: string): Buffer {
  const baseDir = mkdtempSync(join(tmpdir(), "ak2-r7-mat-"))
  try {
    new SnapshotMaterializer({
      getSnapshot: id => ctx.store.snapshots.get(id),
      getCasRecord: digest => ctx.store.cas.record(digest),
      readCasObject: digest => ctx.store.cas.get(digest),
    }).materialize(snapshotId, baseDir)
    return readFileSync(join(baseDir, fileName))
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
}

describe("AK2-R7 World/CAS 反例（R7-00 先红冻结）", () => {
  test("R7-00-10：legacy file commit → CAS manifest promotion → verify/reopen 不得产生 LEDGER_DB_DIVERGENCE", () => {
    const ctx = createTestWorldStore()
    ctx.store.createWorld({ worldId: "w10", branchId: "b", rootObjectId: "r", owner: "o", purpose: "p" })
    const chunkDigest = ctx.store.cas.put(Buffer.from("hello"), "application/octet-stream").digest
    const bytes = fileManifestBytes(chunkDigest)
    // legacy 提交：raw bytes、无显式 representation（commit 时按 CAS 事实
    // 一次性解析并持久化）。
    const rawDigest = ctx.store.cas.put(bytes, "application/octet-stream").digest
    ctx.store.compareAndCommit({
      worldId: "w10",
      branchId: "b",
      baseRevision: 0n,
      actor: "a",
      mutations: [{ type: "object.put", objectId: "f1", objectType: "file", path: "a.json", contentRef: rawDigest }],
    })
    // promotion：相同 bytes 以 manifest 身份注册（isManifest 翻转）——
    // 已提交 revision 的 representation 事实不得改变。
    ctx.store.cas.putManifest(bytes, [chunkDigest])
    const issues = ctx.store.verifyIntegrity()
    const divergence = issues.filter((issue: { code: string }) => issue.code === "LEDGER_DB_DIVERGENCE")
    expect(divergence).toEqual([])
    if (divergence.length > 0) {
      throw new Error(`R7-00-10 RED: legacy commit followed by promotion produced ${divergence.length} LEDGER_DB_DIVERGENCE (ledger replay re-derived representation from mutable cas.record().isManifest)`)
    }
    // reopen（同一持久 root）后 verify 也必须一致。
    const reopened = createTestWorldStore({ root: ctx.root })
    try {
      const reopenIssues = reopened.store.verifyIntegrity()
      const reopenDivergence = reopenIssues.filter((issue: { code: string }) => issue.code === "LEDGER_DB_DIVERGENCE")
      expect(reopenDivergence).toEqual([])
      if (reopenDivergence.length > 0) {
        throw new Error(`R7-00-10 RED: reopened store reports ${reopenDivergence.length} LEDGER_DB_DIVERGENCE after legacy commit + promotion`)
      }
      const object = reopened.store.listObjects("w10", "b")[0] as { representation?: string }
      // 持久事实：legacy 提交时刻 CAS 为 raw → representation 必须为 "raw"。
      expect(object.representation).toBe("raw")
      if (object.representation !== "raw") {
        throw new Error(`R7-00-10 RED: reopened representation ${object.representation} drifted from the commit-time fact ("raw")`)
      }
    } finally {
      reopened.cleanup()
    }
    ctx.cleanup()
  })

  test("R7-00-11：raw JSON 以显式 representation:'file-manifest' 提交 → delta CAS 写入前拒绝", () => {
    const ctx = createTestWorldStore()
    ctx.store.createWorld({ worldId: "w11", branchId: "b", rootObjectId: "r", owner: "o", purpose: "p" })
    const chunkDigest = ctx.store.cas.put(Buffer.from("hello"), "application/octet-stream").digest
    // raw put（未 attest —— 无 manifest 身份、无 reference links）。
    const rawDigest = ctx.store.cas.put(fileManifestBytes(chunkDigest), "application/octet-stream").digest
    const before = physicalObjects(ctx.root).length
    let error: unknown
    try {
      ctx.store.compareAndCommit({
        worldId: "w11",
        branchId: "b",
        baseRevision: 0n,
        actor: "a",
        mutations: [
          { type: "object.put", objectId: "f1", objectType: "file", path: "a.json", contentRef: rawDigest, representation: "file-manifest" },
        ],
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeDefined()
    if (error === undefined) {
      throw new Error("R7-00-11 RED: raw JSON committed with explicit representation:'file-manifest' without manifest attestation (must be rejected before the delta CAS write)")
    }
    // World 未推进；delta CAS 物理写入前拒绝 → 零新增物理对象。
    expect(ctx.store.getWorld("w11")!.currentRevision).toBe(0n)
    const after = physicalObjects(ctx.root).length
    expect(after).toBe(before)
    if (after !== before) {
      throw new Error(`R7-00-11 RED: ${after - before} new physical CAS object(s) after the rejected commit (rejection happened after delta CAS write)`)
    }
    ctx.cleanup()
  })

  test("R7-00-12：directory manifest 冒充 FileManifest 必须拒绝", () => {
    const ctx = createTestWorldStore()
    ctx.store.createWorld({ worldId: "w12", branchId: "b", rootObjectId: "r", owner: "o", purpose: "p" })
    const dirManifestBytes = Buffer.from(canonicalJson({ schemaVersion: 1, type: "directory", entries: [] }), "utf8")
    // 以 manifest 身份 attest（putManifest）—— 但 type 是 directory。
    const dirDigest = ctx.store.cas.putManifest(dirManifestBytes, []).digest
    let error: unknown
    try {
      ctx.store.compareAndCommit({
        worldId: "w12",
        branchId: "b",
        baseRevision: 0n,
        actor: "a",
        mutations: [
          { type: "object.put", objectId: "f1", objectType: "file", path: "d.json", contentRef: dirDigest, representation: "file-manifest" },
        ],
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeDefined()
    if (error === undefined) {
      throw new Error("R7-00-12 RED: a directory manifest was accepted as a file object's file-manifest content (canonical schema type must be 'file')")
    }
    expect(ctx.store.getWorld("w12")!.currentRevision).toBe(0n)
    ctx.cleanup()
  })

  test("R7-00-13：合法 FileManifest 经 GC/recovery 后 chunks 仍可达并可物化；未 attest 的 raw 提交必须被拒绝", () => {
    const ctx = createTestWorldStore()
    ctx.store.createWorld({ worldId: "w13", branchId: "b", rootObjectId: "r", owner: "o", purpose: "p" })
    const chunkDigest = ctx.store.cas.put(Buffer.from("hello"), "application/octet-stream").digest
    const bytes = fileManifestBytes(chunkDigest)
    // 1. raw（未 attest）提交尝试 —— R7-05 preflight 必须拒绝。
    const rawDigest = ctx.store.cas.put(bytes, "application/octet-stream").digest
    let rawCommitted = false
    try {
      ctx.store.compareAndCommit({
        worldId: "w13",
        branchId: "b",
        baseRevision: 0n,
        actor: "a",
        mutations: [
          { type: "object.put", objectId: "f1", objectType: "file", path: "a.json", contentRef: rawDigest, representation: "file-manifest" },
        ],
      })
      rawCommitted = true
    } catch {
      // 期望：preflight 拒绝。
    }
    if (rawCommitted) {
      // 基线缺陷路径：commit 被接受 —— 之后 GC 必须仍保留 chunks 且
      // 物化必须成功（当前 GC 收集了未链接的 chunks → RED）。
      const orphan = ctx.store.cas.put(Buffer.from("zzz"), "application/octet-stream").digest
      ctx.store.cas.gc()
      ctx.store.cas.recover()
      const chunkAlive = (() => {
        try {
          ctx.store.cas.get(chunkDigest)
          return true
        } catch {
          return false
        }
      })()
      expect(chunkAlive).toBe(true)
      if (!chunkAlive) {
        throw new Error("R7-00-13 RED: GC/recovery collected chunks of a committed file-manifest object (manifest references were not linked into CAS reachability)")
      }
      ctx.store.createSnapshot("w13", "b")
      const snap = ctx.store.snapshots.getForRevision("w13", "b", 1n)!
      const bytesOut = materialize(ctx, snap.snapshotId, "a.json")
      expect(bytesOut.equals(bytes)).toBe(true)
      if (!bytesOut.equals(bytes)) {
        throw new Error("R7-00-13 RED: materialized file-manifest bytes diverged after GC/recovery")
      }
    }
    // 2. 合法路径：putManifest attest → 显式 file-manifest 提交 → GC/
    // recovery 后 chunks 仍可达并可物化。
    ctx.store.cas.putManifest(bytes, [chunkDigest])
    const manifestDigest = ctx.store.cas.record(rawDigest)!.digest
    ctx.store.compareAndCommit({
      worldId: "w13",
      branchId: "b",
      baseRevision: rawCommitted ? 1n : 0n,
      actor: "a",
      mutations: [
        { type: "object.put", objectId: "f2", objectType: "file", path: "b.json", contentRef: manifestDigest, representation: "file-manifest" },
      ],
    })
    ctx.store.createSnapshot("w13", "b")
    const snapshot = ctx.store.snapshots.getForRevision("w13", "b", rawCommitted ? 2n : 1n)!
    ctx.store.cas.gc()
    ctx.store.cas.recover()
    const chunkStillAlive = (() => {
      try {
        ctx.store.cas.get(chunkDigest)
        return true
      } catch {
        return false
      }
    })()
    expect(chunkStillAlive).toBe(true)
    if (!chunkStillAlive) {
      throw new Error("R7-00-13 RED: GC/recovery collected chunks of an attested file-manifest object (chunks must stay reachable and materializable)")
    }
    const materialized = materialize(ctx, snapshot.snapshotId, "b.json")
    // R7-05 调和（记录于 evidence；独立审计复核项）：representation:
    // "file-manifest" 的物化语义是 manifest 的**逻辑内容**（chunk 重组）——
    // 与 materializer.test.ts R04 锁定的语义一致（否则执行工作区会出现
    // manifest JSON 而非文件内容）。本反例的攻击目标不变：(a) 未 attest
    // 的 raw-as-file-manifest 在 delta CAS 写入前被拒绝；(b) chunks 经
    // GC/recovery 后仍可达；(c) 恢复后可完整物化。期望值从存储字节
    // （manifest JSON）修正为逻辑内容。
    const logicalContent = Buffer.from("hello", "utf8")
    expect(materialized.equals(logicalContent)).toBe(true)
    if (!materialized.equals(logicalContent)) {
      throw new Error(`R7-00-13 RED: materialized attested file-manifest content diverged after GC/recovery (got ${materialized.byteLength} byte(s), expected logical content ${logicalContent.byteLength} byte(s))`)
    }
    ctx.cleanup()
  })

  test("R7-00-14：existing snapshot 的 manifest bytes/link 缺失 → 再次 createSnapshot 必须 fail-closed", () => {
    const ctx = createTestWorldStore()
    ctx.store.createWorld({ worldId: "w14", branchId: "b", rootObjectId: "r", owner: "o", purpose: "p" })
    const digest = ctx.store.cas.put(Buffer.from("x\n"), "text/plain").digest
    ctx.store.compareAndCommit({
      worldId: "w14",
      branchId: "b",
      baseRevision: 0n,
      actor: "a",
      mutations: [{ type: "object.put", objectId: "f1", objectType: "file", path: "a.txt", contentRef: digest }],
    })
    const s1 = ctx.store.createSnapshot("w14", "b")
    // 删除 filesystem section manifest 的物理对象（bytes 缺失）。
    const fsPath = ctx.store.cas.resolveObjectPath(s1.filesystemDigest)
    rmSync(fsPath, { force: true })
    // R7-05 调和（记录于 evidence；独立审计复核项）：residue 基线在**人为
    // 删除之后**捕获 —— 即第二次 createSnapshot 的真实入口状态。原冻结版
    // 本在删除前捕获，导致任何零写入 fail-closed 实现在算术上都无法满足
    // after===before（删除本身使计数 -1）。两条断言全部保留：(a) 必须
    // 抛错；(b) 拒绝路径零新增物理 CAS 对象。
    const before = physicalObjects(ctx.root).length
    let error: unknown
    let again: unknown
    try {
      again = ctx.store.createSnapshot("w14", "b")
    } catch (caught) {
      error = caught
    }
    expect(error).toBeDefined()
    if (error === undefined) {
      const snap = again as { snapshotId?: string }
      throw new Error(`R7-00-14 RED: createSnapshot silently returned the existing snapshot ${snap.snapshotId} although a section manifest object is missing (corrupt existing snapshot returned without attestation)`)
    }
    // fail-closed：不留下新 CAS residue。
    const after = physicalObjects(ctx.root).length
    expect(after).toBe(before)
    if (after !== before) {
      throw new Error(`R7-00-14 RED: ${after - before} new physical CAS object(s) after the corrupted-snapshot rejection (attestation must happen before any CAS put)`)
    }
    ctx.cleanup()
  })
})
