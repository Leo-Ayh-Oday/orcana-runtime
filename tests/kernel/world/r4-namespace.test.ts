/**
 * AK2-R4 Correction Gate —— World 最终 namespace（R4-07）先红反例冻结。
 *
 * R4-07 final-state 模型：
 * 1. 按 objectId 加载 current state；
 * 2. 按 mutation 应用 delete/put（put 同一 objectId 先移除旧 state/path）；
 * 3. 从最终 byId 重建 byPath；
 * 4. 全局验证：canonical path、path 唯一、objectId 唯一身份、file/directory
 *    必须有 path、workspace 必须无 path（materializer 契约）、file 必须有
 *    contentRef、每个对象的所有显式祖先必须是 directory、file 不得成为
 *    任意对象的祖先。
 *
 * 反例（R4-00-10）在修复前必须 RED：
 * - 10a directory object 从 a 移到 b 后留下 a/x orphan（directory 孤儿不检查）
 * - 10b directory a/b + file a 的反序 mutation（file 祖先不检查）
 * - 10c pathless file（无 path 对象不检查）
 * - 10d pathful workspace（workspace 允许 path —— materializer 契约违反）
 * - 10e object move 后由其他 object 复用旧 path（孤儿悬挂在 file 下）
 * 成功路径必须继续执行 createSnapshot → materialize（R4-07）。
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotMaterializer } from "../../../src/kernel/projection/materializer"
import { createTestWorldStore } from "./helpers"

function worldFixture() {
  const ctx = createTestWorldStore()
  ctx.store.createWorld({ worldId: "w-ns", branchId: "main", rootObjectId: "root", owner: "o", purpose: "r4 namespace" })
  return ctx
}

/** 初始状态：dir a 含 dir 子项 a/x。 */
function seedDirWithChild(ctx: ReturnType<typeof worldFixture>): void {
  ctx.store.compareAndCommit({
    worldId: "w-ns",
    branchId: "main",
    baseRevision: 0n,
    actor: "a",
    mutations: [
      { type: "object.put", objectId: "obj-a", objectType: "directory", path: "a" },
      { type: "object.put", objectId: "obj-a-x", objectType: "directory", path: "a/x" },
    ],
  })
}

function expectNamespaceRejected(ctx: ReturnType<typeof worldFixture>, label: string, mutations: Parameters<ReturnType<typeof worldFixture>["store"]["compareAndCommit"]>[0]["mutations"]): void {
  const before = ctx.store.getWorld("w-ns")!.currentRevision
  let rejected = false
  try {
    ctx.store.compareAndCommit({
      worldId: "w-ns",
      branchId: "main",
      baseRevision: before,
      actor: "a",
      mutations,
    })
  } catch {
    rejected = true
  }
  if (!rejected) {
    throw new Error(`${label} RED: invalid final namespace was accepted by compareAndCommit`)
  }
  // 失败：revision 不推进、ledger 不追加、CAS owner links 不残留。
  expect(ctx.store.getWorld("w-ns")!.currentRevision).toBe(before)
  const commits = ctx.store.ledger.list("w-ns").filter(event => event.eventType === "world.commit")
  expect(commits.length).toBe(before === 0n ? 0 : 1)
}

describe("AK2-R4 World 最终 namespace 反例（R4-00-10 先红冻结）", () => {
  test("R4-00-10a：directory object 从 a 移到 b 后留下 a/x orphan → 拒绝", () => {
    const ctx = worldFixture()
    seedDirWithChild(ctx)
    // move a→b（put 同一 objectId 先移除旧 path）；a/x 成为孤儿。
    expectNamespaceRejected(ctx, "R4-00-10a", [
      { type: "object.put", objectId: "obj-a", objectType: "directory", path: "b" },
    ])
    ctx.cleanup()
  })

  test("R4-00-10b：directory a/b + file a 的反序 mutation → 拒绝（file 不得成为祖先）", () => {
    const ctx = worldFixture()
    const content = ctx.store.cas.put(Buffer.from("x", "utf8")).digest
    // 反序：先 put a/b(dir)，再 put a(file) —— 顺序相关预检无法发现，
    // 最终状态校验必须拒绝（a 是 a/b 的祖先且为 file）。
    expectNamespaceRejected(ctx, "R4-00-10b", [
      { type: "object.put", objectId: "obj-a-b", objectType: "directory", path: "a/b" },
      { type: "object.put", objectId: "obj-a", objectType: "file", path: "a", contentRef: content },
    ])
    ctx.cleanup()
  })

  test("R4-00-10c：pathless file → 拒绝（file/directory 必须有 path）", () => {
    const ctx = worldFixture()
    const content = ctx.store.cas.put(Buffer.from("y", "utf8")).digest
    expectNamespaceRejected(ctx, "R4-00-10c", [
      { type: "object.put", objectId: "obj-pathless", objectType: "file", contentRef: content },
    ])
    ctx.cleanup()
  })

  test("R4-00-10d：pathful workspace → 拒绝（materializer 契约：workspace 无 path）", () => {
    const ctx = worldFixture()
    expectNamespaceRejected(ctx, "R4-00-10d", [
      { type: "object.put", objectId: "obj-ws", objectType: "workspace", path: "ws" },
    ])
    ctx.cleanup()
  })

  test("R4-00-10e：object move 后由其他 object 复用旧 path → 拒绝（孤儿悬挂在 file 下）", () => {
    const ctx = worldFixture()
    seedDirWithChild(ctx)
    const content = ctx.store.cas.put(Buffer.from("z", "utf8")).digest
    // 对象 obj-a 移走（delete）后，文件 obj-c 复用旧 path a：a/x 孤儿现在
    // 悬挂在 file a 之下 —— 最终状态校验必须拒绝。
    expectNamespaceRejected(ctx, "R4-00-10e", [
      { type: "object.delete", objectId: "obj-a" },
      { type: "object.put", objectId: "obj-c", objectType: "file", path: "a", contentRef: content },
    ])
    ctx.cleanup()
  })

  test("R4-07 成功路径：合法嵌套 namespace 可 commit，且 createSnapshot → materialize 继续执行", () => {
    const ctx = worldFixture()
    const content = ctx.store.cas.put(Buffer.from("export const n = 1\n", "utf8")).digest
    const receipt = ctx.store.compareAndCommit({
      worldId: "w-ns",
      branchId: "main",
      baseRevision: 0n,
      actor: "a",
      mutations: [
        { type: "object.put", objectId: "obj-src", objectType: "directory", path: "src" },
        { type: "object.put", objectId: "obj-lib", objectType: "directory", path: "src/lib" },
        { type: "object.put", objectId: "obj-main", objectType: "file", path: "src/main.ts", contentRef: content },
      ],
    })
    expect(receipt.newRevision).toBe(1n)
    ctx.store.createSnapshot("w-ns", "main")
    const snapshot = ctx.store.snapshots.getForRevision("w-ns", "main", 1n)!
    const baseDir = mkdtempSync(join(tmpdir(), "ak2-r4-ns-ok-"))
    try {
      const materializer = new SnapshotMaterializer({
        getSnapshot: id => ctx.store.snapshots.get(id),
        getCasRecord: digest => ctx.store.cas.record(digest),
        readCasObject: digest => ctx.store.cas.get(digest),
      })
      const base = materializer.materialize(snapshot.snapshotId, baseDir)
      expect(base.fileCount).toBe(1)
      expect(base.directoryCount).toBe(2)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
      ctx.cleanup()
    }
  })
})
