/**
 * AK2-R6 Correction Gate —— R6-00 先红反例冻结。
 *
 * 每个反例在修复前必须 RED（断言生产代码当前错误行为），修复后 GREEN。
 * 例外：R6-00-14（修正后的 R5-00-9 —— sealed 后同 UID 直写 upper 且攻击
 * 动作确认成功）为 **KNOWN RED** —— 当前 same-UID 架构无法阻止
 * （无 kernel-owned immutable seal / 独立 UID / MAC 授权）—— 标记
 * OWNER-DECISION-REQUIRED；禁止伪造 GREEN。
 *
 * 分层：
 * - FIXTURE：fixture backend + TestReceiptAuthority（deterministic）；
 * - REAL：真实 fuse-overlayfs（mount 消失语义）；
 * - REGISTRY：一次性 intent reservation（跨 registry / 跨重建）。
 *
 * 反例清单（R6-00-1 ~ R6-00-10 + 世界层 R6-00-11/12/13 + R6-00-14）：
 *   1  普通结构对象自报 trustLevel="kernel-authenticated" + 自洽伪 receipt
 *      → 不得获得 production World commit（PRODUCTION_WORLD_COMMIT_BLOCKED）
 *   2  trustLevel=undefined / unknown string / 错误大小写 → 构造即 fail-closed
 *   3  结构化 backend kind:"fixture" + 结构化 authority trustLevel:"test-harness"
 *      （非测试构造的普通对象）→ 不得通过 production coordinator commit
 *   4  两个独立 registry（默认共享持久化）同一 intent → 只能一个成功
 *   5  重建 registry（进程重启等价）后同一 intent → 必须拒绝（不得重放）
 *   6  receipt 使用正确 intentDigest 但 cellSpecDigest（profile/network/
 *      resource 覆盖）与 kernel 期望不同 → 执行前或 commit 前拒绝
 *   7  真实生产 backend mount 消失、底层 merged 目录仍在 →
 *      assertMountOwned 必须返回 false（REAL）
 *   8  base parent 在验证与 mkdir/open 之间被替换/变中间 symlink →
 *      不得在外部目录创建任何 child
 *   9  projection child 在 fd 关闭后、materialize 前被替换 →
 *      外部 sentinel/content/mode 必须完全不变
 *  10  ProjectionExecutor 同步 throw → session 必须 REJECTED、
 *      cleanup 恰好一次、terminal receipt 存在、不得保持 RUNNING
 */

import { afterEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ProjectionError } from "../../../src/kernel/projection/contracts"
import {
  ProjectionCoordinator,
  ProjectionIntentRegistry,
  type ProjectionSession,
} from "../../../src/kernel/projection/coordinator"
import { SnapshotMaterializer } from "../../../src/kernel/projection/materializer"
import {
  CopyProjectionFixtureBackend,
  TestReceiptAuthority,
  fixtureExecutor,
} from "./test-fixtures"
import {
  FuseOverlayfsProjectionBackend,
  probeNativeBackends,
} from "../../../src/kernel/projection/backend"
import { validateWorldProjectionPlan, type WorldProjectionPlanInput } from "../../../src/kernel/projection/plan"
import { createTestWorldStore, type TestWorldStore } from "../world/helpers"
import type { WorldProjectionPlan } from "../../../src/kernel/projection/contracts"
import type { ProjectionReceiptAuthority } from "../../../src/kernel/projection/receipt-authority"
import type { ProjectionExecutionOutcome } from "../../../src/kernel/projection/validator"
import type { WorldStore } from "../../../src/kernel/world/store"
import type { SandboxReceipt } from "../../../src/runtime/linux/contracts"
import type { ProjectionExecutionIntent } from "../../../src/kernel/projection/contracts"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ak2-r6-${label}-`))
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 已删
    }
  })
  return dir
}

function buildWorld(): { ctx: TestWorldStore; snapshotId: string } {
  const ctx = createTestWorldStore()
  ctx.store.createWorld({
    worldId: "world-r6",
    branchId: "branch-main",
    rootObjectId: "root-1",
    owner: "owner:test",
    purpose: "ak2 r6",
  })
  const baseContent = "export const value = 1\n"
  const digest = ctx.store.cas.put(Buffer.from(baseContent, "utf8"), "text/plain").digest
  ctx.store.compareAndCommit({
    worldId: "world-r6",
    branchId: "branch-main",
    baseRevision: 0n,
    actor: "actor:test",
    mutations: [
      { type: "object.put", objectId: "obj-src", objectType: "directory", path: "src" },
      { type: "object.put", objectId: "obj-main", objectType: "file", path: "src/main.ts", contentRef: digest },
      { type: "object.put", objectId: "obj-docs", objectType: "directory", path: "docs" },
    ],
  })
  ctx.store.createSnapshot("world-r6", "branch-main")
  const snapshot = ctx.store.snapshots.getForRevision("world-r6", "branch-main", 1n)!
  return { ctx, snapshotId: snapshot.snapshotId }
}

function makePlan(snapshotId: string, overrides: Partial<WorldProjectionPlanInput> = {}): WorldProjectionPlan {
  return validateWorldProjectionPlan({
    projectionId: `proj-${Math.random().toString(36).slice(2, 10)}`,
    worldId: "world-r6",
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

function materializerFor(ctx: TestWorldStore): SnapshotMaterializer {
  return new SnapshotMaterializer({
    getSnapshot: id => ctx.store.snapshots.get(id),
    getCasRecord: digest => ctx.store.cas.record(digest),
    readCasObject: digest => ctx.store.cas.get(digest),
  })
}

function coordinator(
  ctx: TestWorldStore,
  backend: ReturnType<typeof createFixtureHarness>["backend"],
  options: Partial<ConstructorParameters<typeof ProjectionCoordinator>[0]> = {},
): ProjectionCoordinator {
  return new ProjectionCoordinator({
    store: ctx.store,
    materializer: materializerFor(ctx),
    backend,
    projectionRoot: tmpRoot("coord"),
    ...options,
  } as ConstructorParameters<typeof ProjectionCoordinator>[0])
}

function createFixtureHarness(mutate?: (merged: string) => void): {
  readonly authority: TestReceiptAuthority
  readonly backend: CopyProjectionFixtureBackend
} {
  const authority = new TestReceiptAuthority()
  return {
    authority,
    backend: new CopyProjectionFixtureBackend(),
  }
}

/** 完整流程：start → execute（mutate）→ scan → commit；返回 commit 结果。 */
async function runFlow(
  coord: ProjectionCoordinator,
  session: ProjectionSession,
  executor: (cwd: string, command: { executable: string; args: readonly string[]; signal?: AbortSignal; intent?: ProjectionExecutionIntent }) => Promise<ProjectionExecutionOutcome>,
): Promise<{ committed: boolean; commitError?: unknown }> {
  await coord.execute(session, { executable: "noop", args: [] }, executor as never)
  coord.scan(session)
  try {
    coord.commit(session)
    return { committed: true }
  } catch (error) {
    return { committed: false, commitError: error }
  }
}

/** 非测试构造的普通对象 authority（只有公开字符串字段 —— 不携带任何
 *  test-only brand；R6-01 目标：这种对象不得通过 production gate）。 */
function plainHarness(trustLevel: string, mutate?: (merged: string) => void): {
  readonly authority: ProjectionReceiptAuthority & { recordFinalReceipt: (intent: ProjectionExecutionIntent, cellId: string, overrides?: Partial<SandboxReceipt>) => SandboxReceipt }
  readonly executor: (cwd: string, command: { executable: string; args: readonly string[]; signal?: AbortSignal; intent?: ProjectionExecutionIntent }) => Promise<ProjectionExecutionOutcome>
} {
  const inner = new TestReceiptAuthority()
  const authority = {
    trustLevel,
    getFinalReceipt: (runId: string, cellId: string) => inner.getFinalReceipt(runId, cellId),
    isCleanupFinalized: (receipt: SandboxReceipt) => inner.isCleanupFinalized(receipt),
    recordFinalReceipt: (intent: ProjectionExecutionIntent, cellId: string, overrides?: Partial<SandboxReceipt>) =>
      inner.recordFinalReceipt(intent, cellId, overrides),
  }
  const executor = fixtureExecutor(authority as never, mutate) as never
  return { authority: authority as never, executor }
}

describe("AK2-R6 反例冻结（projection 层）", () => {
  test("R6-00-1：普通结构对象自报 trustLevel='kernel-authenticated' + 自洽伪 receipt → 不得获得 production World commit", async () => {
    const { ctx, snapshotId } = buildWorld()
    const { authority, executor } = plainHarness("kernel-authenticated", merged =>
      writeFileSync(join(merged, "src/main.ts"), "changed\n"))
    const harness = createFixtureHarness()
    const coord = coordinator(ctx, harness.backend, { receiptAuthority: authority })
    const session = coord.start(makePlan(snapshotId))
    const result = await runFlow(coord, session, executor)
    // 精确错误码：production World commit 必须被结构性阻止（自报字符串
    // 不是认证通道）。
    expect(result.committed).toBe(false)
    if (result.committed) {
      throw new Error("R6-00-1 RED: self-reported trustLevel='kernel-authenticated' bypassed the production denylist and committed")
    }
    expect((result.commitError as ProjectionError).code).toBe("PRODUCTION_WORLD_COMMIT_BLOCKED")
    expect(ctx.store.getWorld("world-r6")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("R6-00-2：trustLevel=undefined / unknown string / 错误大小写 → 构造即 fail-closed", () => {
    for (const level of [undefined, "bogus", "KERNEL-AUTHENTICATED", "test_harness"]) {
      const { ctx } = buildWorld()
      const harness = createFixtureHarness()
      const authority = {
        trustLevel: level,
        getFinalReceipt: () => undefined,
        isCleanupFinalized: () => true,
      }
      let caught: unknown
      try {
        new ProjectionCoordinator({
          store: ctx.store,
          materializer: materializerFor(ctx),
          backend: harness.backend,
          projectionRoot: tmpRoot("r6-00-2"),
          receiptAuthority: authority as never,
        } as never)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeDefined()
      if (caught === undefined) {
        throw new Error(`R6-00-2 RED: trustLevel=${String(level)} was accepted without strict exhaustive validation`)
      }
      expect((caught as ProjectionError).code).toBe("EXECUTION_RECEIPT_AUTHORITY_ERROR")
      ctx.cleanup()
    }
  })

  test("R6-00-3：结构化 backend kind:'fixture' + 结构化 authority trustLevel:'test-harness'（普通对象）→ 不得通过 production coordinator commit", async () => {
    const { ctx, snapshotId } = buildWorld()
    const { authority, executor } = plainHarness("test-harness", merged =>
      writeFileSync(join(merged, "src/main.ts"), "changed\n"))
    const harness = createFixtureHarness()
    const coord = coordinator(ctx, harness.backend, { receiptAuthority: authority })
    const session = coord.start(makePlan(snapshotId))
    const result = await runFlow(coord, session, executor)
    expect(result.committed).toBe(false)
    if (result.committed) {
      throw new Error("R6-00-3 RED: plain kind:'fixture' backend + trustLevel:'test-harness' authority bypassed production and committed")
    }
    expect((result.commitError as ProjectionError).code).toBe("PRODUCTION_WORLD_COMMIT_BLOCKED")
    expect(ctx.store.getWorld("world-r6")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("R6-00-4：两个独立 registry（跨 coordinator 等价）同一 intent → 只能一个成功", () => {
    const intentId = `r6-00-4-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const registryA = new ProjectionIntentRegistry()
    const registryB = new ProjectionIntentRegistry()
    expect(registryA.reserve(intentId)).toBe(true)
    expect(registryB.reserve(intentId)).toBe(false)
    if (registryB.reserve(intentId) === true) {
      throw new Error("R6-00-4 RED: a second independent registry re-authorized the same intent (per-coordinator in-memory Set)")
    }
  })

  test("R6-00-5：重建 registry（进程重启等价）后同一 intent → 必须拒绝（不得因内存清空而重放）", () => {
    const intentId = `r6-00-5-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const registryA = new ProjectionIntentRegistry()
    expect(registryA.reserve(intentId)).toBe(true)
    const rebuilt = new ProjectionIntentRegistry()
    expect(rebuilt.reserve(intentId)).toBe(false)
    if (rebuilt.reserve(intentId) === true) {
      throw new Error("R6-00-5 RED: a rebuilt registry replayed a reserved intent (in-memory Set cleared)")
    }
    expect(rebuilt.isReserved(intentId)).toBe(true)
  })

  test("R6-00-6：receipt 使用正确 intentDigest 但 cellSpecDigest（profile/network/resource 覆盖）与 kernel 期望不同 → commit 前拒绝", async () => {
    const { ctx, snapshotId } = buildWorld()
    const harness = createFixtureHarness()
    const coord = coordinator(ctx, harness.backend, { receiptAuthority: harness.authority })
    const session = coord.start(makePlan(snapshotId))
    // fixture 执行成功，但注册的 final receipt 携带**伪造**的 cellSpecDigest
    // （profile/network/resource 与 kernel 期望不同的 digest 覆盖）。
    const mutate = (merged: string): void => {
      writeFileSync(join(merged, "src/main.ts"), "changed\n")
    }
    const forgedExecutor = (async (cwd: string, command: { intent?: ProjectionExecutionIntent }) => {
      mutate(cwd)
      const intent = command.intent
      if (intent === undefined) throw new ProjectionError("EXECUTION_RECEIPT_REQUIRED", "intent required")
      const cellId = `cell-${intent.intentId}`
      const receipt = harness.authority.recordFinalReceipt(intent, cellId, {
        cellSpecDigest: "0".repeat(64),
      })
      return {
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        violation: false,
        executionReceiptId: receipt.receiptDigest,
        receiptBinding: {
          runId: receipt.runId,
          nodeRunId: receipt.nodeRunId,
          cellId: receipt.cellId,
          cellSpecDigest: receipt.cellSpecDigest,
          filesystemPolicyDigest: receipt.filesystemPolicyDigest,
          workspaceHostRoot: intent.workspaceIdentity.path,
        },
      } as ProjectionExecutionOutcome
    }) as never
    const result = await runFlow(coord, session, forgedExecutor)
    expect(result.committed).toBe(false)
    if (result.committed) {
      throw new Error("R6-00-6 RED: a receipt with correct intentDigest but wrong cellSpecDigest (altered profile/network/resource) was accepted for world commit")
    }
    expect((result.commitError as ProjectionError).code).toBe("EXECUTION_RECEIPT_BINDING_MISMATCH")
    expect(ctx.store.getWorld("world-r6")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("R6-00-7：真实生产 backend mount 消失、底层 merged inode 仍在 → assertMountOwned 必须返回 false（REAL）", () => {
    const probe = probeNativeBackends()
    if (!probe.fuseOverlayfs) {
      console.log("ENV_BLOCKED: fuse-overlayfs unavailable on this host; R6-00-7 not run")
      return
    }
    const root = mkdtempSync(join(tmpdir(), "ak2-r6-fuse-"))
    cleanups.push(() => {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // residue 保留诊断
      }
    })
    mkdirSync(join(root, "lower"), { mode: 0o700 })
    writeFileSync(join(root, "lower", "hello.txt"), "hello\n")
    // backend.create 自己创建 upper/work/merged（不得预创建 → EEXIST）。
    const backend = new FuseOverlayfsProjectionBackend()
    const instance = backend.create({ lowerDir: join(root, "lower"), projectionRoot: root, label: "m" })
    instance.assertReady()
    expect(instance.assertMountOwned?.()).toBe(true)
    // 外部卸载（模拟 mount 消失）—— 底层 merged 目录 inode 仍然存在。
    let unmounted = false
    for (const binary of ["fusermount3", "fusermount"]) {
      try {
        execFileSync(binary, ["-u", join(root, "merged-m")], { stdio: "ignore" })
        unmounted = true
        break
      } catch {
        // 尝试下一个
      }
    }
    expect(unmounted).toBe(true)
    expect(existsSync(join(root, "merged-m"))).toBe(true)
    expect(instance.assertMountOwned?.()).toBe(false)
    if (instance.assertMountOwned?.() === true) {
      throw new Error("R6-00-7 RED: assertMountOwned returned true after the production FUSE mount vanished (only the underlying merged inode remains)")
    }
  }, 60_000)

  test("R6-00-8：base parent 在验证与 mkdir/open 之间被替换/变中间 symlink → 不得在外部目录创建任何 child", () => {
    const { ctx, snapshotId } = buildWorld()
    const harness = createFixtureHarness()
    const parentRoot = tmpRoot("r6-00-8-parent")
    const basePath = join(parentRoot, "base")
    const external = mkdtempSync(join(tmpdir(), "ak2-r6-00-8-ext-"))
    cleanups.push(() => {
      try {
        rmSync(external, { recursive: true, force: true })
      } catch {
        // 已删
      }
    })
    cleanups.push(() => {
      try {
        rmSync(parentRoot + "-stolen", { recursive: true, force: true })
      } catch {
        // 已删
      }
    })
    writeFileSync(join(external, "sentinel.txt"), "sentinel\n")
    let swapped = false
    const coord = new ProjectionCoordinator({
      store: ctx.store,
      materializer: materializerFor(ctx),
      backend: harness.backend,
      projectionRoot: basePath,
      receiptAuthority: harness.authority,
      onBeforeBaseMkdir: (_base: string) => {
        if (swapped) return
        swapped = true
        // parent 验证后、base mkdir 前：rename 掉真实 parent，用 symlink
        // 指向外部目录替换（中间 symlink）。
        renameSync(parentRoot, parentRoot + "-stolen")
        symlinkSync(external, parentRoot)
      },
    } as never)
    const plan = makePlan(snapshotId)
    let startError: unknown
    let session: ProjectionSession | undefined
    try {
      session = coord.start(plan)
    } catch (error) {
      startError = error
    }
    // 外部目录必须完全不变：只有 sentinel（无 base/、无 projection child）。
    expect(readdirSync(external)).toEqual(["sentinel.txt"])
    if (readdirSync(external).length !== 1) {
      throw new Error("R6-00-8 RED: a child was created in the external directory after the base parent was swapped to a symlink")
    }
    expect(readFileSync(join(external, "sentinel.txt"), "utf8")).toBe("sentinel\n")
    expect(lstatSync(join(external, "sentinel.txt")).mode & 0o777).toBe(0o644)
    // start 必须 fail-closed（path 身份复核失败）。
    expect(startError).toBeDefined()
    if (startError === undefined) {
      throw new Error("R6-00-8 RED: start succeeded after base parent swap (pathname-based creation followed the symlink)")
    }
    expect((startError as ProjectionError).code).toBe("PROJECTION_BASE_PATH_AUTHORITY")
    expect(session).toBeUndefined()
    ctx.cleanup()
  })

  test("R6-00-9：projection child 在 fd 关闭后、materialize 前被替换 → 外部 sentinel/content/mode 必须完全不变", () => {
    const { ctx, snapshotId } = buildWorld()
    const harness = createFixtureHarness()
    const root = tmpRoot("r6-00-9")
    const coord = new ProjectionCoordinator({
      store: ctx.store,
      materializer: materializerFor(ctx),
      backend: harness.backend,
      projectionRoot: root,
      receiptAuthority: harness.authority,
      onAfterChildOpened: (projectionRoot: string) => {
        // child fd 身份捕获后、materialize 前：rename 掉真实 child，用
        // 新目录 + sentinel 替换（外部 sentinel）。
        const stolen = projectionRoot + "-stolen"
        renameSync(projectionRoot, stolen)
        mkdirSync(projectionRoot, { mode: 0o700 })
        writeFileSync(join(projectionRoot, "sentinel.txt"), "sentinel\n")
        cleanups.push(() => {
          try {
            rmSync(stolen, { recursive: true, force: true })
          } catch {
            // 已删
          }
        })
      },
    } as never)
    const plan = makePlan(snapshotId)
    let startError: unknown
    let session: ProjectionSession | undefined
    try {
      session = coord.start(plan)
    } catch (error) {
      startError = error
    }
    const projRoot = join(resolve(root), plan.projectionId)
    // 外部（attacker 的替换目录）必须只有 sentinel —— 无 base/、无任何
    // 物化内容；sentinel 内容与 mode 不变。
    expect(readdirSync(projRoot)).toEqual(["sentinel.txt"])
    if (readdirSync(projRoot).length !== 1) {
      throw new Error("R6-00-9 RED: materialization wrote into the swapped external child directory (fd closed before materialize)")
    }
    expect(readFileSync(join(projRoot, "sentinel.txt"), "utf8")).toBe("sentinel\n")
    expect(lstatSync(join(projRoot, "sentinel.txt")).mode & 0o777).toBe(0o644)
    expect(startError).toBeDefined()
    if (startError === undefined) {
      throw new Error("R6-00-9 RED: start succeeded after the projection child was swapped (pathname-based materialize)")
    }
    expect((startError as ProjectionError).code).toBe("PROJECTION_ROOT_ESCAPE")
    expect(session).toBeUndefined()
    ctx.cleanup()
  })

  test("R6-00-10：ProjectionExecutor 同步 throw → session 必须 REJECTED、cleanup 恰好一次、terminal receipt 存在、不得保持 RUNNING", async () => {
    const { ctx, snapshotId } = buildWorld()
    const harness = createFixtureHarness()
    const coord = coordinator(ctx, harness.backend, { receiptAuthority: harness.authority })
    const session = coord.start(makePlan(snapshotId))
    // 插桩 cleanup 调用次数。
    let cleanupCount = 0
    const instance = session.instance as unknown as { cleanup: () => boolean }
    const originalCleanup = instance.cleanup.bind(instance)
    instance.cleanup = () => {
      cleanupCount++
      return originalCleanup()
    }
    const syncThrowingExecutor = (() => {
      throw new Error("sync-boom")
    }) as never
    let execError: unknown
    try {
      await coord.execute(session, { executable: "noop", args: [] }, syncThrowingExecutor)
    } catch (error) {
      execError = error
    }
    expect(execError).toBeDefined()
    // 同步 throw 与 rejected Promise 行为一致：统一 terminalize。
    //（状态向量 (REJECTED, FAILED)：REJECTED 是 world 状态，execution
    //  状态是 FAILED —— 合法组合唯一真源见 PROJECTION_STATE_VECTORS。）
    expect(session.worldState).toBe("REJECTED")
    if (session.worldState !== "REJECTED") {
      throw new Error(`R6-00-10 RED: sync executor throw left the session in ${session.worldState}/${session.executionState} (executor call outside the try/terminal guard)`)
    }
    expect(session.executionState).toBe("FAILED")
    expect(session.cleanupState).toBeDefined()
    expect(session.receipt).toBeDefined()
    expect(cleanupCount).toBe(1)
    if (cleanupCount !== 1) {
      throw new Error(`R6-00-10 RED: cleanup invoked ${cleanupCount} times instead of exactly once after sync executor throw`)
    }
    expect(ctx.store.getWorld("world-r6")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })
})
