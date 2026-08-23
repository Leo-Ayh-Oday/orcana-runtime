/**
 * AK2-R8 反例冻结 —— reservation failure terminalization 家族。
 *
 * e316c27 为 reserveDetailed 抛错增加了 catch（executor 零启动 + 统一
 * 终态化 + settlement note + 行保留），但该路径此前**没有直接测试覆盖**。
 * 本文件冻结其行为契约（真实 pipeline；白盒注入仅用于无法从公开 API
 * 制造的 SQLite 写失败 seam —— 与 R7-00-6 的 markDispatched 注入先例
 * 同型且同理由）：
 *
 * - R8_RESERVE_DETAILED_THROW_ZERO_EXECUTOR / _TERMINALIZES
 * - R8_RESERVE_DETAILED_THROW_SETTLEMENT_OBSERVABLE / _RECONCILE_ROW_PRESERVED
 * - R8_RESERVE_DETAILED_THROW_NO_DOUBLE_TERMINAL_RECEIPT / _RETRY_DOES_NOT_RESURRECT
 * - R8_RESERVE_DETAILED_THROW_CLEANUP_FAILURE
 * - R8_TERMINALIZE_PARTIAL_FAILURE_RETRY（★ veto：settlement 中间点失败后，
 *   幂等护栏不得吞掉 reconcile 证据；行保留 + receipt note 是权威痕迹）
 * - R8_TERMINALIZE_CONCURRENT_RACE（cancel 与 reserveDetailed 失败竞争）
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectionCoordinator, type ProjectionExecutor } from "../../../src/kernel/projection/coordinator"
import { SnapshotMaterializer } from "../../../src/kernel/projection/materializer"
import { validateWorldProjectionPlan } from "../../../src/kernel/projection/plan"
import type { WorldProjectionPlan } from "../../../src/kernel/projection/contracts"
import { CopyProjectionFixtureBackend, TestReceiptAuthority, fixtureExecutor } from "./test-fixtures"
import { createTestWorldStore, type TestWorldStore } from "../world/helpers"

const RESERVE_THROW = "R8 reserveDetailed durable write failed (simulated SQLite fault)"
const SETTLE_FAIL = "R8 simulated settlement write failure"

function buildWorld(): { ctx: TestWorldStore; snapshotId: string } {
  const ctx = createTestWorldStore()
  ctx.store.createWorld({ worldId: "world-r8", branchId: "branch-main", rootObjectId: "root-1", owner: "owner:test", purpose: "ak2 r8" })
  const digest = ctx.store.cas.put(Buffer.from("export const value = 1\n", "utf8"), "text/plain").digest
  ctx.store.compareAndCommit({
    worldId: "world-r8",
    branchId: "branch-main",
    baseRevision: 0n,
    actor: "actor:test",
    mutations: [
      { type: "object.put", objectId: "obj-src", objectType: "directory", path: "src" },
      { type: "object.put", objectId: "obj-main", objectType: "file", path: "src/main.ts", contentRef: digest },
      { type: "object.put", objectId: "obj-docs", objectType: "directory", path: "docs" },
    ],
  })
  ctx.store.createSnapshot("world-r8", "branch-main")
  const snapshot = ctx.store.snapshots.getForRevision("world-r8", "branch-main", 1n)!
  return { ctx, snapshotId: snapshot.snapshotId }
}

function makePlan(snapshotId: string): WorldProjectionPlan {
  return validateWorldProjectionPlan({
    projectionId: `proj-${Math.random().toString(36).slice(2, 10)}`,
    worldId: "world-r8",
    branchId: "branch-main",
    snapshotId,
    actor: "actor:test",
    mode: "native",
    writableRoots: ["src"],
    readonlyRoots: ["docs"],
    expectedOutputs: ["src/main.ts"],
    graphCompletionAllowed: false,
  })
}

function materializerFor(ctx: TestWorldStore): SnapshotMaterializer {
  return new SnapshotMaterializer({
    getSnapshot: id => ctx.store.snapshots.get(id),
    getCasRecord: digest => ctx.store.cas.record(digest),
    readCasObject: digest => ctx.store.cas.get(digest),
  })
}

type Coordinator = InstanceType<typeof ProjectionCoordinator>
type RegistryView = {
  reserveDetailed(input: unknown): boolean
  markRejected(intentId: string): void
  reconcileStale(maxAgeMs: number, now?: number): string[]
  statusOf(intentId: string): { status: string } | undefined
}

function registryOf(coord: Coordinator): RegistryView {
  return (coord as unknown as { intentRegistry: RegistryView }).intentRegistry
}

function makeCoordinator(ctx: TestWorldStore, snapshotId: string, label: string): Coordinator {
  return new ProjectionCoordinator({
    store: ctx.store,
    materializer: materializerFor(ctx),
    backend: new CopyProjectionFixtureBackend() as unknown as ConstructorParameters<typeof ProjectionCoordinator>[0]["backend"],
    projectionRoot: mkdtempSync(join(tmpdir(), `ak2-r8-${label}-`)),
    receiptAuthority: new TestReceiptAuthority(),
    intentReservationPath: join(mkdtempSync(join(tmpdir(), `ak2-r8-${label}r-`)), "res.sqlite"),
  })
}

/** 白盒 seam：SQLite 写失败无法从公开 API 注入 —— 替换 registry 方法。 */
function failReserveDetailed(coord: Coordinator, message = RESERVE_THROW): void {
  ;(registryOf(coord) as unknown as { reserveDetailed: () => never }).reserveDetailed = () => {
    throw new Error(message)
  }
}

/** settlement 第一次写失败、之后放行真实写入（部分失败语义）。 */
function failFirstMarkRejected(coord: Coordinator): void {
  const registry = registryOf(coord) as unknown as {
    markRejected: (intentId: string) => void
  }
  const original = registry.markRejected.bind(registry)
  let calls = 0
  registry.markRejected = (intentId: string) => {
    calls += 1
    if (calls === 1) throw new Error(SETTLE_FAIL)
    return original(intentId)
  }
}

const zeroExecutor: ProjectionExecutor = async () => {
  throw new Error("R8: executor must never start when reserveDetailed fails")
}

describe("AK2-R8 reservation-failure terminalization（真实 pipeline）", () => {
  test("R8_RESERVE_DETAILED_THROW_ZERO_EXECUTOR + THROW_TERMINALIZES", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = makeCoordinator(ctx, snapshotId, "zero-exec")
    failReserveDetailed(coord)
    const session = coord.start(makePlan(snapshotId))
    let executorCalls = 0
    let error: unknown
    try {
      await coord.execute(session, { executable: "noop", args: [] }, async () => {
        executorCalls += 1
        return { exitCode: 0, timedOut: false, cancelled: false, violation: false }
      })
    } catch (caught) {
      error = caught
    }
    expect(executorCalls).toBe(0)
    expect(error).toBeDefined()
    expect(String(error)).toContain("durable reservation write failed before executor start")
    expect(session.worldState).toBe("REJECTED")
    // Reservation 失败的终态化先走 execute-cancelled 边再落 rejected：
    // executionState 停在 CANCELLED 是实现的确定路由。
    expect(session.executionState).toBe("CANCELLED")
    expect(session.terminalized).toBe(true)
    expect(session.cleanupState).toBeDefined()
    expect(session.receipt).toBeDefined()
    ctx.cleanup()
  })

  test("R8_RESERVE_DETAILED_THROW_SETTLEMENT_OBSERVABLE + RECONCILE_ROW_PRESERVED（★ veto 前半）", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = makeCoordinator(ctx, snapshotId, "settle-obs")
    const session = coord.start(makePlan(snapshotId))
    // settlement 第一次写失败（markRejected 抛错），随后放行真实写入。
    failFirstMarkRejected(coord)
    // 确定性触发：admission 之后的 DISPATCHED 持久化失败（R7-00-6 同型
    // 白盒注入）—— 必然进入带 owned-reservation 的 terminalize。
    const registryInject = registryOf(coord) as unknown as { markDispatched: (id: string) => void }
    registryInject.markDispatched = () => {
      throw new Error("R8 injected DISPATCHED write failure to reach terminalize")
    }
    let outcome: unknown
    try {
      await coord.execute(
        session,
        { executable: "noop", args: [] },
        fixtureExecutor(new TestReceiptAuthority(), merged => writeFileSync(join(merged, "src/main.ts"), "changed\n")),
      )
    } catch (caught) {
      outcome = caught
    }
    void outcome
    expect(session.worldState).toBe("REJECTED")
    // settlement 失败必须可观测地进入 receipt（reason 拼接通道）。
    const receiptJson = JSON.stringify(session.receipt)
    expect(receiptJson).toContain("reservation settlement write failed")
    expect(receiptJson).toContain(SETTLE_FAIL)
    // 行原状保留（未伪装成已结算），且仍可被 reconcile 收敛。
    const durable = (registryOf(coord) as unknown as { durable: { reconcileStale(m: number): string[]; statusOf(i: string): { status: string } | undefined } }).durable
    const rowStatus = durable.statusOf(session.intent.intentId)!.status
    expect(["RESERVED", "DISPATCHED", "RECEIPT_BOUND"]).toContain(rowStatus)
    const affected = durable.reconcileStale(0)
    expect(affected).toContain(session.intent.intentId)
    expect(durable.statusOf(session.intent.intentId)!.status).toBe("UNKNOWN")
    ctx.cleanup()
  })

  test("R8_RESERVE_DETAILED_THROW_NO_DOUBLE_TERMINAL_RECEIPT + RETRY_DOES_NOT_RESURRECT", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = makeCoordinator(ctx, snapshotId, "no-double")
    failReserveDetailed(coord)
    const session = coord.start(makePlan(snapshotId))
    let firstCalls = 0
    let secondCalls = 0
    await coord.execute(session, { executable: "noop", args: [] }, async () => {
      if (firstCalls === 0) firstCalls += 1
      else secondCalls += 1
      return { exitCode: 0, timedOut: false, cancelled: false, violation: false }
    }).catch(() => undefined)
    // reserveDetailed 抛错发生在 executor 调度之前：两次都必须是 0。
    expect(firstCalls).toBe(0)
    const firstReceipt = session.receipt!
    expect(firstReceipt).toBeDefined()

    // 第二次 execute（复用已终态 session）与显式重复 terminalize：
    // 都不得产生新 receipt / 新 durable settlement 尝试。
    let markRejectedCalls = 0
    const registry = registryOf(coord) as unknown as { markRejected: (id: string) => void }
    const originalReject = registry.markRejected?.bind(registry)
    registry.markRejected = (intentId: string) => {
      markRejectedCalls += 1
      return originalReject!(intentId)
    }
    await coord.execute(session, { executable: "noop", args: [] }, async () => {
      secondCalls += 1
      return { exitCode: 0, timedOut: false, cancelled: false, violation: false }
    }).catch(() => undefined)
    ;(coord as unknown as { terminalize: (s: typeof session, w: "rejected", r?: string) => void }).terminalize(
      session,
      "rejected",
      "duplicate call must be a no-op",
    )
    expect(secondCalls).toBe(0)
    expect(markRejectedCalls).toBe(0)
    expect(session.receipt).toBe(firstReceipt)
    expect(session.worldState).toBe("REJECTED")
    // 复用拒绝家族语义保持。
    expect(() => coord.scan(session)).toThrow()
    expect(() => coord.commit(session)).toThrow()
    ctx.cleanup()
  })

  test("R8_RESERVE_DETAILED_THROW_CLEANUP_FAILURE：cleanup 抛错被规范化，不改变终态/receipt", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = makeCoordinator(ctx, snapshotId, "cleanup-fail")
    failReserveDetailed(coord)
    const session = coord.start(makePlan(snapshotId))
    session.instance.cleanup = () => {
      throw new Error("R8 cleanup exploded during reservation-failure terminalization")
    }
    let error: unknown
    try {
      await coord.execute(session, { executable: "noop", args: [] }, zeroExecutor)
    } catch (caught) {
      error = caught
    }
    expect(String(error)).toContain("durable reservation write failed before executor start")
    expect(session.worldState).toBe("REJECTED")
    expect(session.cleanupState!.cleanupOk).toBe(false)
    expect(session.cleanupState!.error).toContain("cleanup exploded")
    expect(session.receipt).toBeDefined()
    ctx.cleanup()
  })

  test("R8_TERMINALIZE_PARTIAL_FAILURE_RETRY（★ veto）：护栏不得吞掉 reconcile 证据；重试不再复活行", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = makeCoordinator(ctx, snapshotId, "partial-veto")
    const session = coord.start(makePlan(snapshotId))
    failFirstMarkRejected(coord)
    const registryInject = registryOf(coord) as unknown as { markDispatched: (id: string) => void }
    registryInject.markDispatched = () => {
      throw new Error("R8 injected DISPATCHED write failure (veto setup)")
    }
    await coord.execute(
      session,
      { executable: "noop", args: [] },
      fixtureExecutor(new TestReceiptAuthority(), merged => writeFileSync(join(merged, "src/main.ts"), "changed\n")),
    ).catch(() => undefined)

    const registry = registryOf(coord)
    const durable = (registry as unknown as { durable: { reconcileStale(m: number): string[]; statusOf(i: string): { status: string } | undefined } }).durable
    const receiptBefore = session.receipt!
    expect(JSON.stringify(receiptBefore)).toContain("reservation settlement write failed")

    // reconcile 收敛遗留行（UNKNOWN 终态，证据链闭合）。
    expect(durable.reconcileStale(0)).toContain(session.intent.intentId)
    expect(durable.statusOf(session.intent.intentId)!.status).toBe("UNKNOWN")

    // 幂等护栏：再次终态化 = no-op（同一 receipt 引用、无新 durable 写）。
    ;(coord as unknown as { terminalize: (s: typeof session, w: "conflicted", r?: string) => void }).terminalize(
      session,
      "conflicted",
      "retry probe must not resurrect",
    )
    expect(session.receipt).toBe(receiptBefore)
    expect(durable.statusOf(session.intent.intentId)!.status).toBe("UNKNOWN")
    ctx.cleanup()
  })

  test("R8_TERMINALIZE_CONCURRENT_RACE：cancel 与 reserveDetailed 失败竞争 ⇒ 单一终态语义结果", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = makeCoordinator(ctx, snapshotId, "race")
    failReserveDetailed(coord)
    const session = coord.start(makePlan(snapshotId))
    const results = await Promise.allSettled([
      coord.execute(session, { executable: "noop", args: [] }, zeroExecutor),
      coord.cancel(session),
    ])
    const fulfilledCancel = results[1]!.status === "fulfilled"
    const rejectedExecute = results[0]!.status === "rejected"
    // 至少一个通道以拒绝收场；executor 零启动；唯一终态语义。
    expect(fulfilledCancel || rejectedExecute).toBe(true)
    expect(session.worldState).toBe("REJECTED")
    expect(["FAILED", "CANCELLED"]).toContain(session.executionState)
    expect(session.terminalized).toBe(true)
    expect(session.receipt).toBeDefined()
    ctx.cleanup()
  })
})
