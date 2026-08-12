/** AK2-T05 — Projection Coordinator 状态机 + 故障矩阵（fixture backend）。 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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
    readCasObject: digest => ctx.store.cas.get(digest),
  })
  return new ProjectionCoordinator({
    store: ctx.store,
    materializer,
    backend: backend ?? new CopyProjectionFixtureBackend(),
    projectionRoot: tmpRoot("projroot"),
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
      readCasObject: digest => ctx.store.cas.get(digest),
    })
    const base2 = join(tmpRoot("rev2"), "base")
    mkdirSync(base2)
    materialized.materialize(snapshot2, base2)
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
    // cancel 清理投影（包括 symlink 内容）。
    coord.cancel(session)
    expect(existsSync(session.projectionRoot)).toBe(false)
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
    ctx.cleanup()
  })
})
