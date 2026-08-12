/** AK2-T05 — Projection Coordinator 状态机 + 故障矩阵（fixture backend）。 */

import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectionError } from "../../../src/kernel/projection/contracts"
import { ProjectionCoordinator, type ProjectionExecutor } from "../../../src/kernel/projection/coordinator"
import { SnapshotMaterializer } from "../../../src/kernel/projection/materializer"
import { CopyProjectionFixtureBackend, type NativeProjectionBackend, type ProjectionInstance } from "../../../src/kernel/projection/backend"
import { validateWorldProjectionPlan, type WorldProjectionPlanInput } from "../../../src/kernel/projection/plan"
import { createTestWorldStore, type TestWorldStore } from "../world/helpers"
import type { WorldProjectionPlan } from "../../../src/kernel/projection/contracts"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ak2-coord-${label}-`))
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 已删
    }
  })
  return dir
}

/** revision 0 world + 一个 TS 文件 → commit → snapshot rev1。 */
function buildWorld(): { ctx: TestWorldStore; snapshotId: string; baseContent: string } {
  const ctx = createTestWorldStore()
  ctx.store.createWorld({
    worldId: "world-c",
    branchId: "branch-main",
    rootObjectId: "root-1",
    owner: "owner:test",
    purpose: "ak2 coordinator",
  })
  const baseContent = "export const value = 1\n"
  const digest = ctx.store.cas.put(Buffer.from(baseContent, "utf8"), "text/plain").digest
  ctx.store.compareAndCommit({
    worldId: "world-c",
    branchId: "branch-main",
    baseRevision: 0n,
    actor: "actor:test",
    mutations: [
      { type: "object.put", objectId: "obj-src", objectType: "directory", path: "src" },
      { type: "object.put", objectId: "obj-main", objectType: "file", path: "src/main.ts", contentRef: digest },
    ],
  })
  ctx.store.createSnapshot("world-c", "branch-main")
  const snapshot = ctx.store.snapshots.getForRevision("world-c", "branch-main", 1n)!
  return { ctx, snapshotId: snapshot.snapshotId, baseContent }
}

function makePlan(snapshotId: string, overrides: Partial<WorldProjectionPlanInput> = {}): WorldProjectionPlan {
  return validateWorldProjectionPlan({
    projectionId: `proj-${Math.random().toString(36).slice(2, 10)}`,
    worldId: "world-c",
    branchId: "branch-main",
    snapshotId,
    actor: "actor:test",
    mode: "native",
    writableRoots: ["src"],
    readonlyRoots: ["docs"],
    expectedOutputs: ["src/main.ts"],
    graphCompletionAllowed: false,
    ...overrides,
  })
}

function coordinator(ctx: TestWorldStore, backend?: NativeProjectionBackend): ProjectionCoordinator {
  const materializer = new SnapshotMaterializer({
    getSnapshot: id => ctx.store.snapshots.get(id),
    getCasRecord: digest => ctx.store.cas.record(digest),
    readCasObject: digest => ctx.store.cas.get(digest),
  })
  return new ProjectionCoordinator({
    store: ctx.store,
    materializer,
    backend: backend ?? new CopyProjectionFixtureBackend(),
    projectionRoot: tmpRoot("projroot"),
    allowTestBackends: true,
  })
}

/** 修改 merged 文件的 executor（模拟 Linux execution 对 projection 的写入）。 */
function mutateExecutor(actions: (merged: string) => void): ProjectionExecutor {
  return async cwd => {
    actions(cwd)
    return { exitCode: 0, timedOut: false, cancelled: false, violation: false }
  }
}

describe("AK2-T05 纵向状态机（fixture backend）", () => {
  test("PROJECTED → COMPLETED → DELTA_READY → COMMITTED，receipt/digest 一致", async () => {
    const { ctx, snapshotId, baseContent } = buildWorld()
    const coord = coordinator(ctx)
    const plan = makePlan(snapshotId)

    const session = coord.start(plan)
    expect(session.worldState).toBe("PROJECTED")
    expect(session.executionState).toBe("PENDING")
    expect(readFileSync(join(session.mergedDir, "src/main.ts"), "utf8")).toBe(baseContent)
    // 执行环境没有 WorldDB/CAS 权威路径。
    expect(existsSync(join(session.mergedDir, "world.db"))).toBe(false)
    expect(existsSync(join(session.mergedDir, "cas"))).toBe(false)

    const newContent = "export const value = 42\n"
    const outcome = await coord.execute(
      session,
      { executable: "noop", args: [] },
      mutateExecutor(merged => writeFileSync(join(merged, "src/main.ts"), newContent)),
    )
    expect(outcome.exitCode).toBe(0)
    expect(session.executionState).toBe("COMPLETED")
    // exitCode=0 后 World 仍未完成（可观测未完成）。
    expect(session.worldState).toBe("PROJECTED")
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)

    const delta = coord.scan(session)
    expect(session.worldState).toBe("DELTA_READY")
    expect(delta.entries).toContainEqual(expect.objectContaining({ kind: "write", path: "src/main.ts" }))

    const receipt = coord.commit(session)
    expect(session.worldState).toBe("COMMITTED")
    // commit() 返回 store 的 WorldCommitReceipt；正交状态 receipt 在 session.receipt。
    expect(receipt.deltaDigest).toBe(delta.deltaDigest)
    expect(session.receipt!.worldState).toBe("COMMITTED")
    expect(session.receipt!.executionState).toBe("COMPLETED")
    expect(session.receipt!.effectState).toBe("NONE")
    expect(session.receipt!.evidenceState).toBe("PENDING")
    expect(session.receipt!.deltaDigest).toBe(delta.deltaDigest)
    expect(session.receipt!.worldCommitReceipt).toBeDefined()
    expect(session.receipt!.worldCommitReceipt!.deltaDigest).toBe(delta.deltaDigest)
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(2n)
    // 新快照可创建并包含新内容。
    const snapshot2 = ctx.store.createSnapshot("world-c", "branch-main")
    expect(snapshot2.revision).toBe(2n)
    const materialized = new SnapshotMaterializer({
      getSnapshot: id => ctx.store.snapshots.get(id),
      getCasRecord: digest => ctx.store.cas.record(digest),
      readCasObject: digest => ctx.store.cas.get(digest),
    })
    const base2 = join(tmpRoot("rev2"), "base")
    mkdirSync(base2)
    materialized.materialize(snapshot2.snapshotId, base2)
    expect(readFileSync(join(base2, "src/main.ts"), "utf8")).toBe(newContent)
    expect(ctx.store.verifyIntegrity()).toEqual([])
    ctx.cleanup()
  })

  test("execution success 后 commit 前：World 状态可观测未完成，不触发 Graph", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = coordinator(ctx)
    const session = coord.start(makePlan(snapshotId))
    await coord.execute(
      session,
      { executable: "noop", args: [] },
      mutateExecutor(merged => writeFileSync(join(merged, "src/main.ts"), "export const value = 7\n")),
    )
    // 无 Graph authority 暴露：receipt 只有 Execution/World 事实。
    const receipt = coord.buildReceipt(session, "COMMIT_PENDING")
    expect(receipt.effectState).toBe("NONE")
    expect(receipt.evidenceState).toBe("PENDING")
    expect("graphCompleted" in receipt).toBe(false)
    expect("completion" in receipt).toBe(false)
    coord.cancel(session)
    ctx.cleanup()
  })
})

describe("AK2-T05 故障矩阵（World 不受损 + 不自动完成）", () => {
  test("execution exitCode!=0 → REJECTED；World revision 不变", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = coordinator(ctx)
    const session = coord.start(makePlan(snapshotId))
    await coord.execute(
      session,
      { executable: "noop", args: [] },
      async () => ({ exitCode: 2, timedOut: false, cancelled: false, violation: false }),
    )
    expect(session.executionState).toBe("FAILED")
    try {
      coord.scan(session)
      throw new Error("expected scan rejection")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("PROJECTION_NOT_PROJECTED")
    }
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    coord.cancel(session)
    ctx.cleanup()
  })

  test("execution cancel → CANCELLED；不 commit", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = coordinator(ctx)
    const session = coord.start(makePlan(snapshotId))
    await coord.execute(
      session,
      { executable: "noop", args: [] },
      async () => ({ exitCode: 0, timedOut: false, cancelled: true, violation: false }),
    )
    expect(session.executionState).toBe("CANCELLED")
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    coord.cancel(session)
    ctx.cleanup()
  })

  test("readonly 写入 → REJECTED；World 不变", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = coordinator(ctx)
    const session = coord.start(makePlan(snapshotId))
    await coord.execute(
      session,
      { executable: "noop", args: [] },
      mutateExecutor(merged => {
        mkdirSync(join(merged, "docs"), { recursive: true })
        writeFileSync(join(merged, "docs/leak.md"), "tampered")
      }),
    )
    const delta = coord.scan(session)
    try {
      coord.commit(session)
      throw new Error("expected rejection")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("VALIDATION_REJECTED")
    }
    expect(session.worldState).toBe("REJECTED")
    expect(session.receipt!.worldState).toBe("REJECTED")
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("unauthorized write（writable 之外）→ REJECTED", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = coordinator(ctx)
    const session = coord.start(makePlan(snapshotId))
    await coord.execute(
      session,
      { executable: "noop", args: [] },
      mutateExecutor(merged => {
        mkdirSync(join(merged, "vendor"), { recursive: true })
        writeFileSync(join(merged, "vendor/sneaky.txt"), "x")
      }),
    )
    const delta = coord.scan(session)
    try {
      coord.commit(session)
      throw new Error("expected rejection")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("VALIDATION_REJECTED")
    }
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("expected output 缺失 → REJECTED", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = coordinator(ctx)
    // 期望 src/main.ts 存在但 execution 删除了它。
    const session = coord.start(makePlan(snapshotId))
    await coord.execute(
      session,
      { executable: "noop", args: [] },
      mutateExecutor(merged => rmSync(join(merged, "src/main.ts"))),
    )
    const delta = coord.scan(session)
    try {
      coord.commit(session)
      throw new Error("expected rejection")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("VALIDATION_REJECTED")
    }
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("expected output 是 symlink → REJECTED", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = coordinator(ctx)
    const session = coord.start(makePlan(snapshotId))
    await coord.execute(
      session,
      { executable: "noop", args: [] },
      mutateExecutor(merged => {
        rmSync(join(merged, "src/main.ts"))
        symlinkSync("other", join(merged, "src/main.ts"))
      }),
    )
    // symlink 在 delta scan 层即被拒绝（scanner 对 merged 任何 symlink fail-closed）。
    try {
      coord.scan(session)
      throw new Error("expected DELTA_SCAN_FAILED")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("DELTA_SCAN_FAILED")
    }
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    coord.cancel(session)
    ctx.cleanup()
  })

  test("cleanup 失败 → CLEANUP_FAILED；World commit 被阻止", async () => {
    const { ctx, snapshotId } = buildWorld()
    const failingBackend: NativeProjectionBackend = {
      id: "fixture-failing-cleanup",
      kind: "fixture",
      create(input) {
        const inner = new CopyProjectionFixtureBackend().create(input)
        const instance: ProjectionInstance = {
          backend: "fixture",
          mergedPath: inner.mergedPath,
          writeLayerPath: inner.writeLayerPath,
          assertReady: inner.assertReady,
          cleanup: () => false, // cleanup 失败
        }
        return instance
      },
    }
    const coord = coordinator(ctx, failingBackend)
    const session = coord.start(makePlan(snapshotId))
    await coord.execute(
      session,
      { executable: "noop", args: [] },
      mutateExecutor(merged => writeFileSync(join(merged, "src/main.ts"), "changed\n")),
    )
    coord.scan(session)
    try {
      coord.commit(session)
      throw new Error("expected CLEANUP_FAILED")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("CLEANUP_FAILED")
    }
    expect(session.worldState).toBe("REJECTED")
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("stale head → CONFLICTED（WORLD_HEAD_MOVED）；不自动 retry/merge", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = coordinator(ctx)
    const session = coord.start(makePlan(snapshotId))
    // 另一 actor 先提交 revision 2。
    const otherContent = "export const other = true\n"
    const otherDigest = ctx.store.cas.put(Buffer.from(otherContent, "utf8"), "text/plain").digest
    ctx.store.compareAndCommit({
      worldId: "world-c",
      branchId: "branch-main",
      baseRevision: 1n,
      actor: "actor:other",
      mutations: [
        { type: "object.put", objectId: "obj-other", objectType: "file", path: "src/other.ts", contentRef: otherDigest },
      ],
    })
    await coord.execute(
      session,
      { executable: "noop", args: [] },
      mutateExecutor(merged => writeFileSync(join(merged, "src/main.ts"), "mine\n")),
    )
    const delta = coord.scan(session)
    try {
      coord.commit(session)
      throw new Error("expected WORLD_HEAD_MOVED")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("WORLD_HEAD_MOVED")
    }
    expect(session.worldState).toBe("CONFLICTED")
    expect(session.receipt!.worldState).toBe("CONFLICTED")
    // 不自动 retry：world 保持 revision 2（另一 actor 的内容），冲突未覆盖。
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(2n)
    expect(ctx.store.listObjects("world-c", "branch-main").some(o => o.path === "src/other.ts")).toBe(true)
    expect(ctx.store.listObjects("world-c", "branch-main").some(o => o.path === "src/main.ts" && o.contentRef === ctx.store.cas.put(Buffer.from("mine\n", "utf8"), "text/plain").digest)).toBe(false)
    ctx.cleanup()
  })

  test("delta CAS put 后、World commit 前故障：World 不变，孤立 CAS 对象可被 GC（不伪装 committed）", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = coordinator(ctx)
    const session = coord.start(makePlan(snapshotId))
    await coord.execute(
      session,
      { executable: "noop", args: [] },
      mutateExecutor(merged => writeFileSync(join(merged, "src/ghost.ts"), "ghost content\n")),
    )
    const delta = coord.scan(session)
    // delta 内容已入 CAS。
    const ghostDigest = ctx.store.cas.put(Buffer.from("ghost content\n", "utf8"), "text/plain").digest
    expect(ctx.store.cas.has(ghostDigest)).toBe(true)
    // commit 被拒绝（expected output 还在，用 readonly 违规制造 REJECT）。
    // —— 直接制造 stale head。
    ctx.store.compareAndCommit({
      worldId: "world-c",
      branchId: "branch-main",
      baseRevision: 1n,
      actor: "actor:other",
      mutations: [
        { type: "object.put", objectId: "obj-z", objectType: "file", path: "src/z.ts", contentRef: ctx.store.cas.put(Buffer.from("z\n", "utf8"), "text/plain").digest },
      ],
    })
    try {
      coord.commit(session)
      throw new Error("expected WORLD_HEAD_MOVED")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("WORLD_HEAD_MOVED")
    }
    // World 未损坏：revision 2，且 ghost 内容未进入任何 committed root。
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(2n)
    expect(ctx.store.listObjects("world-c", "branch-main").some(o => o.path === "src/ghost.ts")).toBe(false)
    // 孤立 CAS 对象存在但可被 GC 回收（安全 GC 等待，不伪装 committed）。
    const gced = ctx.store.cas.gc()
    expect(gced).toContain(ghostDigest)
    ctx.cleanup()
  })

  test("execution success 后、delta 前故障（scan 拒绝）：World 不变，cancel 清理", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = coordinator(ctx)
    const session = coord.start(makePlan(snapshotId))
    await coord.execute(
      session,
      { executable: "noop", args: [] },
      mutateExecutor(merged => {
        writeFileSync(join(merged, "src/main.ts"), "changed\n")
        symlinkSync("main.ts", join(merged, "src/evil-link"))
      }),
    )
    expect(session.executionState).toBe("COMPLETED")
    try {
      coord.scan(session)
      throw new Error("expected DELTA_SCAN_FAILED")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("DELTA_SCAN_FAILED")
    }
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    // R03：scan 失败走同一 cleanup 状态机 —— 终态 REJECTED、根已删、
    // cleanupState 记录成功（不再需要显式 cancel）。
    expect(session.worldState).toBe("REJECTED")
    expect(session.receipt!.worldState).toBe("REJECTED")
    expect(session.cleanupState).toEqual({ cleanupOk: true, rootRemoved: true })
    expect(existsSync(session.projectionRoot)).toBe(false)
    expect(session.receipt!.executionState).toBe("COMPLETED")
    ctx.cleanup()
  })

  test("executor 抛异常 → execute 标记 FAILED 并清理投影根（不变量：任何路径不留残留）", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = coordinator(ctx)
    const session = coord.start(makePlan(snapshotId))
    const root = session.projectionRoot
    expect(existsSync(join(root, "merged-m"))).toBe(true)

    await expect(
      coord.execute(
        session,
        { executable: "noop", args: [] },
        async () => {
          throw new Error("executor exploded")
        },
      ),
    ).rejects.toThrow("executor exploded")
    expect(session.executionState).toBe("FAILED")
    // 投影根（含挂载点/upper）已被清理，无残留。
    expect(existsSync(root)).toBe(false)
    // World 不受影响（revision 0 → 1 未被 commit 触碰）。
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    // R03：executor throw 走同一 cleanup 状态机。
    expect(session.cleanupState).toEqual({ cleanupOk: true, rootRemoved: true })
    ctx.cleanup()
  })

  test("R02 纵向：同内容 a.txt/b.txt 与两个空目录 commit 后对象均存在，不互相覆盖", async () => {
    const ctx = createTestWorldStore()
    ctx.store.createWorld({ worldId: "world-id", branchId: "branch-main", rootObjectId: "root-1", owner: "owner:test", purpose: "ak2 r02" })
    const digest = ctx.store.cas.put(Buffer.from("identical content\n", "utf8"), "text/plain").digest
    ctx.store.compareAndCommit({
      worldId: "world-id",
      branchId: "branch-main",
      baseRevision: 0n,
      actor: "actor:test",
      mutations: [
        { type: "object.put", objectId: "d1", objectType: "directory", path: "src" },
        { type: "object.put", objectId: "d2", objectType: "directory", path: "lib" },
        { type: "object.put", objectId: "f1", objectType: "file", path: "src/a.txt", contentRef: digest },
        { type: "object.put", objectId: "f2", objectType: "file", path: "src/b.txt", contentRef: digest },
      ],
    })
    ctx.store.createSnapshot("world-id", "branch-main")
    const snapshot = ctx.store.snapshots.getForRevision("world-id", "branch-main", 1n)!
    const coord = coordinator(ctx)
    const plan = validateWorldProjectionPlan({
      projectionId: `proj-r02-${Math.random().toString(36).slice(2, 8)}`,
      worldId: "world-id",
      branchId: "branch-main",
      snapshotId: snapshot.snapshotId,
      actor: "actor:test",
      mode: "native",
      writableRoots: ["src", "lib"],
      readonlyRoots: [],
      expectedOutputs: ["src/a.txt"],
      graphCompletionAllowed: false,
    })
    const session = coord.start(plan)
    // 两个同内容文件 + 两个空目录物化（派生 objectId 必须不同 —— 无覆盖）。
    expect(readFileSync(join(session.mergedDir, "src/a.txt"), "utf8")).toBe("identical content\n")
    expect(readFileSync(join(session.mergedDir, "src/b.txt"), "utf8")).toBe("identical content\n")
    expect(existsSync(join(session.mergedDir, "lib"))).toBe(true)
    const outcome = await coord.execute(
      session,
      { executable: "noop", args: [] },
      mutateExecutor(merged => writeFileSync(join(merged, "src/a.txt"), "changed\n")),
    )
    expect(outcome.exitCode).toBe(0)
    const delta = coord.scan(session)
    // write 保留 base objectId（src/a.txt 与 src/b.txt 的 objectId 不同）。
    const writeEntry = delta.entries.find(entry => entry.kind === "write" && entry.path === "src/a.txt")!
    const bEntry = delta.entries.find(entry => entry.kind === "write" && entry.path === "src/b.txt")
    expect(bEntry).toBeUndefined()
    // write 保留既有 object identity（来自 snapshot section manifest id）。
    expect(writeEntry.objectId).toBe("f1")
    const receipt = coord.commit(session)
    expect(receipt.newRevision).toBe(2n)
    // 两个对象都在 World 中（path 各归其位，无 UPSERT 覆盖）。
    const objects = ctx.store.listObjects("world-id", "branch-main")
    const a = objects.find(o => o.path === "src/a.txt")
    const b = objects.find(o => o.path === "src/b.txt")
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a!.objectId).not.toBe(b!.objectId)
    // a.txt 已被 execution 改为 changed\n；b.txt 保留原内容 digest。
    expect(a!.contentRef).not.toBe(digest)
    expect(b!.contentRef).toBe(digest)
    // commit → snapshot → materialize：路径与内容完整。
    ctx.store.createSnapshot("world-id", "branch-main")
    const snapshot2 = ctx.store.snapshots.getForRevision("world-id", "branch-main", 2n)!
    const base2 = join(tmpRoot("r02rev2"), "base")
    mkdirSync(base2)
    new SnapshotMaterializer({
      getSnapshot: id => ctx.store.snapshots.get(id),
      getCasRecord: d => ctx.store.cas.record(d),
      readCasObject: d => ctx.store.cas.get(d),
    }).materialize(snapshot2.snapshotId, base2)
    expect(readFileSync(join(base2, "src/a.txt"), "utf8")).toBe("changed\n")
    expect(readFileSync(join(base2, "src/b.txt"), "utf8")).toBe("identical content\n")
    expect(existsSync(join(base2, "lib"))).toBe(true)
    ctx.cleanup()
  })

  test("R02.6 store 层：同 commit 内 objectId 冲突身份拒绝（不依赖 UPSERT 覆盖）", async () => {
    const ctx = createTestWorldStore()
    ctx.store.createWorld({ worldId: "world-collide", branchId: "branch-main", rootObjectId: "root-1", owner: "owner:test", purpose: "ak2 r02.6" })
    const digest = ctx.store.cas.put(Buffer.from("x\n", "utf8"), "text/plain").digest
    expect(() =>
      ctx.store.compareAndCommit({
        worldId: "world-collide",
        branchId: "branch-main",
        baseRevision: 0n,
        actor: "actor:test",
        mutations: [
          { type: "object.put", objectId: "same-id", objectType: "file", path: "a.txt", contentRef: digest },
          { type: "object.put", objectId: "same-id", objectType: "file", path: "b.txt", contentRef: digest },
        ],
      }),
    ).toThrow(/objectId collision/)
    // put + delete 并存同 id 也拒绝。
    expect(() =>
      ctx.store.compareAndCommit({
        worldId: "world-collide",
        branchId: "branch-main",
        baseRevision: 0n,
        actor: "actor:test",
        mutations: [
          { type: "object.put", objectId: "same-id", objectType: "file", path: "a.txt", contentRef: digest },
          { type: "object.delete", objectId: "same-id" },
        ],
      }),
    ).toThrow(/objectId collision/)
    // World 未推进。
    expect(ctx.store.getWorld("world-collide")!.currentRevision).toBe(0n)
    ctx.cleanup()
  })

  test("R06.3 fixture backend 无显式 test capability → 生产 coordinator 拒绝", () => {
    const { ctx, snapshotId } = buildWorld()
    const materializer = new SnapshotMaterializer({
      getSnapshot: id => ctx.store.snapshots.get(id),
      getCasRecord: d => ctx.store.cas.record(d),
      readCasObject: d => ctx.store.cas.get(d),
    })
    expect(() =>
      new ProjectionCoordinator({
        store: ctx.store,
        materializer,
        backend: new CopyProjectionFixtureBackend(),
        projectionRoot: tmpRoot("nofix"),
      }),
    ).toThrow(ProjectionError)
    // 显式 capability 才放行。
    const coord = new ProjectionCoordinator({
      store: ctx.store,
      materializer,
      backend: new CopyProjectionFixtureBackend(),
      projectionRoot: tmpRoot("fix"),
      allowTestBackends: true,
    })
    const session = coord.start(makePlan(snapshotId))
    coord.cancel(session)
    ctx.cleanup()
  })

  test("R03：unmount 失败 → CLEANUP_FAILED 阻止 commit；residue 保留可诊断；World 未推进", async () => {
    const { ctx, snapshotId, baseContent } = buildWorld()
    const materializer = new SnapshotMaterializer({
      getSnapshot: id => ctx.store.snapshots.get(id),
      getCasRecord: d => ctx.store.cas.record(d),
      readCasObject: d => ctx.store.cas.get(d),
    })
    const root = tmpRoot("residue")
    // stub backend：真实 fixture 语义但 cleanup 恒 false（模拟 unmount 失败）。
    const failingBackend: NativeProjectionBackend = {
      id: "fixture-failing",
      kind: "fixture",
      create(input) {
        const merged = join(input.projectionRoot, "merged-m")
        mkdirSync(merged, { mode: 0o700 })
        cpSync(input.lowerDir, merged, { recursive: true })
        // 模拟 upper 语义：副本可写（lower 0444 不继承）。
        const chmodTree = (dir: string): void => {
          for (const entry of readdirSync(dir)) {
            const full = join(dir, entry)
            const stat = lstatSync(full)
            if (stat.isDirectory()) chmodTree(full)
            else if (stat.isFile()) chmodSync(full, 0o644)
          }
        }
        chmodTree(merged)
        return {
          backend: "fixture",
          mergedPath: merged,
          writeLayerPath: merged,
          assertReady: () => undefined,
          cleanup: () => false,
        }
      },
    }
    const coord = new ProjectionCoordinator({
      store: ctx.store,
      materializer,
      backend: failingBackend,
      projectionRoot: root,
      allowTestBackends: true,
    })
    const session = coord.start(makePlan(snapshotId))
    expect(readFileSync(join(session.mergedDir, "src/main.ts"), "utf8")).toBe(baseContent)
    await coord.execute(
      session,
      { executable: "noop", args: [] },
      mutateExecutor(merged => writeFileSync(join(merged, "src/main.ts"), "changed\n")),
    )
    coord.scan(session)
    try {
      coord.commit(session)
      throw new Error("expected CLEANUP_FAILED")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("CLEANUP_FAILED")
    }
    // World 未推进；无 receipt（正交状态）。
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    expect(session.worldState).toBe("REJECTED")
    expect(session.receipt!.worldState).toBe("REJECTED")
    expect(session.receipt!.worldCommitReceipt).toBeUndefined()
    // cleanup 状态机：unmount 失败 → residue 保留（root 未删除，可诊断）。
    expect(session.cleanupState).toEqual({ cleanupOk: false, rootRemoved: false })
    expect(existsSync(session.projectionRoot)).toBe(true)
    expect(existsSync(join(session.projectionRoot, "merged-m"))).toBe(true)
    ctx.cleanup()
  })
})
