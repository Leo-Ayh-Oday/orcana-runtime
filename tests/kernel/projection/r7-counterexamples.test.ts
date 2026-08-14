/**
 * AK2-R7 Correction Gate —— projection 层 R7-00 先红反例冻结。
 *
 * R7-00 反例（每个都必须因目标缺陷在基线 421f1a7 上失败）：
 *
 * - R7-00-1: 公开调用 markTestFixtureBackend() / markTestHarnessReceiptAuthority()
 *   给任意普通对象加 brand，必须不能获得 World commit（R7-01 删除生产
 *   导出面的公开 test 授权函数）。
 * - R7-00-2: production export inventory 必须检查全部公共出口与直接子模块
 *   出口（不能只检查 index.ts 的旧 forbiddenNames）。
 * - R7-00-3: coordinator 生成的 boundCommand 原样交给
 *   LinuxBrokerProjectionExecutor.execute() —— 当前 expected spec digest
 *   不一致（adapter authority 身份 envelope 携带 agentId/assignmentId 时
 *   误拒）必须 RED；修复后必须是确定性的 envelope 契约错误或成功。
 * - R7-00-4: RESERVED → UNKNOWN、DISPATCHED → UNKNOWN stale reconciliation
 *   （当前 reconcileStale 直接抛非法转移）。
 * - R7-00-5: 两个 SQLite connection 并发冲突转换 —— 陈旧状态读取的转换
 *   不得覆盖或复活终态（当前 UPDATE 无 status 条件）。
 * - R7-00-6: reservation/markDispatched 写入抛错时 executor 必须从未启动，
 *   session 必须终态化并 cleanup（当前 executor 先被调度）。
 * - R7-00-7: mount 消失后 upper/work 被替换为 foreign marker 目录；
 *   cleanup 不得删除（当前删除分支不复核身份）。
 * - R7-00-8: 整个 projection root 被 rename 后 cleanup 不得报告
 *   rootRemoved=true，World commit 不得成功（当前 existsSync 缺失即当
 *   已删除）。
 * - R7-00-9: cleanup 抛异常后 retained child fd 不得泄漏（当前
 *   closeSessionRootFd 在 cleanup() 抛错时不可达）。
 */

import { afterEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ProjectionError } from "../../../src/kernel/projection/contracts"
import { ProjectionCoordinator, type ProjectionExecutor } from "../../../src/kernel/projection/coordinator"
import { SnapshotMaterializer } from "../../../src/kernel/projection/materializer"
import { CopyProjectionFixtureBackend, TestReceiptAuthority, fixtureExecutor } from "./test-fixtures"
import { FuseOverlayfsProjectionBackend, probeNativeBackends, type NativeProjectionBackend, type ProjectionInstance } from "../../../src/kernel/projection/backend"
import { DurableIntentReservation } from "../../../src/kernel/projection/intent-reservation"
import type { ProjectionReceiptAuthority } from "../../../src/kernel/projection/receipt-authority"
import { validateWorldProjectionPlan, type WorldProjectionPlanInput } from "../../../src/kernel/projection/plan"
import { createTestWorldStore } from "../world/helpers"
import type { WorldProjectionPlan } from "../../../src/kernel/projection/contracts"
import type { SandboxReceipt } from "../../../src/runtime/linux/contracts"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ak2-r7-${label}-`))
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 已删
    }
  })
  return dir
}

/** revision 0 world + src/docs（R6-03：plan 声明的 roots 必须在 World 中）。 */
function buildWorld(): { ctx: ReturnType<typeof createTestWorldStore>; snapshotId: string } {
  const ctx = createTestWorldStore()
  ctx.store.createWorld({ worldId: "world-r7", branchId: "branch-main", rootObjectId: "root-1", owner: "owner:test", purpose: "ak2 r7" })
  const digest = ctx.store.cas.put(Buffer.from("export const value = 1\n", "utf8"), "text/plain").digest
  ctx.store.compareAndCommit({
    worldId: "world-r7",
    branchId: "branch-main",
    baseRevision: 0n,
    actor: "actor:test",
    mutations: [
      { type: "object.put", objectId: "obj-src", objectType: "directory", path: "src" },
      { type: "object.put", objectId: "obj-main", objectType: "file", path: "src/main.ts", contentRef: digest },
      { type: "object.put", objectId: "obj-docs", objectType: "directory", path: "docs" },
    ],
  })
  ctx.store.createSnapshot("world-r7", "branch-main")
  const snapshot = ctx.store.snapshots.getForRevision("world-r7", "branch-main", 1n)!
  return { ctx, snapshotId: snapshot.snapshotId }
}

function makePlan(snapshotId: string, overrides: Partial<WorldProjectionPlanInput> = {}): WorldProjectionPlan {
  return validateWorldProjectionPlan({
    projectionId: `proj-${Math.random().toString(36).slice(2, 10)}`,
    worldId: "world-r7",
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

function materializerFor(ctx: ReturnType<typeof createTestWorldStore>): SnapshotMaterializer {
  return new SnapshotMaterializer({
    getSnapshot: id => ctx.store.snapshots.get(id),
    getCasRecord: digest => ctx.store.cas.record(digest),
    readCasObject: digest => ctx.store.cas.get(digest),
  })
}

/** 功能性 stub production backend（plain object —— 无任何 test-only brand）。 */
function stubProductionBackend(): NativeProjectionBackend {
  return {
    id: "stub-production",
    kind: "fuse-overlayfs",
    create(input: { lowerDir: string; projectionRoot: string; label: string }): ProjectionInstance {
      const merged = join(resolve(input.projectionRoot), "merged-stub")
      mkdirSync(merged, { mode: 0o700 })
      mkdirSync(join(merged, "src"), { recursive: true })
      mkdirSync(join(merged, "docs"), { recursive: true })
      writeFileSync(join(merged, "src/main.ts"), "export const value = 1\n")
      return {
        backend: "fuse-overlayfs",
        mergedPath: merged,
        writeLayerPath: merged,
        assertReady: () => undefined,
        assertMountOwned: () => true,
        sealForScan: () => ({ sealedPath: merged }),
        cleanup: () => {
          try {
            rmSync(merged, { recursive: true, force: true })
          } catch {
            // best-effort
          }
          return true
        },
      }
    },
  }
}

describe("AK2-R7 反例冻结（projection 层）", () => {
  test("R7-00-1：公开 mark 函数给任意对象加 brand → 不得获得 World commit", async () => {
    const { ctx, snapshotId } = buildWorld()
    const backendMod = require("../../../src/kernel/projection/backend") as Record<string, unknown>
    const authorityMod = require("../../../src/kernel/projection/receipt-authority") as Record<string, unknown>
    const markBackend = backendMod.markTestFixtureBackend
    const markAuthority = authorityMod.markTestHarnessReceiptAuthority
    if (typeof markBackend !== "function" || typeof markAuthority !== "function") {
      // R7-01 后：生产导出面不再存在公开 mark —— 任意普通对象无法被
      // brand；production coordinator 对普通对象 commit 必须 fail-closed。
      const backend = stubProductionBackend()
      const inner = new TestReceiptAuthority()
      const authority = {
        trustLevel: "test-harness" as const,
        getFinalReceipt: (runId: string, cellId: string) => inner.getFinalReceipt(runId, cellId),
        isCleanupFinalized: (receipt: SandboxReceipt) => inner.isCleanupFinalized(receipt),
      } as ProjectionReceiptAuthority
      const coord = new ProjectionCoordinator({
        store: ctx.store,
        materializer: materializerFor(ctx),
        backend,
        projectionRoot: tmpRoot("r7-00-1"),
        receiptAuthority: authority,
        intentReservationPath: join(tmpRoot("r7-00-1r"), "res.sqlite"),
      })
      const session = coord.start(makePlan(snapshotId))
      await coord.execute(session, { executable: "noop", args: [] }, async () => ({
        exitCode: 0, timedOut: false, cancelled: false, violation: false,
      }))
      coord.scan(session)
      let blocked = false
      try {
        coord.commit(session)
      } catch (error) {
        blocked = (error as ProjectionError).code === "PRODUCTION_WORLD_COMMIT_BLOCKED"
      }
      expect(blocked).toBe(true)
      if (!blocked) {
        throw new Error("R7-00-1 RED: plain objects obtained a production World commit (mark functions still grant authorization from the production export surface)")
      }
      expect(ctx.store.getWorld("world-r7")!.currentRevision).toBe(1n)
      ctx.cleanup()
      return
    }
    // 基线：公开 mark 存在 —— 给任意普通对象 brand 后 commit 必须被拒绝。
    const backend = stubProductionBackend()
    markBackend(backend)
    const inner = new TestReceiptAuthority()
    const authority = {
      trustLevel: "test-harness" as const,
      getFinalReceipt: (runId: string, cellId: string) => inner.getFinalReceipt(runId, cellId),
      isCleanupFinalized: (receipt: SandboxReceipt) => inner.isCleanupFinalized(receipt),
      recordFinalReceipt: (intent: unknown, cellId: string, overrides?: Partial<SandboxReceipt>) =>
        (inner as unknown as { recordFinalReceipt: (i: unknown, c: string, o?: Partial<SandboxReceipt>) => SandboxReceipt }).recordFinalReceipt(intent, cellId, overrides),
    } as ProjectionReceiptAuthority & { recordFinalReceipt: (intent: unknown, cellId: string, overrides?: Partial<SandboxReceipt>) => SandboxReceipt }
    markAuthority(authority as never)
    const coord = new ProjectionCoordinator({
      store: ctx.store,
      materializer: materializerFor(ctx),
      backend,
      projectionRoot: tmpRoot("r7-00-1b"),
      receiptAuthority: authority as never,
      intentReservationPath: join(tmpRoot("r7-00-1br"), "res.sqlite"),
    })
    const session = coord.start(makePlan(snapshotId))
    await coord.execute(
      session,
      { executable: "noop", args: [] },
      fixtureExecutor(authority as never, merged => writeFileSync(join(merged, "src/main.ts"), "changed\n")),
    )
    coord.scan(session)
    let blocked = false
    let committedRevision: bigint | undefined
    try {
      committedRevision = (coord.commit(session) as { newRevision: bigint }).newRevision
    } catch (error) {
      blocked = (error as ProjectionError).code === "PRODUCTION_WORLD_COMMIT_BLOCKED"
    }
    expect(blocked).toBe(true)
    if (!blocked) {
      throw new Error(`R7-00-1 RED: public mark functions granted a production World commit to arbitrary plain objects (revision ${String(committedRevision)})`)
    }
    expect(ctx.store.getWorld("world-r7")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("R7-00-2：production export inventory 覆盖全部公共出口与直接子模块出口", () => {
    const projectionDir = join(process.cwd(), "src", "kernel", "projection")
    // 完整禁止规则：任何 test-authorization / fixture / test-harness 命名
    // 能力都不得从生产模块（含直接子模块）导出。
    const forbiddenPatterns: Array<RegExp> = [
      /^markTest/i,
      /^isTest(Harness|Fixture)/i,
      /^Test[A-Z]/,
      /^Copy[A-Za-z]*Fixture/i,
      /^fixture/i,
      /FIXTURE_/,
      /TEST_HARNESS/,
      /^createFixture/i,
      /allowTestBackends/i,
    ]
    const files = readdirSync(projectionDir)
      .filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "index.ts")
      .sort()
    const violations: string[] = []
    for (const file of files) {
      const modulePath = join(projectionDir, file)
      // 直接子模块导出面（不是只查 index.ts 的旧 forbiddenNames）。
      const mod = require(modulePath) as Record<string, unknown>
      for (const name of Object.keys(mod)) {
        if (forbiddenPatterns.some(pattern => pattern.test(name))) {
          violations.push(`${file} exports ${name}`)
        }
      }
    }
    // 公共 barrel（index.ts）文本也不得 re-export 任何禁止命名。
    const indexSource = readFileSync(join(projectionDir, "index.ts"), "utf8")
    for (const pattern of forbiddenPatterns) {
      if (indexSource.match(pattern)) {
        violations.push(`index.ts matches ${pattern}`)
      }
    }
    expect(violations).toEqual([])
    if (violations.length > 0) {
      throw new Error(`R7-00-2 RED: production export inventory found test-authorization capabilities: ${violations.join("; ")}`)
    }
    // 生产能力仍在。
    const exported = Object.keys(require("../../../src/kernel/projection/index"))
    expect(exported.includes("createProductionProjectionBackend")).toBe(true)
    expect(exported.includes("FuseOverlayfsProjectionBackend")).toBe(true)
  })

  test("R7-00-3：coordinator 生成的 boundCommand 交给 LinuxBrokerProjectionExecutor —— digest 不一致必须消除（确定性 envelope 契约）", async () => {
    const { ctx, snapshotId } = buildWorld()
    const auth = new TestReceiptAuthority()
    const coord = new ProjectionCoordinator({
      store: ctx.store,
      materializer: materializerFor(ctx),
      backend: new CopyProjectionFixtureBackend(),
      projectionRoot: tmpRoot("r7-00-3"),
      receiptAuthority: auth,
      intentReservationPath: join(tmpRoot("r7-00-3r"), "res.sqlite"),
    })
    const session = coord.start(makePlan(snapshotId))
    const { createLinuxBroker } = require("../../../src/runtime/linux/broker") as typeof import("../../../src/runtime/linux/broker")
    const { WorkspaceAuthorityRegistry } = require("../../../src/runtime/linux/workspace/workspace-authority") as typeof import("../../../src/runtime/linux/workspace/workspace-authority")
    const { LinuxBrokerProjectionExecutor } = require("../../../src/kernel/projection/broker-adapter") as typeof import("../../../src/kernel/projection/broker-adapter")
    const broker = createLinuxBroker({ mode: "enabled" })
    const registry = new WorkspaceAuthorityRegistry()
    const workspace = registry.registerAgentWorktree({
      projectId: "ak2-r7",
      hostRoot: session.mergedDir,
      access: "readwrite",
      ownerFiles: ["src"],
    })
    // 真实生产 broker authority 的完整身份 envelope（agentId/assignmentId）。
    const executor = new LinuxBrokerProjectionExecutor({
      broker,
      authority: {
        identity: { runId: "run-x", nodeRunId: "run-x:n1", attempt: 1, agentId: "agent-1", assignmentId: "asg-1" },
        workspace,
      },
      writableRoots: ["src"],
      readonlyRoots: ["docs"],
      profile: "build",
    })
    const adapter: ProjectionExecutor = async (cwd, command) => {
      const result = await executor.execute(cwd, command as never)
      return result.outcome
    }
    let failure: unknown
    try {
      await coord.execute(session, { executable: "/bin/true", args: [] }, adapter)
    } catch (error) {
      failure = error
    }
    // 修复后：身份 envelope 违反投影契约必须被确定性拒绝
    // （PROJECTION_AUTHORITY_IDENTITY_ENVELOPE）—— 不是自相矛盾的
    // digest 比较（后者会随 spec 字段演化产生误导性错误）。
    if (failure !== undefined) {
      expect((failure as ProjectionError).code).toBe("PROJECTION_AUTHORITY_IDENTITY_ENVELOPE")
      if ((failure as ProjectionError).code !== "PROJECTION_AUTHORITY_IDENTITY_ENVELOPE") {
        throw new Error(`R7-00-3 RED: boundCommand rejected with ${(failure as ProjectionError).code} (expected spec digest derivation inconsistent with the adapter's actual compiled spec; must be a deterministic envelope contract error)`)
      }
    } else {
      // 允许的替代修复：envelope 被接受 → 执行必须真正完成（boundCommand
      // 被原样消费，未在 adapter 内被重建/丢弃）。
      expect(session.executionState).toBe("COMPLETED")
    }
    ctx.cleanup()
  })

  test("R7-00-4：RESERVED/DISPATCHED → UNKNOWN stale reconciliation 必须合法", () => {
    const path = join(tmpRoot("r7-00-4"), "res.sqlite")
    const res = new DurableIntentReservation(path)
    const old = Date.now() - 60_000
    res.reserve(
      { intentId: "i-reserved", worldId: "w", branchId: "b", snapshotId: "s", projectionId: "p", sessionNonce: "n1" },
      old,
    )
    res.reserve(
      { intentId: "i-dispatched", worldId: "w", branchId: "b", snapshotId: "s", projectionId: "p", sessionNonce: "n2" },
      old,
    )
    res.markDispatched("i-dispatched", "cell-1")
    let error: unknown
    let affected: string[] = []
    try {
      affected = res.reconcileStale(1000, Date.now())
    } catch (caught) {
      error = caught
    }
    expect(error).toBeUndefined()
    if (error !== undefined) {
      throw new Error(`R7-00-4 RED: stale reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    expect(affected.sort()).toEqual(["i-dispatched", "i-reserved"])
    expect(res.statusOf("i-reserved")!.status).toBe("UNKNOWN")
    expect(res.statusOf("i-dispatched")!.status).toBe("UNKNOWN")
    // UNKNOWN 是终态：不得被普通转换复活。
    expect(() => res.markDispatched("i-reserved", "cell-x")).toThrow()
    res.close()
  })

  test("R7-00-5：两个 SQLite connection 并发冲突转换 —— 终态不得被覆盖或复活", () => {
    const path = join(tmpRoot("r7-00-5"), "res.sqlite")
    const a = new DurableIntentReservation(path)
    const b = new DurableIntentReservation(path)
    a.reserve({ intentId: "i-race", worldId: "w", branchId: "b", snapshotId: "s", projectionId: "p", sessionNonce: "n" })
    a.markDispatched("i-race", "cell-1")
    a.markReceiptBound("i-race", "r".repeat(64), "c".repeat(64))
    a.markCommitted("i-race", "commit-1")
    // conn B 在并发窗口内持有陈旧读取（A 提交前读到 RESERVED）——
    // 陈旧转换必须被 WHERE intent_id AND status 条件 + changes===1 拒绝。
    const staleRead = { ...a.statusOf("i-race")!, status: "RESERVED" as const }
    ;(b as unknown as { statusOf: (id: string) => unknown }).statusOf = () => staleRead
    let error: unknown
    try {
      b.markRejected("i-race")
    } catch (caught) {
      error = caught
    }
    // 终态 COMMITTED 必须存活。
    expect(a.statusOf("i-race")!.status).toBe("COMMITTED")
    if (a.statusOf("i-race")!.status !== "COMMITTED") {
      throw new Error("R7-00-5 RED: a stale concurrent transition overwrote the terminal COMMITTED state (UPDATE not conditional on status)")
    }
    // 转换失败必须被显式报告（changes===1 强制）。
    expect(error).toBeDefined()
    if (error === undefined) {
      throw new Error("R7-00-5 RED: a stale concurrent transition silently succeeded (changes===1 not enforced)")
    }
    a.close()
    b.close()
  })

  test("R7-00-6：markDispatched 写入抛错 → executor 必须从未启动，session 终态化并 cleanup", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = new ProjectionCoordinator({
      store: ctx.store,
      materializer: materializerFor(ctx),
      backend: new CopyProjectionFixtureBackend(),
      projectionRoot: tmpRoot("r7-00-6"),
      receiptAuthority: new TestReceiptAuthority(),
      intentReservationPath: join(tmpRoot("r7-00-6r"), "res.sqlite"),
    })
    const registry = (coord as unknown as { intentRegistry: { markDispatched: (id: string) => void } }).intentRegistry
    const original = registry.markDispatched.bind(registry)
    ;(registry as { markDispatched: (id: string) => void }).markDispatched = (id: string) => {
      original(id)
      throw new Error("R7-00-6 markDispatched write failure")
    }
    const session = coord.start(makePlan(snapshotId))
    let executorCalls = 0
    let error: unknown
    try {
      await coord.execute(session, { executable: "noop", args: [] }, async () => {
        executorCalls++
        return { exitCode: 0, timedOut: false, cancelled: false, violation: false }
      })
    } catch (caught) {
      error = caught
    }
    expect(executorCalls).toBe(0)
    if (executorCalls !== 0) {
      throw new Error(`R7-00-6 RED: executor started ${executorCalls} time(s) although the DISPATCHED reservation write failed (reservation must be persisted before any executor call)`)
    }
    expect(error).toBeDefined()
    expect(session.worldState).toBe("REJECTED")
    if (session.worldState !== "REJECTED") {
      throw new Error(`R7-00-6 RED: session not terminalized after reservation write failure (state ${session.worldState})`)
    }
    expect(session.cleanupState).toBeDefined()
    expect(session.receipt).toBeDefined()
    ctx.cleanup()
  })

  test.skipIf(!probeNativeBackends().fuseOverlayfs)("R7-00-7：mount 消失后 upper/work 被替换为 foreign marker —— cleanup 不得删除（REAL FUSE）", () => {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process")
    const root = tmpRoot("r7-00-7")
    const lower = join(root, "lower")
    mkdirSync(lower)
    writeFileSync(join(lower, "f.txt"), "x")
    chmodSync(lower, 0o755)
    const backend = new FuseOverlayfsProjectionBackend()
    const instance = backend.create({ lowerDir: lower, projectionRoot: root, label: "own" })
    expect(instance.assertMountOwned!()).toBe(true)
    // 外部卸载（mount 消失）。
    execFileSync("fusermount3", ["-u", instance.mergedPath], { stdio: "ignore" })
    expect(instance.assertMountOwned!()).toBe(false)
    // 替换 upper/work 为 foreign marker 目录（同路径、不同身份）。
    const upper = instance.writeLayerPath
    const work = join(root, "work-own")
    rmSync(upper, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
    mkdirSync(upper)
    mkdirSync(work)
    writeFileSync(join(upper, "foreign-marker.txt"), "foreign-upper")
    writeFileSync(join(work, "foreign-marker.txt"), "foreign-work")
    const result = instance.cleanup()
    const upperMarkerKept = existsSync(join(upper, "foreign-marker.txt"))
    const workMarkerKept = existsSync(join(work, "foreign-marker.txt"))
    expect(result).toBe(false)
    expect(upperMarkerKept).toBe(true)
    expect(workMarkerKept).toBe(true)
    if (result === true || !upperMarkerKept || !workMarkerKept) {
      throw new Error("R7-00-7 RED: cleanup deleted foreign upper/work marker directories after the mount disappeared (delete branches did not re-verify ownership identity)")
    }
  })

  test("R7-00-8：projection root 被 rename 后 cleanup 不得报告 rootRemoved=true；World commit 不得成功", async () => {
    const { ctx, snapshotId } = buildWorld()
    const auth = new TestReceiptAuthority()
    const coord = new ProjectionCoordinator({
      store: ctx.store,
      materializer: materializerFor(ctx),
      backend: new CopyProjectionFixtureBackend(),
      projectionRoot: tmpRoot("r7-00-8"),
      receiptAuthority: auth,
      intentReservationPath: join(tmpRoot("r7-00-8r"), "res.sqlite"),
    })
    const session = coord.start(makePlan(snapshotId))
    await coord.execute(
      session,
      { executable: "noop", args: [] },
      fixtureExecutor(auth, merged => writeFileSync(join(merged, "src/main.ts"), "changed\n")),
    )
    coord.scan(session)
    // rename 整个 projection root（canonical path 消失，但 inode 树仍在）。
    const renamedTo = `${session.projectionRoot}-renamed`
    renameSync(session.projectionRoot, renamedTo)
    cleanups.push(() => {
      try {
        rmSync(renamedTo, { recursive: true, force: true })
      } catch {
        // 已删
      }
    })
    let commitError: unknown
    try {
      coord.commit(session)
    } catch (error) {
      commitError = error
    }
    // World commit 不得成功。
    expect(commitError).toBeDefined()
    if (commitError === undefined) {
      throw new Error("R7-00-8 RED: world commit succeeded although the projection root had been renamed away")
    }
    expect(ctx.store.getWorld("world-r7")!.currentRevision).toBe(1n)
    // canonical path 消失 ≠ rootRemoved —— 保留 rootFd 指向的 inode 仍存活
    //（rename 而非删除）→ cleanup 必须失败并记录 residue。
    expect(session.cleanupState).toBeDefined()
    expect(session.cleanupState!.rootRemoved).toBe(false)
    expect(session.cleanupState!.cleanupOk).toBe(false)
    if (session.cleanupState!.rootRemoved === true || session.cleanupState!.cleanupOk === true) {
      throw new Error("R7-00-8 RED: cleanup reported the renamed projection root as removed (canonical path missing treated as rootRemoved; retained fd identity not consulted)")
    }
    // renamed 树不得被删除（merged-m 内容仍在）。
    expect(existsSync(join(renamedTo, "merged-m", "src", "main.ts"))).toBe(true)
    if (!existsSync(join(renamedTo, "merged-m", "src", "main.ts"))) {
      throw new Error("R7-00-8 RED: cleanup deleted content under the renamed projection root (foreign/renamed tree must be preserved as residue)")
    }
    ctx.cleanup()
  })

  test("R7-00-9：cleanup 抛异常后 retained child fd 不得泄漏", async () => {
    const { ctx, snapshotId } = buildWorld()
    const throwingBackend: NativeProjectionBackend = {
      id: "fixture-throwing-cleanup",
      kind: "fixture" as never,
      create(input: { lowerDir: string; projectionRoot: string; label: string }): ProjectionInstance {
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
          backend: "fixture" as never,
          mergedPath: merged,
          writeLayerPath: merged,
          assertReady: () => undefined,
          sealForScan: () => ({ sealedPath: merged }),
          cleanup: () => {
            throw new Error("R7-00-9 cleanup exploded")
          },
        }
      },
    }
    const coord = new ProjectionCoordinator({
      store: ctx.store,
      materializer: materializerFor(ctx),
      backend: throwingBackend,
      projectionRoot: tmpRoot("r7-00-9"),
      receiptAuthority: new TestReceiptAuthority(),
      intentReservationPath: join(tmpRoot("r7-00-9r"), "res.sqlite"),
    })
    const session = coord.start(makePlan(snapshotId))
    const projectionRoot = session.projectionRoot
    await coord.execute(session, { executable: "noop", args: [] }, async () => ({
      exitCode: 1, timedOut: false, cancelled: false, violation: false,
    }))
    // 终态 + cleanupState 已记录（异常被规范化）。
    expect(["REJECTED", "FAILED"]).toContain(session.worldState)
    expect(session.cleanupState).toBeDefined()
    expect(session.cleanupState!.cleanupOk).toBe(false)
    // retained child fd 必须已关闭（/proc/self/fd 中不得残留指向
    // projection root 的 fd）。
    const leaked = readdirSync("/proc/self/fd").filter(fd => {
      try {
        return readlinkSync(`/proc/self/fd/${fd}`).startsWith(projectionRoot)
      } catch {
        return false
      }
    })
    expect(leaked).toEqual([])
    if (leaked.length > 0) {
      throw new Error(`R7-00-9 RED: ${leaked.length} retained child fd(s) leaked after cleanup threw (fd ownership not released in finally)`)
    }
    ctx.cleanup()
  })
})
