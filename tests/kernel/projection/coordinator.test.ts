/** AK2-T05 — Projection Coordinator 状态机 + 故障矩阵（fixture backend）。 */

import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ProjectionError } from "../../../src/kernel/projection/contracts"
import { ProjectionCoordinator, expectedProjectionFilesystemPolicyDigest, type ProjectionExecutor } from "../../../src/kernel/projection/coordinator"
import { SnapshotMaterializer } from "../../../src/kernel/projection/materializer"
import { CopyProjectionFixtureBackend } from "./test-fixtures"
import { type NativeProjectionBackend, type ProjectionInstance } from "../../../src/kernel/projection/backend"
import { validateWorldProjectionPlan, type WorldProjectionPlanInput } from "../../../src/kernel/projection/plan"
import { createTestWorldStore, type TestWorldStore } from "../world/helpers"
import type { WorldProjectionPlan } from "../../../src/kernel/projection/contracts"
import type { CasDigest } from "../../../src/kernel/world"
import type { SandboxReceipt } from "../../../src/runtime/linux/contracts"
import type { ProjectionReceiptAuthority, ProjectionReceiptBinding } from "../../../src/kernel/projection/receipt-authority"

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

function coordinator(
  ctx: TestWorldStore,
  backend?: NativeProjectionBackend,
  receiptAuthority?: ProjectionReceiptAuthority,
): ProjectionCoordinator {
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
    ...(receiptAuthority === undefined ? {} : { receiptAuthority }),
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
      expect((error as ProjectionError).code).toMatch(/PROJECTION_NOT_PROJECTED|CLEANED_SESSION_REUSED/)
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
          sealForScan: () => ({ sealedPath: inner.mergedPath }),
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
    ).toThrow(/objectId.*collision/)
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
    ).toThrow(/objectId.*collision/)
    ctx.cleanup()
  })

  test("P1-1：完整 identity/mutation 冲突全部拒绝（contentRef/objectType/metadata）；canonical 相同允许 dedupe", async () => {
    const ctx = createTestWorldStore()
    ctx.store.createWorld({ worldId: "world-id1", branchId: "branch-main", rootObjectId: "root-1", owner: "owner:test", purpose: "ak2 p1-1" })
    const d1 = ctx.store.cas.put(Buffer.from("one\n", "utf8"), "text/plain").digest
    const d2 = ctx.store.cas.put(Buffer.from("two\n", "utf8"), "text/plain").digest
    const put = (over: object) => ({
      worldId: "world-id1", branchId: "branch-main", baseRevision: 0n, actor: "a",
      mutations: [{ type: "object.put", objectId: "same-id", objectType: "file", path: "a.txt", contentRef: d1 }, ...Object.entries(over).map(([k, v]) => v) as object[]],
    })
    // same id + same path + different contentRef。
    expect(() =>
      ctx.store.compareAndCommit({
        worldId: "world-id1", branchId: "branch-main", baseRevision: 0n, actor: "a",
        mutations: [
          { type: "object.put", objectId: "same-id", objectType: "file", path: "a.txt", contentRef: d1 },
          { type: "object.put", objectId: "same-id", objectType: "file", path: "a.txt", contentRef: d2 },
        ],
      }),
    ).toThrow(/identity collision/)
    // same id + same path + different objectType。
    expect(() =>
      ctx.store.compareAndCommit({
        worldId: "world-id1", branchId: "branch-main", baseRevision: 0n, actor: "a",
        mutations: [
          { type: "object.put", objectId: "same-id", objectType: "file", path: "a.txt", contentRef: d1 },
          { type: "object.put", objectId: "same-id", objectType: "directory", path: "a.txt" },
        ],
      }),
    ).toThrow(/identity collision/)
    // same id + same path + different metadata。
    expect(() =>
      ctx.store.compareAndCommit({
        worldId: "world-id1", branchId: "branch-main", baseRevision: 0n, actor: "a",
        mutations: [
          { type: "object.put", objectId: "same-id", objectType: "file", path: "a.txt", contentRef: d1, metadata: { a: 1 } },
          { type: "object.put", objectId: "same-id", objectType: "file", path: "a.txt", contentRef: d1, metadata: { a: 2 } },
        ],
      }),
    ).toThrow(/identity collision/)
    // same id + different path（已有）+ put/delete（已有）。
    // canonical 完全相同 → 允许（dedupe 不依赖 UPSERT 决胜）。
    const dedupe = ctx.store.compareAndCommit({
      worldId: "world-id1", branchId: "branch-main", baseRevision: 0n, actor: "a",
      mutations: [
        { type: "object.put", objectId: "dedupe-id", objectType: "file", path: "a.txt", contentRef: d1 },
        { type: "object.put", objectId: "dedupe-id", objectType: "file", path: "a.txt", contentRef: d1 },
      ],
    })
    expect(dedupe.newRevision).toBe(1n)
    // 冲突测试全部被拒绝在 revision 0（未推进）；dedupe 是唯一合法提交。
    expect(ctx.store.getWorld("world-id1")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  /** fake final receipt（authority 校验所需的字段；receiptDigest 必须是
   *  真实可验证的 canonical 摘要 —— R2-02 digest 自洽）。 */
  function fakeFinalReceipt(overrides: Partial<SandboxReceipt> = {}): SandboxReceipt {
    const base = {
      schemaVersion: "1.0",
      cellId: "cell-fake",
      runId: "run-fake",
      nodeRunId: "run-fake:n1",
      attempt: 1,
      backend: "bubblewrap",
      profile: "build",
      capabilitiesDigest: "b".repeat(64),
      cellSpecDigest: "c".repeat(64),
      filesystemPolicyDigest: "d".repeat(64),
      networkPolicyDigest: "e".repeat(64),
      resourcePolicyDigest: "f".repeat(64),
      startedAt: 1,
      finishedAt: 2,
      durationMs: 1,
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      oomKilled: false,
      pidLimitHit: false,
      outputLimitHit: false,
      tempLimitHit: false,
      metrics: { status: "unknown", reason: "test fixture" },
      observedWrites: [],
      observedDeletes: [],
      unexpectedWrites: [],
      networkMode: "none",
      secretBindingIds: [],
      violations: [],
      degradationReasons: [],
      cleanup: { processesRemaining: 0, mountsReleased: true, cgroupRemoved: true, worktreeRetained: false, cleanupVerified: true },
      ...overrides,
    } as Omit<SandboxReceipt, "receiptDigest">
    const { computeReceiptDigest } = require("../../../src/runtime/linux/receipt") as typeof import("../../../src/runtime/linux/receipt")
    return { ...base, receiptDigest: computeReceiptDigest(base) }
  }

  /** fake receipt authority：按需返回 fake final receipt。R2-01 后按
   *  intentId 查找；测试在 commit 前用 setIntentDigest(session.intent) 绑定
   *  当前 session 的 intent digest（模拟 broker 注入）。 */
  function fakeAuthority(overrides: Partial<SandboxReceipt> & { hidden?: boolean } = {}): ProjectionReceiptAuthority & {
    setIntentDigest(digest: string | undefined): void
    setFilesystemPolicyDigest(digest: string): void
    setCleanupFinalized(finalized: boolean): void
    currentDigest(): string | undefined
  } {
    const { hidden, ...receiptOverrides } = overrides
    let intentDigest: string | undefined
    // R4-03.4：fake receipt 必须携带 coordinator 派生的期望 policy digest。
    let filesystemPolicyDigest = "d".repeat(64)
    let cleanupFinalized = true
    // 预生成 digest（receipt 内容在构造时固定）。
    const seedReceipt = fakeFinalReceipt(receiptOverrides)
    let latestDigest: string | undefined = seedReceipt.receiptDigest
    const inner: ProjectionReceiptAuthority = {
      getFinalReceipt: () => {
        if (hidden === true) return undefined
        if (intentDigest === undefined) return undefined
        // digest 必须与最终内容（含 projectionIntentDigest）自洽 —— 与
        // broker 注入 intent 后重算 digest 的语义一致。
        const receipt = fakeFinalReceipt({ ...receiptOverrides, filesystemPolicyDigest })
        const { receiptDigest: _rd, ...content } = receipt
        const withIntent = { ...content, projectionIntentDigest: intentDigest }
        const { computeReceiptDigest: crd } = require("../../../src/runtime/linux/receipt") as typeof import("../../../src/runtime/linux/receipt")
        latestDigest = crd(withIntent)
        return { ...content, projectionIntentDigest: intentDigest, receiptDigest: latestDigest }
      },
      isCleanupFinalized: () => cleanupFinalized,
    }
    return Object.assign(inner, {
      setIntentDigest(digest: string | undefined): void {
        intentDigest = digest
      },
      setFilesystemPolicyDigest(digest: string): void {
        filesystemPolicyDigest = digest
      },
      setCleanupFinalized(finalized: boolean): void {
        cleanupFinalized = finalized
      },
      currentDigest(): string | undefined {
        // intent 已绑定时，digest 必须反映最终内容（含 projectionIntentDigest）。
        if (intentDigest === undefined) return latestDigest
        const { computeReceiptDigest: crd } = require("../../../src/runtime/linux/receipt") as typeof import("../../../src/runtime/linux/receipt")
        const { receiptDigest: _rd, ...content } = fakeFinalReceipt({ ...receiptOverrides, filesystemPolicyDigest })
        return crd({ ...content, projectionIntentDigest: intentDigest })
      },
    })
  }

  /** bindIntent 需要的最小 session 形态（plan + mergedDir + intent）。 */
  type ProjectionSessionLike = { plan: WorldProjectionPlan; mergedDir: string; intent: import("../../../src/kernel/projection/contracts").ProjectionExecutionIntent }

  /** 用当前 session.intent 配置 fake authority（模拟 broker 注入 intent）。 */
  function bindIntent(auth: ReturnType<typeof fakeAuthority>, session: ProjectionSessionLike): void {
    const { projectionIntentDigest: pid } = require("../../../src/kernel/projection/contracts") as typeof import("../../../src/kernel/projection/contracts")
    const { expectedProjectionFilesystemPolicyDigest } = require("../../../src/kernel/projection/coordinator") as typeof import("../../../src/kernel/projection/coordinator")
    auth.setIntentDigest(pid(session.intent))
    // R4-03.4：fake receipt 的 filesystemPolicyDigest 必须等于 coordinator
    // 从 kernel-owned input 派生的期望值。
    auth.setFilesystemPolicyDigest(expectedProjectionFilesystemPolicyDigest(session.plan, session.mergedDir))
  }

  /** 走完 start→execute(ok)→scan 的 session。 */
  async function sessionAtDeltaReady(
    coord: ProjectionCoordinator,
    plan: WorldProjectionPlan,
    ctx: TestWorldStore,
  ): Promise<import("../../../src/kernel/projection/coordinator").ProjectionSession> {
    const session = coord.start(plan)
    await coord.execute(
      session,
      { executable: "noop", args: [] },
      mutateExecutor(merged => writeFileSync(join(merged, "src/main.ts"), "changed\n")),
    )
    coord.scan(session)
    return session
  }

  test("R2-00-2：cleanupVerified=false / processesRemaining=-1 / mountsReleased=false 的 receipt 不得被认定 finalized", () => {
    const { RuntimeStateReceiptAuthority } = require("../../../src/kernel/projection/receipt-authority") as typeof import("../../../src/kernel/projection/receipt-authority")
    const auth = new RuntimeStateReceiptAuthority()
    // 未证明的 cleanup 全部必须拒绝（当前只检查类型 → 误接受）。
    expect(auth.isCleanupFinalized({ cleanup: { processesRemaining: -1, mountsReleased: false, cgroupRemoved: false, worktreeRetained: false, cleanupVerified: false } } as never)).toBe(false)
    expect(auth.isCleanupFinalized({ cleanup: { processesRemaining: 3, mountsReleased: true, cgroupRemoved: true, worktreeRetained: false, cleanupVerified: false } } as never)).toBe(false)
    expect(auth.isCleanupFinalized({ cleanup: { processesRemaining: 0, mountsReleased: false, cgroupRemoved: true, worktreeRetained: false, cleanupVerified: true } } as never)).toBe(false)
    // 真正证明的 cleanup 才接受。
    expect(auth.isCleanupFinalized({ cleanup: { processesRemaining: 0, mountsReleased: true, cgroupRemoved: true, worktreeRetained: false, cleanupVerified: true } } as never)).toBe(true)
  })

  test("R2-00-3：历史有效 receipt 不得跨 World 重放（binding 必须来自 coordinator 当前 session）", async () => {
    // world-A 用 receipt X commit 成功。
    const { ctx: ctxA, snapshotId: snapA } = buildWorld()
    const authA = fakeAuthority()
    const coordA = coordinator(ctxA, undefined, authA)
    const sessionA = await sessionAtDeltaReady(coordA, makePlan(snapA), ctxA)
    bindIntent(authA, sessionA)
    sessionA.outcome = {
      exitCode: 0, timedOut: false, cancelled: false, violation: false,
      executionReceiptId: authA.currentDigest()!,
      receiptBinding: { runId: "run-fake", nodeRunId: "run-fake:n1", cellId: "cell-fake", cellSpecDigest: "c".repeat(64), filesystemPolicyDigest: expectedProjectionFilesystemPolicyDigest(sessionA.plan, sessionA.mergedDir), workspaceHostRoot: sessionA.mergedDir },
    }
    const receiptA = coordA.commit(sessionA)
    expect(receiptA.newRevision).toBe(2n)
    // world-B（不同 worldId）用同一 receipt 重放 → 必须拒绝（REPLAY）。
    const ctxB = createTestWorldStore()
    ctxB.store.createWorld({ worldId: "world-replay", branchId: "branch-main", rootObjectId: "root-1", owner: "owner:test", purpose: "ak2 r2-00-3" })
    const digestB = ctxB.store.cas.put(Buffer.from("v1\n", "utf8"), "text/plain").digest
    ctxB.store.compareAndCommit({
      worldId: "world-replay", branchId: "branch-main", baseRevision: 0n, actor: "a",
      mutations: [
        { type: "object.put", objectId: "d1", objectType: "directory", path: "src" },
        { type: "object.put", objectId: "f1", objectType: "file", path: "src/main.ts", contentRef: digestB },
      ],
    })
    ctxB.store.createSnapshot("world-replay", "branch-main")
    const snapB = ctxB.store.snapshots.getForRevision("world-replay", "branch-main", 1n)!
    const materializerB = new SnapshotMaterializer({
      getSnapshot: id => ctxB.store.snapshots.get(id),
      getCasRecord: d => ctxB.store.cas.record(d),
      readCasObject: d => ctxB.store.cas.get(d),
    })
    const authB = fakeAuthority()
    const coordB = new ProjectionCoordinator({
      store: ctxB.store, materializer: materializerB, backend: new CopyProjectionFixtureBackend(),
      projectionRoot: tmpRoot("replay"), allowTestBackends: true, receiptAuthority: authB,
    })
    const planB = validateWorldProjectionPlan({
      projectionId: `proj-replay-${Math.random().toString(36).slice(2, 8)}`,
      worldId: "world-replay", branchId: "branch-main", snapshotId: snapB.snapshotId, actor: "a",
      mode: "native", writableRoots: ["src"], readonlyRoots: [], expectedOutputs: ["src/main.ts"], graphCompletionAllowed: false,
    })
    const sessionB = await sessionAtDeltaReady(coordB, planB, ctxB)
    // 重放场景：把 world-A 的 intent digest 绑定到 world-B 的 authority
    // （攻击者复用 world-A 的 receipt）。
    bindIntent(authB, sessionA)
    sessionB.outcome = {
      exitCode: 0, timedOut: false, cancelled: false, violation: false,
      // 重放 world-A 的 receipt（同 binding、同 intent digest）。
      executionReceiptId: authB.currentDigest()!,
      receiptBinding: { runId: "run-fake", nodeRunId: "run-fake:n1", cellId: "cell-fake", cellSpecDigest: "c".repeat(64), filesystemPolicyDigest: expectedProjectionFilesystemPolicyDigest(sessionB.plan, sessionB.mergedDir), workspaceHostRoot: sessionB.mergedDir },
    }
    try {
      coordB.commit(sessionB)
      throw new Error("expected receipt replay rejection")
    } catch (error) {
      // R2-01：world-B 的 intent 与 world-A 的 receipt intent 不匹配 → REPLAY。
      expect((error as ProjectionError).code).toBe("EXECUTION_RECEIPT_REPLAY")
    }
    expect(ctxB.store.getWorld("world-replay")!.currentRevision).toBe(1n)
    ctxA.cleanup()
    ctxB.cleanup()
  })

  test("R2-00-4：FAILED/CANCELLED（已 cleanup）后 session 不得再次 execute（cleaned session reuse）", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = coordinator(ctx)
    const session = coord.start(makePlan(snapshotId))
    await coord.execute(session, { executable: "noop", args: [] }, async () => ({ exitCode: 3, timedOut: false, cancelled: false, violation: false }))
    // FAILED → 已自动 cleanup（root 删除）。
    expect(session.executionState).toBe("FAILED")
    expect(existsSync(session.projectionRoot)).toBe(false)
    // 再次 execute 必须拒绝（cleaned session reuse）。
    await expect(
      coord.execute(session, { executable: "noop", args: [] }, async () => ({ exitCode: 0, timedOut: false, cancelled: false, violation: false })),
    ).rejects.toMatchObject({ code: "CLEANED_SESSION_REUSED" })
    ctx.cleanup()
  })

  test("R2-00-6：cleanup 抛异常 → session 必须进入可靠终态（REJECTED + residue evidence），异常不得逃逸状态机", async () => {
    const { ctx, snapshotId } = buildWorld()
    const materializer = new SnapshotMaterializer({
      getSnapshot: id => ctx.store.snapshots.get(id),
      getCasRecord: d => ctx.store.cas.record(d),
      readCasObject: d => ctx.store.cas.get(d),
    })
    const root = tmpRoot("cleanupthrow")
    const throwingBackend: NativeProjectionBackend = {
      id: "fixture-throwing", kind: "fixture",
      create(input) {
        const merged = join(input.projectionRoot, "merged-m")
        mkdirSync(merged, { mode: 0o700 })
        cpSync(input.lowerDir, merged, { recursive: true })
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
          backend: "fixture", mergedPath: merged, writeLayerPath: merged,
          assertReady: () => undefined,
          sealForScan: () => ({ sealedPath: merged }),
          cleanup: () => { throw new Error("cleanup exploded") },
        }
      },
    }
    const coord = new ProjectionCoordinator({
      store: ctx.store, materializer, backend: throwingBackend, projectionRoot: root,
      allowTestBackends: true,
    })
    const session = coord.start(makePlan(snapshotId))
    // FAILED 触发自动 cleanup → cleanup 抛异常 → 必须规范化终态。
    await coord.execute(session, { executable: "noop", args: [] }, async () => ({ exitCode: 1, timedOut: false, cancelled: false, violation: false }))
    // 可靠终态：REJECTED（或明确 failure 终态）+ cleanupState 记录失败。
    expect(["REJECTED", "FAILED"]).toContain(session.worldState)
    expect(session.cleanupState).toBeDefined()
    expect(session.cleanupState!.cleanupOk).toBe(false)
    expect(session.receipt).toBeDefined()
    ctx.cleanup()
  })

  test("R2-00-7：durable World commit 后，本地 delta divergence 不得把 session 标成 REJECTED", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = coordinator(ctx)
    const session = await sessionAtDeltaReady(coord, makePlan(snapshotId), ctx)
    // 篡改 session.delta 的 deltaDigest（本地 divergence）—— compareAndCommit
    // 仍会成功（World durable），随后 divergence 检查抛出。
    const originalDelta = session.delta!
    session.delta = { ...originalDelta, deltaDigest: "sha256:deadbeef" as CasDigest }
    const receipt = coord.commit(session)
    // World 已 durable commit → session 必须 COMMITTED（不得 REJECTED）。
    expect(receipt.newRevision).toBe(2n)
    expect(session.worldState).toBe("COMMITTED")
    expect(session.receipt!.worldState).toBe("COMMITTED")
    ctx.cleanup()
  })

  test("R2-08：同一 World 内 cross-snapshot/session receipt replay 拒绝（intent 绑定 snapshot/projection/nonce）", async () => {
    const { ctx, snapshotId } = buildWorld()
    const auth = fakeAuthority()
    const coord = coordinator(ctx, undefined, auth)
    const sessionA = await sessionAtDeltaReady(coord, makePlan(snapshotId), ctx)
    bindIntent(auth, sessionA)
    sessionA.outcome = {
      exitCode: 0, timedOut: false, cancelled: false, violation: false,
      executionReceiptId: auth.currentDigest()!,
      receiptBinding: { runId: "run-fake", nodeRunId: "run-fake:n1", cellId: "cell-fake", cellSpecDigest: "c".repeat(64), filesystemPolicyDigest: expectedProjectionFilesystemPolicyDigest(sessionA.plan, sessionA.mergedDir), workspaceHostRoot: sessionA.mergedDir },
    }
    const receiptA = coord.commit(sessionA)
    expect(receiptA.newRevision).toBe(2n)
    // 同一 World 的新 session（新 snapshot 派生）重放 sessionA 的 receipt → 拒绝。
    ctx.store.createSnapshot("world-c", "branch-main")
    const snapB = ctx.store.snapshots.getForRevision("world-c", "branch-main", 2n)!
    const coordB = coordinator(ctx, undefined, auth)
    const planB = validateWorldProjectionPlan({
      projectionId: `proj-replay2-${Math.random().toString(36).slice(2, 8)}`,
      worldId: "world-c", branchId: "branch-main", snapshotId: snapB.snapshotId, actor: "actor:test",
      mode: "native", writableRoots: ["src"], readonlyRoots: ["docs"], expectedOutputs: ["src/main.ts"], graphCompletionAllowed: false,
    })
    const sessionB = coordB.start(planB)
    await coordB.execute(
      sessionB,
      { executable: "noop", args: [] },
      mutateExecutor(merged => writeFileSync(join(merged, "src/main.ts"), "changed2\n")),
    )
    coordB.scan(sessionB)
    // 重放 sessionA 的 intent digest（同一 authority）。
    bindIntent(auth, sessionA)
    sessionB.outcome = {
      exitCode: 0, timedOut: false, cancelled: false, violation: false,
      executionReceiptId: auth.currentDigest()!,
      receiptBinding: { runId: "run-fake", nodeRunId: "run-fake:n1", cellId: "cell-fake", cellSpecDigest: "c".repeat(64), filesystemPolicyDigest: expectedProjectionFilesystemPolicyDigest(sessionB.plan, sessionB.mergedDir), workspaceHostRoot: sessionB.mergedDir },
    }
    try {
      coordB.commit(sessionB)
      throw new Error("expected cross-session replay rejection")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("EXECUTION_RECEIPT_REPLAY")
    }
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(2n)
    ctx.cleanup()
  })

  test("R2-02：tampered receipt digest → authority 拒绝（自洽校验）", async () => {
    const { RuntimeStateReceiptAuthority: RSRA } = require("../../../src/kernel/projection/receipt-authority") as typeof import("../../../src/kernel/projection/receipt-authority")
    const { RuntimeStateStore } = require("../../../src/runtime/linux/recovery/state-store") as typeof import("../../../src/runtime/linux/recovery/state-store")
    const { computeReceiptDigest } = require("../../../src/runtime/linux/receipt") as typeof import("../../../src/runtime/linux/receipt")
    const root = tmpRoot("tamper")
    const store = new RuntimeStateStore({ root })
    const auth = new RSRA(store)
    const runId = `run-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    const cellId = "cell-tampered"
    const dir = join(root, "runs", runId, "receipts")
    mkdirSync(dir, { recursive: true })
    const content = { ...fakeFinalReceipt(), projectionIntentDigest: "i".repeat(64) }
    const { receiptDigest: _rd, ...rest } = content
    const valid = { ...rest, receiptDigest: computeReceiptDigest(rest) }
    writeFileSync(join(dir, `${cellId}.json`), JSON.stringify(valid))
    expect(auth.getFinalReceipt(runId, cellId)).toBeDefined()
    // 篡改 exitCode（digest 不再自洽）→ 拒绝。
    const tampered = { ...valid, exitCode: 1 }
    writeFileSync(join(dir, `${cellId}.json`), JSON.stringify(tampered))
    expect(auth.getFinalReceipt(runId, cellId)).toBeUndefined()
  })

  test("R2-02：runtime receipt 删除后，World CAS 仍可恢复 receipt provenance", async () => {
    const { ctx, snapshotId } = buildWorld()
    const auth = fakeAuthority()
    const coord = coordinator(ctx, undefined, auth)
    const session = await sessionAtDeltaReady(coord, makePlan(snapshotId), ctx)
    bindIntent(auth, session)
    session.outcome = {
      exitCode: 0, timedOut: false, cancelled: false, violation: false,
      executionReceiptId: auth.currentDigest()!,
      receiptBinding: { runId: "run-fake", nodeRunId: "run-fake:n1", cellId: "cell-fake", cellSpecDigest: "c".repeat(64), filesystemPolicyDigest: expectedProjectionFilesystemPolicyDigest(session.plan, session.mergedDir), workspaceHostRoot: session.mergedDir },
    }
    const receipt = coord.commit(session)
    expect(receipt.newRevision).toBe(2n)
    // receipt 内容已在 World CAS（sha256: 前缀 digest）。
    const casDigest = `sha256:${auth.currentDigest()!}` as CasDigest
    expect(ctx.store.cas.has(casDigest)).toBe(true)
    const recovered = JSON.parse(ctx.store.cas.get(casDigest).toString("utf8")) as { cellId: string; runId: string }
    expect(recovered.cellId).toBe("cell-fake")
    expect(recovered.runId).toBe("run-fake")
    ctx.cleanup()
  })

  test("R2-01-8：一个 intent 只授权一个 cell（多 cell 只提交最后一张被禁止）", async () => {
    const { ctx, snapshotId } = buildWorld()
    const auth = fakeAuthority()
    const coord = coordinator(ctx, undefined, auth)
    const session = await sessionAtDeltaReady(coord, makePlan(snapshotId), ctx)
    bindIntent(auth, session)
    // 模拟「多 cell 只提交最后一张」：outcome 声称 cell-other（不是
    // authority 返回的 cell-fake）→ binding mismatch（最后一个 cell 的
    // receipt 无法通过 intent 绑定）。
    session.outcome = {
      exitCode: 0, timedOut: false, cancelled: false, violation: false,
      executionReceiptId: auth.currentDigest()!,
      receiptBinding: { runId: "run-fake", nodeRunId: "run-fake:n1", cellId: "cell-other", cellSpecDigest: "c".repeat(64), filesystemPolicyDigest: expectedProjectionFilesystemPolicyDigest(session.plan, session.mergedDir), workspaceHostRoot: session.mergedDir },
    }
    try {
      coord.commit(session)
      throw new Error("expected multi-cell rejection")
    } catch (error) {
      expect((error as ProjectionError).code).toMatch(/BINDING_MISMATCH|NOT_PERSISTED/)
    }
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("R2-03：cleanup truth 矩阵 —— 每个未证明字段单独拒绝", () => {
    const { RuntimeStateReceiptAuthority: RSRA } = require("../../../src/kernel/projection/receipt-authority") as typeof import("../../../src/kernel/projection/receipt-authority")
    const auth = new RSRA()
    const good = { cleanup: { processesRemaining: 0, mountsReleased: true, cgroupRemoved: true, worktreeRetained: false, cleanupVerified: true } }
    expect(auth.isCleanupFinalized({ ...fakeFinalReceipt(), ...good } as never)).toBe(true)
    const cases: Array<[Partial<SandboxReceipt["cleanup"]>, string]> = [
      [{ cleanupVerified: false }, "cleanupVerified=false"],
      [{ processesRemaining: -1 }, "processesRemaining=-1 (unmeasured)"],
      [{ processesRemaining: 3 }, "processesRemaining>0 (residue)"],
      [{ mountsReleased: false }, "mountsReleased=false"],
      [{ cgroupRemoved: false }, "cgroup/cgroupRemoved=false"],
    ]
    for (const [cleanup, label] of cases) {
      const receipt = { ...fakeFinalReceipt(), cleanup: { ...good.cleanup, ...cleanup } }
      expect(auth.isCleanupFinalized(receipt as never)).toBe(false)
      void label
    }
    // cleanup action 失败（receipt 顶层 cleanupActions）→ 拒绝。
    expect(
      auth.isCleanupFinalized({ ...fakeFinalReceipt(), cleanup: good.cleanup, cleanupActions: [{ ok: false, kind: "secrets" }] } as never),
    ).toBe(false)
    // container backend 需要 containerRemoved。
    const podman = { ...fakeFinalReceipt({ backend: "rootless-podman" }), cleanup: { ...good.cleanup, containerRemoved: false } }
    expect(auth.isCleanupFinalized(podman as never)).toBe(false)
    // degradation 未证明 → 拒绝。
    const degraded = { ...fakeFinalReceipt(), degradationReasons: ["bwrap unavailable"] }
    expect(auth.isCleanupFinalized(degraded as never)).toBe(false)
  })

  test("R2-07：duplicate path（不同 objectId 同 path）/ file-parent collision / file 缺 contentRef 全部拒绝", async () => {
    const ctx = createTestWorldStore()
    ctx.store.createWorld({ worldId: "world-r207", branchId: "branch-main", rootObjectId: "root-1", owner: "owner:test", purpose: "ak2 r2-07" })
    const d1 = ctx.store.cas.put(Buffer.from("one\n", "utf8"), "text/plain").digest
    // 两个不同 objectId 同一 path（put+put）→ 拒绝。
    expect(() =>
      ctx.store.compareAndCommit({
        worldId: "world-r207", branchId: "branch-main", baseRevision: 0n, actor: "a",
        mutations: [
          { type: "object.put", objectId: "id-a", objectType: "file", path: "x.txt", contentRef: d1 },
          { type: "object.put", objectId: "id-b", objectType: "file", path: "x.txt", contentRef: d1 },
        ],
      }),
    ).toThrow(/path collision/)
    // file-parent collision：a 是 file，同时创建 a/b.ts → 拒绝。
    expect(() =>
      ctx.store.compareAndCommit({
        worldId: "world-r207", branchId: "branch-main", baseRevision: 0n, actor: "a",
        mutations: [
          { type: "object.put", objectId: "id-a", objectType: "file", path: "a", contentRef: d1 },
          { type: "object.put", objectId: "id-b", objectType: "file", path: "a/b.ts", contentRef: d1 },
        ],
      }),
    ).toThrow(/file-parent collision/)
    // file 缺 contentRef → 拒绝。
    expect(() =>
      ctx.store.compareAndCommit({
        worldId: "world-r207", branchId: "branch-main", baseRevision: 0n, actor: "a",
        mutations: [{ type: "object.put", objectId: "id-a", objectType: "file", path: "x.txt" }],
      }),
    ).toThrow(/requires contentRef/)
    // World 未推进。
    expect(ctx.store.getWorld("world-r207")!.currentRevision).toBe(0n)
    ctx.cleanup()
  })

  test("R2-07-5：exact duplicate mutation 真正 canonical dedupe（单条 ledger event）", async () => {
    const ctx = createTestWorldStore()
    ctx.store.createWorld({ worldId: "world-dedupe", branchId: "branch-main", rootObjectId: "root-1", owner: "owner:test", purpose: "ak2 r2-07-5" })
    const d1 = ctx.store.cas.put(Buffer.from("x\n", "utf8"), "text/plain").digest
    const receipt = ctx.store.compareAndCommit({
      worldId: "world-dedupe", branchId: "branch-main", baseRevision: 0n, actor: "a",
      mutations: [
        { type: "object.put", objectId: "dedupe-id", objectType: "file", path: "a.txt", contentRef: d1 },
        { type: "object.put", objectId: "dedupe-id", objectType: "file", path: "a.txt", contentRef: d1 },
      ],
    })
    expect(receipt.newRevision).toBe(1n)
    // 只产生一条 ledger event（dedupe 后 mutations 单条）。
    const events = ctx.store.ledger.list("world-dedupe").filter(e => e.eventType === "world.object.updated")
    expect(events.length).toBe(1)
    ctx.cleanup()
  })

  test("P0-2：production commit 无 execution receipt → 拒绝；World 不变", async () => {
    const { ctx, snapshotId } = buildWorld()
    // R4-01：production backend + receiptless outcome → scan 阶段即拒绝
    // （finalized receipt/cleanup proof 缺失；比 commit 更早 fail-closed）。
    const backend = {
      id: "stub-production",
      kind: "fuse-overlayfs" as const,
      create(input: { lowerDir: string; projectionRoot: string; label: string }): ProjectionInstance {
        const merged = join(resolve(input.projectionRoot), "merged-stub")
        mkdirSync(merged, { mode: 0o700 })
        mkdirSync(join(merged, "src"), { recursive: true })
        return {
          backend: "fuse-overlayfs",
          mergedPath: merged,
          writeLayerPath: merged,
          assertReady: () => undefined,
          assertMountOwned: () => true,
          sealForScan: () => ({ sealedPath: merged }),
          cleanup: () => {
            rmSync(merged, { recursive: true, force: true })
            return true
          },
        }
      },
    }
    const coord = coordinator(ctx, backend, fakeAuthority())
    const session = coord.start(makePlan(snapshotId))
    await coord.execute(session, { executable: "noop", args: [] }, mutateExecutor(merged => {
      writeFileSync(join(merged, "src/main.ts"), "changed\n")
    }))
    try {
      coord.scan(session)
      throw new Error("expected EXECUTION_RECEIPT_REQUIRED")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("EXECUTION_RECEIPT_REQUIRED")
    }
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    expect(session.worldState).toBe("REJECTED")
    expect(session.receipt!.worldCommitReceipt).toBeUndefined()
    ctx.cleanup()
  })

  test("P0-2：forged receipt（未持久化）→ 拒绝；World 不变", async () => {
    const { ctx, snapshotId } = buildWorld()
    // authority 存在但无持久化 receipt（appendReceipt failure 等价）。
    const coord = coordinator(ctx, undefined, fakeAuthority({ hidden: true }))
    const session = await sessionAtDeltaReady(coord, makePlan(snapshotId), ctx)
    session.outcome = {
      exitCode: 0, timedOut: false, cancelled: false, violation: false,
      executionReceiptId: "f".repeat(64),
      receiptBinding: { runId: "run-fake", nodeRunId: "run-fake:n1", cellId: "cell-fake", cellSpecDigest: "c".repeat(64), filesystemPolicyDigest: expectedProjectionFilesystemPolicyDigest(session.plan, session.mergedDir), workspaceHostRoot: session.mergedDir },
    }
    try {
      coord.commit(session)
      throw new Error("expected EXECUTION_RECEIPT_NOT_PERSISTED")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("EXECUTION_RECEIPT_NOT_PERSISTED")
    }
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("P0-2：claim digest != final persisted digest → forged；World 不变", async () => {
    const { ctx, snapshotId } = buildWorld()
    const auth = fakeAuthority()
    const coord = coordinator(ctx, undefined, auth)
    const session = await sessionAtDeltaReady(coord, makePlan(snapshotId), ctx)
    bindIntent(auth, session)
    session.outcome = {
      exitCode: 0, timedOut: false, cancelled: false, violation: false,
      executionReceiptId: "f".repeat(64), // authority 返回 digest=a*64
      receiptBinding: { runId: "run-fake", nodeRunId: "run-fake:n1", cellId: "cell-fake", cellSpecDigest: "c".repeat(64), filesystemPolicyDigest: expectedProjectionFilesystemPolicyDigest(session.plan, session.mergedDir), workspaceHostRoot: session.mergedDir },
    }
    try {
      coord.commit(session)
      throw new Error("expected EXECUTION_RECEIPT_FORGED")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("EXECUTION_RECEIPT_FORGED")
    }
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("P0-2：another cell receipt（binding 不匹配）→ 拒绝；World 不变", async () => {
    const { ctx, snapshotId } = buildWorld()
    const auth = fakeAuthority()
    const coord = coordinator(ctx, undefined, auth)
    const session = await sessionAtDeltaReady(coord, makePlan(snapshotId), ctx)
    bindIntent(auth, session)
    session.outcome = {
      exitCode: 0, timedOut: false, cancelled: false, violation: false,
      executionReceiptId: auth.currentDigest()!,
      // binding 指向另一个 cell。
      receiptBinding: { runId: "run-other", nodeRunId: "run-other:n1", cellId: "cell-other", cellSpecDigest: "c".repeat(64), filesystemPolicyDigest: expectedProjectionFilesystemPolicyDigest(session.plan, session.mergedDir), workspaceHostRoot: session.mergedDir },
    }
    try {
      coord.commit(session)
      throw new Error("expected EXECUTION_RECEIPT_BINDING_MISMATCH")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("EXECUTION_RECEIPT_BINDING_MISMATCH")
    }
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("P0-2：pre-final receipt（cleanup 未 finalize）→ 拒绝；World 不变", async () => {
    const { ctx, snapshotId } = buildWorld()
    const auth = fakeAuthority({ cleanup: undefined as unknown as SandboxReceipt["cleanup"] })
    auth.setCleanupFinalized(false)
    const coord = coordinator(ctx, undefined, auth)
    const session = await sessionAtDeltaReady(coord, makePlan(snapshotId), ctx)
    bindIntent(auth, session)
    session.outcome = {
      exitCode: 0, timedOut: false, cancelled: false, violation: false,
      executionReceiptId: "a".repeat(64),
      receiptBinding: { runId: "run-fake", nodeRunId: "run-fake:n1", cellId: "cell-fake", cellSpecDigest: "c".repeat(64), filesystemPolicyDigest: expectedProjectionFilesystemPolicyDigest(session.plan, session.mergedDir), workspaceHostRoot: session.mergedDir },
    }
    try {
      coord.commit(session)
      throw new Error("expected EXECUTION_RECEIPT_NOT_FINALIZED")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("EXECUTION_RECEIPT_NOT_FINALIZED")
    }
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("P0-2：host-audit receipt → 拒绝；World 不变", async () => {
    const { ctx, snapshotId } = buildWorld()
    const auth = fakeAuthority({ backend: "host-audit" })
    const coord = coordinator(ctx, undefined, auth)
    const session = await sessionAtDeltaReady(coord, makePlan(snapshotId), ctx)
    bindIntent(auth, session)
    session.outcome = {
      exitCode: 0, timedOut: false, cancelled: false, violation: false,
      executionReceiptId: auth.currentDigest()!,
      receiptBinding: { runId: "run-fake", nodeRunId: "run-fake:n1", cellId: "cell-fake", cellSpecDigest: "c".repeat(64), filesystemPolicyDigest: expectedProjectionFilesystemPolicyDigest(session.plan, session.mergedDir), workspaceHostRoot: session.mergedDir },
    }
    try {
      coord.commit(session)
      throw new Error("expected HOST_AUDIT_ACCEPTED_AS_SECURITY_BOUNDARY")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("HOST_AUDIT_ACCEPTED_AS_SECURITY_BOUNDARY")
    }
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("P0-2：合法 final receipt → commit 成功并绑定 receipt", async () => {
    const { ctx, snapshotId } = buildWorld()
    const auth = fakeAuthority()
    const coord = coordinator(ctx, undefined, auth)
    const session = await sessionAtDeltaReady(coord, makePlan(snapshotId), ctx)
    bindIntent(auth, session)
    session.outcome = {
      exitCode: 0, timedOut: false, cancelled: false, violation: false,
      executionReceiptId: auth.currentDigest()!,
      receiptBinding: { runId: "run-fake", nodeRunId: "run-fake:n1", cellId: "cell-fake", cellSpecDigest: "c".repeat(64), filesystemPolicyDigest: expectedProjectionFilesystemPolicyDigest(session.plan, session.mergedDir), workspaceHostRoot: session.mergedDir },
    }
    const receipt = coord.commit(session)
    expect(receipt.newRevision).toBe(2n)
    expect(receipt.executionReceiptIds).toEqual([`sha256:${auth.currentDigest()!}`])
    expect(session.worldState).toBe("COMMITTED")
    ctx.cleanup()
  })

  test("P1-2：FAILED/CANCELLED/timeout/violation 全部自动 cleanup（不调用 cancel）", async () => {
    const variants: Array<{ name: string; outcome: { exitCode: number; timedOut: boolean; cancelled: boolean; violation: boolean }; expected: "FAILED" | "CANCELLED" }> = [
      { name: "exitCode!=0", outcome: { exitCode: 3, timedOut: false, cancelled: false, violation: false }, expected: "FAILED" },
      { name: "timeout(exitCode=0)", outcome: { exitCode: 0, timedOut: true, cancelled: false, violation: false }, expected: "FAILED" },
      { name: "violation(exitCode=0)", outcome: { exitCode: 0, timedOut: false, cancelled: false, violation: true }, expected: "FAILED" },
      { name: "cancelled", outcome: { exitCode: 1, timedOut: false, cancelled: true, violation: false }, expected: "CANCELLED" },
    ]
    for (const variant of variants) {
      const { ctx, snapshotId } = buildWorld()
      const coord = coordinator(ctx)
      const session = coord.start(makePlan(snapshotId))
      const root = session.projectionRoot
      await coord.execute(session, { executable: "noop", args: [] }, async () => variant.outcome)
      // 不调用 cancel —— 直接检查 cleanup 已完成。
      expect(session.executionState).toBe(variant.expected)
      expect(session.cleanupState).toEqual({ cleanupOk: true, rootRemoved: true })
      expect(existsSync(root)).toBe(false)
      expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
      ctx.cleanup()
    }
  })

  test("P1-3：after_commit_before_response fault → World 已 durable commit → session COMMITTED（不 REJECTED）", async () => {
    let faultFired = false
    let commits = 0
    const ctx = createTestWorldStore({
      faultInjector: point => {
        if (point === "after_commit_before_response" && ++commits >= 2) {
          faultFired = true
          throw new Error("injected fault: response lost")
        }
      },
    })
    ctx.store.createWorld({ worldId: "world-fault", branchId: "branch-main", rootObjectId: "root-1", owner: "owner:test", purpose: "ak2 p1-3" })
    const digest = ctx.store.cas.put(Buffer.from("v1\n", "utf8"), "text/plain").digest
    ctx.store.compareAndCommit({
      worldId: "world-fault", branchId: "branch-main", baseRevision: 0n, actor: "a",
      mutations: [
        { type: "object.put", objectId: "d1", objectType: "directory", path: "src" },
        { type: "object.put", objectId: "f1", objectType: "file", path: "src/main.ts", contentRef: digest },
      ],
    })
    ctx.store.createSnapshot("world-fault", "branch-main")
    const snapshot = ctx.store.snapshots.getForRevision("world-fault", "branch-main", 1n)!
    const materializer = new SnapshotMaterializer({
      getSnapshot: id => ctx.store.snapshots.get(id),
      getCasRecord: d => ctx.store.cas.record(d),
      readCasObject: d => ctx.store.cas.get(d),
    })
    const coord = new ProjectionCoordinator({
      store: ctx.store,
      materializer,
      backend: new CopyProjectionFixtureBackend(),
      projectionRoot: tmpRoot("p13"),
      allowTestBackends: true,
    })
    const plan = validateWorldProjectionPlan({
      projectionId: `proj-p13-${Math.random().toString(36).slice(2, 8)}`,
      worldId: "world-fault", branchId: "branch-main", snapshotId: snapshot.snapshotId, actor: "a",
      mode: "native", writableRoots: ["src"], readonlyRoots: [], expectedOutputs: ["src/main.ts"], graphCompletionAllowed: false,
    })
    const session = await sessionAtDeltaReady(coord, plan, ctx)
    const receipt = coord.commit(session)
    expect(faultFired).toBe(true)
    // World truth 优先：commit 已 durable → session COMMITTED 而非 REJECTED。
    expect(receipt.newRevision).toBe(2n)
    expect(session.worldState).toBe("COMMITTED")
    expect(session.receipt!.worldState).toBe("COMMITTED")
    expect(ctx.store.getWorld("world-fault")!.currentRevision).toBe(2n)
    ctx.cleanup()
  })

  test("P2-1：cleanup 前验证 root 所有权 —— 篡改 session.projectionRoot → 拒绝删除且不删他人目录", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = coordinator(ctx)
    const session = coord.start(makePlan(snapshotId))
    // 把 session.projectionRoot 指向 baseProjectionRoot 的兄弟（他人目录）。
    const other = tmpRoot("other")
    ;(session as { projectionRoot: string }).projectionRoot = other
    session.cleanupState = coord.cancel(session)
    // 所有权验证失败 → cleanupOk=false（不是 true+false），residue 保留。
    expect(session.cleanupState!.cleanupOk).toBe(false)
    expect(session.cleanupState!.rootRemoved).toBe(false)
    expect(existsSync(other)).toBe(true) // 他人目录未被删除
    ctx.cleanup()
  })

  test("P2-6：exitCode=0+timedOut / exitCode=0+violation → receipt executionState FAILED（不是 COMPLETED）", async () => {
    for (const variant of [
      { exitCode: 0, timedOut: true, cancelled: false, violation: false },
      { exitCode: 0, timedOut: false, cancelled: false, violation: true },
    ]) {
      const { ctx, snapshotId } = buildWorld()
      const coord = coordinator(ctx)
      const session = coord.start(makePlan(snapshotId))
      await coord.execute(session, { executable: "noop", args: [] }, async () => ({ ...variant }))
      expect(session.executionState).toBe("FAILED")
      // 终态 receipt（REJECTED 路径经由 scan 失败触发或直接构造）：
      // buildReceipt 直接使用 session.executionState。
      const receipt = coord.buildReceipt(session, "REJECTED", "execution failed")
      expect(receipt.executionState).toBe("FAILED")
      ctx.cleanup()
    }
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
          sealForScan: () => ({ sealedPath: merged }),
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
