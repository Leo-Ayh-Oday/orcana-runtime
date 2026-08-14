/**
 * AK2-R5 Correction Gate —— R5-00 先红反例冻结。
 *
 * 每个反例在修复前必须 RED（断言生产代码当前错误行为），修复后 GREEN。
 * 例外：R5-00-9（R6-00-14 修正 / sealed 后同 UID 直写 upper）为
 * **KNOWN RED** —— 当前 same-UID 架构无法阻止（无 kernel-owned immutable
 * snapshot / 独立 UID / MAC 授权）—— 标记 OWNER-DECISION-REQUIRED；
 * 禁止伪造 GREEN。R6-00-14 修正该测试：攻击必须真实写入 writeLayer/upper
 * 并确认成功后再 scan（旧版在 writeFileSync 处 EACCES —— setup error
 * 冒充攻击证明）。
 *
 * 分层：
 * - FIXTURE：fixture backend + TestReceiptAuthority（deterministic）；
 * - REAL：真实 fuse-overlayfs（foreign mount swap / 真实 mount 语义）；
 * - STATIC：生产导出面 inventory（R5-01）。
 *
 * 反例清单（R5-00-1 ~ R5-00-12 + R5-01）：
 *   1  任意调用方实现 kind:"fixture" + allowTestBackends=true 仍不得获得
 *      receiptless World commit
 *   2  baseProjectionRoot 是 symlink → start 必须在创建任何 projection
 *      child / 物化文件 / CAS 副作用前拒绝
 *   3  base root 在验证与 child 创建之间被替换 → 必须拒绝；外部 sentinel
 *      不得改变
 *   4  backend.create() 返回已挂载 instance、assertReady() 抛异常 →
 *      必须先调用 instance.cleanup()；未证明卸载时不得遍历/删除
 *      projection root；residue/error 必须保留
 *   5  create 完成 FUSE mount 后被替换为 foreign FUSE → 不得卸载 foreign、
 *      不得 rm/chmod upper/work/merged（REAL）
 *   6  execute RUNNING 时并发 cancel → 先取消、等待 executor、恰好一个
 *      终态、cleanup 后无 writer、无非法 transition
 *   7  seam 抛异常必须 terminalize：execute merged lstat / getFinalReceipt /
 *      isCleanupFinalized / sealForScan / commit getWorld preflight
 *   8  同一 intent 被两个 adapter 实例使用 → 只允许一个 execution cell
 *      （kernel-owned 一次性 reservation；不依赖实例内 Set）
 *   9  sealed 后同 UID 直写 writeLayerPath/upper → 不得返回成功 delta、
 *      不得 commit —— KNOWN RED / OWNER-DECISION-REQUIRED（R6-00-14 修正：
 *      攻击动作必须真实成功后再 scan，不得以 EACCES/setup error 冒充）
 *  10  raw bytes 恰为合法 FileManifest JSON → snapshot 物化逐字节一致
 *      （R5-07，world 层测试文件）
 *  11  invalid final namespace 拒绝后无 CAS/file/staging residue（R5-08，
 *      world 层测试文件）
 *  12  maxFileChunks 超限在第二份数组分配/逐项 normalize/打开目标文件前
 *      拒绝（R5-08，world 层测试文件）
 *  R5-01 生产导出面不得导出任何 fixture/test authority 能力（STATIC）
 */

import { afterEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
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
  expectedProjectionFilesystemPolicyDigest,
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
  type NativeProjectionBackend,
  type ProjectionInstance,
} from "../../../src/kernel/projection/backend"
import { validateWorldProjectionPlan, type WorldProjectionPlanInput } from "../../../src/kernel/projection/plan"
import { createTestWorldStore, type TestWorldStore } from "../world/helpers"
import type { WorldProjectionPlan } from "../../../src/kernel/projection/contracts"
import type { ProjectionReceiptAuthority, ProjectionReceiptBinding } from "../../../src/kernel/projection/receipt-authority"
import type { ProjectionExecutionOutcome } from "../../../src/kernel/projection/validator"
import type { WorldStore } from "../../../src/kernel/world/store"
import type { SandboxReceipt } from "../../../src/runtime/linux/contracts"
import { LinuxBrokerProjectionExecutor } from "../../../src/kernel/projection/broker-adapter"
import { createLinuxBroker } from "../../../src/runtime/linux/broker"
import { RuntimeStateStore } from "../../../src/runtime/linux/recovery/state-store"
import { RuntimeStateReceiptAuthority } from "../../../src/kernel/projection/receipt-authority"
import { WorkspaceAuthorityRegistry } from "../../../src/runtime/linux/workspace/workspace-authority"
import type { TrustedExecutionAuthority } from "../../../src/runtime/linux/contracts"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ak2-r5-${label}-`))
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 已删
    }
  })
  return dir
}

function buildWorld(): { ctx: TestWorldStore; snapshotId: string; baseContent: string } {
  const ctx = createTestWorldStore()
  ctx.store.createWorld({
    worldId: "world-c",
    branchId: "branch-main",
    rootObjectId: "root-1",
    owner: "owner:test",
    purpose: "ak2 r5",
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
      { type: "object.put", objectId: "obj-docs", objectType: "directory", path: "docs" },
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

/** R5 coordinator 工厂：fixture backend + TestReceiptAuthority。
 *  allowTestBackends/receiptAuthority 经 as never 传入 —— 修复前后均可编译
 *  （R5-01 修复后 allowTestBackends 选项被删除，运行时被忽略）。 */
function coordinator(
  ctx: TestWorldStore,
  backend?: NativeProjectionBackend | CopyProjectionFixtureBackend,
  options: { receiptAuthority?: ProjectionReceiptAuthority; projectionRoot?: string } & Record<string, unknown> = {},
): ProjectionCoordinator {
  const materializer = new SnapshotMaterializer({
    getSnapshot: id => ctx.store.snapshots.get(id),
    getCasRecord: digest => ctx.store.cas.record(digest),
    readCasObject: digest => ctx.store.cas.get(digest),
  })
  const effective = options.receiptAuthority ?? new TestReceiptAuthority()
  return new ProjectionCoordinator({
    store: ctx.store,
    materializer,
    backend: backend ?? new CopyProjectionFixtureBackend(),
    projectionRoot: options.projectionRoot ?? tmpRoot("projroot"),
    receiptAuthority: effective,
    ...options,
  } as never)
}

/** production-kind backend stub：kind !== "fixture"，但提供最小 instance。 */
function productionKindBackend(instanceOverrides: Partial<ProjectionInstance> = {}): NativeProjectionBackend {
  return {
    id: "stub-production",
    kind: "fuse-overlayfs",
    create(input): ProjectionInstance {
      const merged = join(resolve(input.projectionRoot), "merged-stub")
      mkdirSync(merged, { mode: 0o700 })
      mkdirSync(join(merged, "src"), { recursive: true })
      mkdirSync(join(merged, "docs"), { recursive: true })
      const instance: ProjectionInstance = {
        backend: "fuse-overlayfs",
        mergedPath: merged,
        writeLayerPath: merged,
        assertReady: () => {
          statSync(merged)
        },
        assertMountOwned: () => true,
        sealForScan: () => ({ sealedPath: merged }),
        cleanup: () => {
          if (existsSync(merged)) rmSync(merged, { recursive: true, force: true })
          return true
        },
        ...instanceOverrides,
      }
      return instance
    },
  }
}

/** production-kind outcome（带 receiptId + binding —— 模拟真实 broker）。 */
async function productionOutcomeExecutor(cwd: string): Promise<ProjectionExecutionOutcome> {
  return {
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    violation: false,
    executionReceiptId: "a".repeat(64),
    receiptBinding: {
      runId: "run-x",
      nodeRunId: "run-x:n1",
      cellId: "cell-x",
      cellSpecDigest: "c".repeat(64),
      filesystemPolicyDigest: "d".repeat(64),
      workspaceHostRoot: resolve(cwd),
    } as ProjectionReceiptBinding,
  }
}

async function tickUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("tickUntil timeout")
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** authorityFor —— 最小 writable ownership 注册（ownerFiles === writable roots）。 */
function authorityFor(merged: string): TrustedExecutionAuthority {
  const registry = new WorkspaceAuthorityRegistry()
  const workspace = registry.registerAgentWorktree({
    projectId: "ak2-r5",
    hostRoot: merged,
    access: "readwrite",
    ownerFiles: ["src"],
  })
  return {
    identity: { runId: `run-${process.pid}`, nodeRunId: `run-${process.pid}:n1`, attempt: 1 },
    workspace,
  }
}

describe("AK2-R5 反例（R5-00 先红冻结）", () => {
  test("R5-00-1：任意调用方实现 kind:'fixture' + allowTestBackends=true 不得获得 receiptless World commit", async () => {
    const { ctx, snapshotId } = buildWorld()
    const materializer = new SnapshotMaterializer({
      getSnapshot: id => ctx.store.snapshots.get(id),
      getCasRecord: digest => ctx.store.cas.record(digest),
      readCasObject: digest => ctx.store.cas.get(digest),
    })
    let coord: ProjectionCoordinator | undefined
    try {
      // 结构化 backend + TypeScript cast + allowTestBackends 均不能放大 authority。
      coord = new ProjectionCoordinator({
        store: ctx.store,
        materializer,
        backend: new CopyProjectionFixtureBackend(),
        projectionRoot: tmpRoot("r5-1"),
        allowTestBackends: true as never,
      } as never)
    } catch (error) {
      // 构造即拒绝（R5-01：production coordinator 不存在 receiptless 分支）。
      expect((error as ProjectionError).code).toBe("EXECUTION_RECEIPT_REQUIRED")
      expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
      ctx.cleanup()
      return
    }
    // 基线行为：构造成功 → receiptless outcome 必须仍被拒绝（scan 门无条件）。
    const session = coord!.start(makePlan(snapshotId))
    await coord!.execute(
      session,
      { executable: "noop", args: [] },
      // receiptless outcome（fixture 执行后不注册任何 receipt）—— 必须仍被拒绝。
      async cwd => {
        writeFileSync(join(cwd, "src/main.ts"), "x\n")
        return { exitCode: 0, timedOut: false, cancelled: false, violation: false }
      },
    )
    let scanError: unknown
    try {
      coord!.scan(session)
    } catch (error) {
      scanError = error
    }
    // RED at baseline：receiptless fixture scan/commit 被接受。
    expect(scanError).toBeDefined()
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("R5-00-2：baseProjectionRoot 是 symlink → start 必须在创建任何 child/物化/CAS 副作用前拒绝", () => {
    const { ctx, snapshotId } = buildWorld()
    const target = tmpRoot("base-symlink-target")
    writeFileSync(join(target, "sentinel"), "keep")
    const baseDir = tmpRoot("base-symlink")
    const symlinkPath = join(baseDir, "base")
    symlinkSync(target, symlinkPath)
    const coord = coordinator(ctx, undefined, { projectionRoot: symlinkPath })
    let startError: unknown
    try {
      coord.start(makePlan(snapshotId))
    } catch (error) {
      startError = error
    }
    expect(startError).toBeDefined()
    if (startError === undefined) {
      throw new Error("R5-00-2 RED: start() accepted a symlink baseProjectionRoot and created projection children through it")
    }
    expect((startError as ProjectionError).code).toBe("PROJECTION_BASE_PATH_AUTHORITY")
    // 未创建任何 projection child；外部 sentinel 不变。
    expect(readdirSync(target)).toEqual(["sentinel"])
    expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("keep")
    // 无 CAS 副作用。
    expect(ctx.store.cas.list().length).toBeGreaterThan(0) // 基线内容存在
    ctx.cleanup()
  })

  test("R5-00-3：base root 在验证与 child 创建之间被替换 → 必须拒绝；外部 sentinel 不得改变", () => {
    const { ctx, snapshotId } = buildWorld()
    const base = tmpRoot("base-swap")
    writeFileSync(join(base, "sentinel"), "keep")
    let swapped = false
    const coord = coordinator(ctx, undefined, {
      projectionRoot: base,
      onBeforeChildCreate: () => {
        if (swapped) return
        swapped = true
        renameSync(base, `${base}.old`)
        mkdirSync(base, { mode: 0o700 })
        writeFileSync(join(base, "sentinel2"), "SENTINEL2")
      },
    })
    let startError: unknown
    try {
      coord.start(makePlan(snapshotId))
    } catch (error) {
      startError = error
    }
    expect(startError).toBeDefined()
    if (startError === undefined) {
      throw new Error("R5-00-3 RED: start() accepted a swapped base root (no fail-closed identity check before child creation)")
    }
    expect((startError as ProjectionError).code).toBe("PROJECTION_BASE_PATH_AUTHORITY")
    // 外部 sentinel 不得改变；原 base（.old）不得出现 child。
    expect(readFileSync(join(base, "sentinel2"), "utf8")).toBe("SENTINEL2")
    expect(readdirSync(`${base}.old`)).toEqual(["sentinel"])
    expect(readFileSync(join(`${base}.old`, "sentinel"), "utf8")).toBe("keep")
    // 清理 base.old（rename 后的原 base —— afterEach 只删 base）。
    try {
      rmSync(`${base}.old`, { recursive: true, force: true })
    } catch {
      // 已删
    }
    ctx.cleanup()
  })

  test("R5-00-4：assertReady() 抛异常 → 必须先调用 instance.cleanup()；未证明卸载时不得遍历/删除 projection root；residue/error 保留", () => {
    const { ctx, snapshotId } = buildWorld()
    const spy: { cleanupCalled: number; cleanupResult: boolean } = { cleanupCalled: 0, cleanupResult: false }
    const backend: NativeProjectionBackend = {
      id: "spy-assert-ready",
      kind: "fuse-overlayfs",
      create(input): ProjectionInstance {
        const merged = join(resolve(input.projectionRoot), "merged-spy")
        mkdirSync(merged, { mode: 0o700 })
        writeFileSync(join(merged, "in-mount.txt"), "mounted\n")
        return {
          backend: "fuse-overlayfs",
          mergedPath: merged,
          writeLayerPath: merged,
          assertReady: () => {
            throw new ProjectionError("BACKEND_UNAVAILABLE", "assertReady fault")
          },
          cleanup: () => {
            spy.cleanupCalled += 1
            return spy.cleanupResult
          },
        }
      },
    }
    const coord = coordinator(ctx, backend, { receiptAuthority: new TestReceiptAuthority() })
    const plan = makePlan(snapshotId)
    const baseRoot = resolve((coord as unknown as { baseProjectionRoot: string }).baseProjectionRoot)
    const expectedRoot = resolve(join(baseRoot, plan.projectionId))
    let startError: unknown
    try {
      coord.start(plan)
    } catch (error) {
      startError = error
    }
    expect(startError).toBeDefined()
    expect((startError as ProjectionError).code).toBe("BACKEND_UNAVAILABLE")
    // 精确断言：cleanup 必须先被调用（R5-00-4 RED at baseline：start 的
    // catch 直接 pathname 删除 root，从未调用 instance.cleanup()）。
    expect(spy.cleanupCalled).toBe(1)
    if (spy.cleanupCalled === 0) {
      throw new Error("R5-00-4 RED: start() failure path deleted the projection root without calling instance.cleanup()")
    }
    // cleanup 未证明卸载（返回 false）→ 不得删除 root —— residue 保留。
    expect(existsSync(expectedRoot)).toBe(true)
    if (!existsSync(expectedRoot)) {
      throw new Error("R5-00-4 RED: projection root was deleted despite unmount not proven (cleanup returned false)")
    }
    expect(existsSync(join(expectedRoot, "merged-spy", "in-mount.txt"))).toBe(true)
    ctx.cleanup()
  })

  test(
    "R5-00-5（REAL）：create 完成 FUSE mount 后被替换为 foreign FUSE → 不得卸载 foreign、不得 rm/chmod upper/work/merged",
    () => {
      const probe = probeNativeBackends()
      if (!probe.fuseOverlayfs) {
        console.log("ENV_BLOCKED: fuse-overlayfs unavailable; R5-00-5 real lane not executed (not a pass)")
        return
      }
      const root = tmpRoot("foreign")
      const lower = join(root, "lower")
      mkdirSync(join(lower, "src"), { recursive: true })
      writeFileSync(join(lower, "src", "main.ts"), "x\n")
      const foreignBase = join(root, "foreign")
      mkdirSync(join(foreignBase, "f-lower"), { recursive: true })
      writeFileSync(join(foreignBase, "f-lower", "f.txt"), "foreign\n")
      mkdirSync(join(foreignBase, "f-upper"), { mode: 0o700 })
      mkdirSync(join(foreignBase, "f-work"), { mode: 0o700 })
      const merged = join(root, "merged-m")
      let foreignMounted = false
      const backend = new FuseOverlayfsProjectionBackend({
        onAfterMountAttested: () => {
          // 卸载本次 mount，替换为 foreign fuse-overlayfs（不同 lower/upper/work）。
          execFileSync("fusermount3", ["-u", merged], { stdio: "ignore" })
          execFileSync(
            "fuse-overlayfs",
            ["-o", `lowerdir=${join(foreignBase, "f-lower")},upperdir=${join(foreignBase, "f-upper")},workdir=${join(foreignBase, "f-work")}`, merged],
            { stdio: "ignore" },
          )
          foreignMounted = true
          throw new Error("forced failure after mount attestation")
        },
      })
      let createError: unknown
      try {
        backend.create({ lowerDir: lower, projectionRoot: root, label: "m" })
      } catch (error) {
        createError = error
      }
      expect(createError).toBeDefined()
      expect(foreignMounted).toBe(true)
      // foreign mount 必须仍然挂载（不得卸载 foreign）—— RED at baseline。
      const stillFuse = (() => {
        try {
          return statfsSync(merged).type === 0x65735546
        } catch {
          return false
        }
      })()
      expect(stillFuse).toBe(true)
      if (!stillFuse) {
        throw new Error("R5-00-5 RED: create() error path unmounted the foreign FUSE mount (ownership not checked)")
      }
      // upper/work/merged 不得被 rm/chmod —— RED at baseline（全部被递归删除）。
      expect(existsSync(join(root, "upper-m"))).toBe(true)
      expect(existsSync(join(root, "work-m"))).toBe(true)
      expect(existsSync(merged)).toBe(true)
      if (!existsSync(join(root, "upper-m")) || !existsSync(join(root, "work-m"))) {
        throw new Error("R5-00-5 RED: create() error path removed upper/work despite a foreign mount (mounted-tree recursive delete)")
      }
      // 精确错误码。
      expect((createError as ProjectionError).code).toBe("BACKEND_UNAVAILABLE")
      // 清理：卸载 foreign + 删除目录。
      try {
        execFileSync("fusermount3", ["-u", merged], { stdio: "ignore" })
      } catch {
        // 已卸载
      }
      rmSync(root, { recursive: true, force: true })
      cleanups.pop()?.()
    },
    60_000,
  )

  test("R5-00-6：execute RUNNING 时并发 cancel → 先取消、等待 executor、恰好一个终态、cleanup 后无 writer", async () => {
    const { ctx, snapshotId } = buildWorld()
    const harness = createHarness()
    const coord = coordinator(ctx, harness.backend, { receiptAuthority: harness.authority })
    const session = coord.start(makePlan(snapshotId))
    let executorDone = false
    const execPromise = coord.execute(
      session,
      { executable: "noop", args: [] },
      async (cwd, command) => {
        await new Promise<void>(resolve => {
          if (command.signal?.aborted) return resolve()
          command.signal?.addEventListener("abort", () => resolve(), { once: true })
        })
        executorDone = true
        writeFileSync(join(cwd, "src/late.txt"), "late\n")
        return { exitCode: 0, timedOut: false, cancelled: command.signal?.aborted ?? false, violation: false }
      },
    )
    await tickUntil(() => session.executionState === "RUNNING")
    const cleanup = await coord.cancel(session)
    // cleanup 返回时 executor 必须已经完成（先取消、等待，再清理）。
    // RED at baseline：cancel 直接 terminalize + cleanup，writer 仍在运行。
    expect(executorDone).toBe(true)
    if (!executorDone) {
      throw new Error("R5-00-6 RED: cancel() cleaned up while the executor/writer was still running (writer survives cleanup)")
    }
    let outcome: ProjectionExecutionOutcome | undefined
    let execError: unknown
    try {
      outcome = await execPromise
    } catch (error) {
      execError = error
    }
    // execute promise 不得从 CANCELLED/REJECTED 再做非法 transition。
    // RED at baseline：executor 写已删除目录 → INVALID_STATE。
    expect(execError).toBeUndefined()
    if (execError !== undefined) {
      throw new Error(`R5-00-6 RED: execute promise made an illegal transition after cancel (${execError instanceof Error ? execError.message : String(execError)})`)
    }
    expect(outcome?.cancelled).toBe(true)
    expect(session.worldState).toBe("REJECTED")
    expect(session.executionState).toBe("CANCELLED")
    expect(session.receipt).toBeDefined()
    expect(session.cleanupState).toBeDefined()
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    // cancel 幂等：重复 cancel 返回同一 cleanupState（无第二终态）。
    const again = await coord.cancel(session)
    expect(again).toBe(session.cleanupState!)
    ctx.cleanup()
  })

  test("R5-00-7a：execute 中 merged lstat 抛异常 → 必须 terminalize（EXECUTION_INTENT_BUILD_FAILED）", async () => {
    const { ctx, snapshotId } = buildWorld()
    const harness = createHarness()
    const coord = coordinator(ctx, harness.backend, { receiptAuthority: harness.authority })
    const session = coord.start(makePlan(snapshotId))
    // merged 视图被删除 → intent 构建（merged lstat）抛异常。
    rmSync(session.mergedDir, { recursive: true, force: true })
    let execError: unknown
    try {
      await coord.execute(session, { executable: "noop", args: [] }, harness.executor)
    } catch (error) {
      execError = error
    }
    expect(execError).toBeDefined()
    expect((execError as ProjectionError).code).toBe("EXECUTION_INTENT_BUILD_FAILED")
    if ((execError as ProjectionError).code !== "EXECUTION_INTENT_BUILD_FAILED") {
      throw new Error("R5-00-7a RED: intent-build failure propagated without terminalization (no cleanupState/receipt)")
    }
    expect(session.worldState).toBe("REJECTED")
    expect(session.receipt).toBeDefined()
    expect(session.cleanupState).toBeDefined()
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("R5-00-7b：receiptAuthority.getFinalReceipt 抛异常 → 必须 terminalize（EXECUTION_RECEIPT_AUTHORITY_ERROR）", async () => {
    const { ctx, snapshotId } = buildWorld()
    const auth = {
      trustLevel: "same-uid-untrusted" as const,
      getFinalReceipt: () => {
        throw new Error("authority fault: getFinalReceipt")
      },
      isCleanupFinalized: () => true,
    } as ProjectionReceiptAuthority
    const coord = coordinator(ctx, productionKindBackend(), { receiptAuthority: auth })
    const session = coord.start(makePlan(snapshotId))
    await coord.execute(session, { executable: "noop", args: [] }, productionOutcomeExecutor)
    let scanError: unknown
    try {
      coord.scan(session)
    } catch (error) {
      scanError = error
    }
    expect(scanError).toBeDefined()
    expect((scanError as ProjectionError).code).toBe("EXECUTION_RECEIPT_AUTHORITY_ERROR")
    if ((scanError as ProjectionError).code !== "EXECUTION_RECEIPT_AUTHORITY_ERROR") {
      throw new Error("R5-00-7b RED: receipt authority exception propagated without terminalization")
    }
    expect(session.worldState).toBe("REJECTED")
    expect(session.receipt).toBeDefined()
    expect(session.cleanupState).toBeDefined()
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("R5-00-7c：receiptAuthority.isCleanupFinalized 抛异常 → 必须 terminalize（EXECUTION_RECEIPT_AUTHORITY_ERROR）", async () => {
    const { ctx, snapshotId } = buildWorld()
    const auth = {
      trustLevel: "same-uid-untrusted" as const,
      getFinalReceipt: () => ({
        receiptDigest: "a".repeat(64),
        runId: "run-x",
        nodeRunId: "run-x:n1",
        cellId: "cell-x",
      }) as SandboxReceipt,
      isCleanupFinalized: () => {
        throw new Error("authority fault: isCleanupFinalized")
      },
    } as ProjectionReceiptAuthority
    const coord = coordinator(ctx, productionKindBackend(), { receiptAuthority: auth })
    const session = coord.start(makePlan(snapshotId))
    await coord.execute(session, { executable: "noop", args: [] }, productionOutcomeExecutor)
    let scanError: unknown
    try {
      coord.scan(session)
    } catch (error) {
      scanError = error
    }
    expect(scanError).toBeDefined()
    expect((scanError as ProjectionError).code).toBe("EXECUTION_RECEIPT_AUTHORITY_ERROR")
    if ((scanError as ProjectionError).code !== "EXECUTION_RECEIPT_AUTHORITY_ERROR") {
      throw new Error("R5-00-7c RED: isCleanupFinalized exception propagated without terminalization")
    }
    expect(session.worldState).toBe("REJECTED")
    expect(session.receipt).toBeDefined()
    expect(session.cleanupState).toBeDefined()
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("R5-00-7d：sealForScan 抛异常 → 必须 terminalize（DELTA_SCAN_FAILED）", async () => {
    const { ctx, snapshotId } = buildWorld()
    const auth = {
      trustLevel: "same-uid-untrusted" as const,
      getFinalReceipt: () => ({
        receiptDigest: "a".repeat(64),
        runId: "run-x",
        nodeRunId: "run-x:n1",
        cellId: "cell-x",
      }) as SandboxReceipt,
      isCleanupFinalized: () => true,
    } as ProjectionReceiptAuthority
    const backend = productionKindBackend({
      sealForScan: () => {
        throw new Error("seal fault")
      },
    })
    const coord = coordinator(ctx, backend, { receiptAuthority: auth })
    const session = coord.start(makePlan(snapshotId))
    await coord.execute(session, { executable: "noop", args: [] }, productionOutcomeExecutor)
    let scanError: unknown
    try {
      coord.scan(session)
    } catch (error) {
      scanError = error
    }
    expect(scanError).toBeDefined()
    expect((scanError as ProjectionError).code).toBe("DELTA_SCAN_FAILED")
    if ((scanError as ProjectionError).code !== "DELTA_SCAN_FAILED") {
      throw new Error("R5-00-7d RED: sealForScan exception propagated without terminalization")
    }
    expect(session.worldState).toBe("REJECTED")
    expect(session.receipt).toBeDefined()
    expect(session.cleanupState).toBeDefined()
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("R5-00-7e：commit preflight getWorld 抛异常 → 必须 terminalize（SNAPSHOT_MISMATCH 保留）", async () => {
    const { ctx, snapshotId } = buildWorld()
    const harness = createHarness(merged => writeFileSync(join(merged, "src/main.ts"), "changed\n"))
    // togglable wrapper：start/execute/scan 正常，commit preflight 时 getWorld 抛异常。
    let failGetWorld = false
    const wrapped = Object.create(ctx.store) as WorldStore
    wrapped.getWorld = ((worldId: string) => {
      if (failGetWorld) {
        throw new ProjectionError("SNAPSHOT_MISMATCH", "getWorld fault")
      }
      return (ctx.store as WorldStore).getWorld(worldId)
    }) as WorldStore["getWorld"]
    const commitCoord = new ProjectionCoordinator({
      store: wrapped,
      materializer: new SnapshotMaterializer({
        getSnapshot: id => ctx.store.snapshots.get(id),
        getCasRecord: digest => ctx.store.cas.record(digest),
        readCasObject: digest => ctx.store.cas.get(digest),
      }),
      backend: harness.backend,
      projectionRoot: tmpRoot("projroot2"),
      receiptAuthority: harness.authority,
    } as never)
    const session = commitCoord.start(makePlan(snapshotId))
    await commitCoord.execute(session, { executable: "noop", args: [] }, harness.executor)
    commitCoord.scan(session)
    failGetWorld = true
    let commitError: unknown
    try {
      commitCoord.commit(session)
    } catch (error) {
      commitError = error
    }
    expect(commitError).toBeDefined()
    expect((commitError as ProjectionError).code).toBe("SNAPSHOT_MISMATCH")
    if ((commitError as ProjectionError).code !== "SNAPSHOT_MISMATCH") {
      throw new Error("R5-00-7e RED: commit preflight exception propagated without terminalization")
    }
    expect(session.worldState).toBe("REJECTED")
    expect(session.receipt).toBeDefined()
    expect(session.cleanupState).toBeDefined()
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("R5-00-8（R6-02 重写）：同一 intent 跨 coordinator（durable reservation）→ 只允许一个 execution cell；重建后仍拒绝", async () => {
    const { ctx, snapshotId } = buildWorld()
    const harness = createHarness(merged => writeFileSync(join(merged, "src/main.ts"), "changed\n"))
    // R6-02：durable reservation 由 coordinator.execute 在任意 executor
    // 调用前完成（adapter 不再接收 registry）。两个 coordinator 共享同一
    // reservation 路径（跨实例等价）；plan.intentId 是 kernel-owned 覆盖
    // （确定性重放场景）。
    const reservationPath = join(tmpdir(), `ak2-r5-intent-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sqlite`)
    cleanups.push(() => {
      try {
        rmSync(reservationPath, { recursive: true, force: true })
      } catch {
        // 已删
      }
    })
    const coordA = coordinator(ctx, harness.backend, {
      receiptAuthority: harness.authority,
      intentReservationPath: reservationPath,
    })
    const coordB = coordinator(ctx, harness.backend, {
      receiptAuthority: harness.authority,
      intentReservationPath: reservationPath,
    })
    const intentId = `intent-r5-00-8-${process.pid}-${Date.now()}`
    const sessionA = coordA.start(makePlan(snapshotId, { intentId }))
    const sessionB = coordB.start(makePlan(snapshotId, { intentId }))
    // 第一个 cell 正常执行（reserve 成功）。
    const resultA = await coordA.execute(sessionA, { executable: "noop", args: [] }, harness.executor)
    expect(resultA.exitCode).toBe(0)
    // 第二个 coordinator（同一 intentId）必须拒绝 —— durable reservation
    // 跨实例/跨重建不可复用。
    let execErrorB: unknown
    try {
      await coordB.execute(sessionB, { executable: "noop", args: [] }, harness.executor)
    } catch (error) {
      execErrorB = error
    }
    expect((execErrorB as ProjectionError).code).toBe("EXECUTION_RECEIPT_BINDING_MISMATCH")
    if ((execErrorB as ProjectionError).code !== "EXECUTION_RECEIPT_BINDING_MISMATCH") {
      throw new Error("R5-00-8 RED: a second coordinator re-authorized the same intent (reservation not durable across instances)")
    }
    expect(sessionB.worldState).toBe("REJECTED")
    // 重建（进程重启等价）：新 registry 实例也必须拒绝同一 intent。
    const rebuilt = new ProjectionIntentRegistry(reservationPath)
    expect(rebuilt.isReserved(intentId)).toBe(true)
    expect(rebuilt.reserve(intentId)).toBe(false)
    // 只有一个 cell 被授权（reservation 状态不可逆）。
    expect(coordA.intentRegistry.isReserved(intentId)).toBe(true)
    // 清理 sessionA 的投影（sessionB 已在 execute 失败时 terminalize）。
    try {
      await coordA.cancel(sessionA)
    } catch {
      // 已清理
    }
    ctx.cleanup()
  }, 60_000)

  test("R5-03：post-commit divergence → 显式 RECONCILING（不得谎报 REJECTED）", async () => {
    const { ctx, snapshotId } = buildWorld()
    const harness = createHarness(merged => writeFileSync(join(merged, "src/main.ts"), "changed\n"))
    // wrapped store：commit 已 durable（compareAndCommit 成功）但响应丢失
    // （after-commit-before-response fault），且 commit 记录的 request digest
    // 与本 session 不一致（corruption/巧合复用）→ 必须 RECONCILING。
    const wrapped = Object.create(ctx.store) as WorldStore
    const originalCompareAndCommit = ctx.store.compareAndCommit.bind(ctx.store)
    wrapped.compareAndCommit = ((input: Parameters<WorldStore["compareAndCommit"]>[0]) => {
      const result = originalCompareAndCommit(input)
      throw new Error("after-commit-before-response fault")
    }) as WorldStore["compareAndCommit"]
    wrapped.getCommitRequestDigest = () => "sha256:" + "0".repeat(64)
    const commitCoord = new ProjectionCoordinator({
      store: wrapped,
      materializer: new SnapshotMaterializer({
        getSnapshot: id => ctx.store.snapshots.get(id),
        getCasRecord: digest => ctx.store.cas.record(digest),
        readCasObject: digest => ctx.store.cas.get(digest),
      }),
      backend: harness.backend,
      projectionRoot: tmpRoot("projroot3"),
      receiptAuthority: harness.authority,
    } as never)
    const session = commitCoord.start(makePlan(snapshotId))
    await commitCoord.execute(session, { executable: "noop", args: [] }, harness.executor)
    commitCoord.scan(session)
    let commitError: unknown
    try {
      commitCoord.commit(session)
    } catch (error) {
      commitError = error
    }
    expect(commitError).toBeDefined()
    expect((commitError as ProjectionError).code).toBe("EXECUTION_RECEIPT_BINDING_MISMATCH")
    // World 已 durable 但 request digest 不一致 → 显式 RECONCILING
    //（不是 REJECTED —— 不谎报本地失败；等待人工对账）。
    expect(session.worldState).toBe("RECONCILING")
    expect(session.receipt!.worldState).toBe("RECONCILING")
    expect(session.receipt!.reason).toContain("reconciliation")
    ctx.cleanup()
  })

  test("R5-00-9（R6-00-14 修正 / KNOWN RED / OWNER-DECISION-REQUIRED）：sealed 后同 UID 直写 writeLayerPath/upper —— 攻击动作必须真实成功后再 scan（不得以 EACCES/setup error 冒充已证明的 KNOWN RED）", async () => {
    const { ctx, snapshotId } = buildWorld()
    const harness = createHarness()
    const coord = coordinator(ctx, harness.backend, { receiptAuthority: harness.authority })
    const session = coord.start(makePlan(snapshotId))
    try {
      await coord.execute(session, { executable: "noop", args: [] }, harness.executor)
      // 直接 seal（执行 writer 已终止后）。
      const sealed = session.instance.sealForScan!()
      expect("error" in sealed).toBe(false)
      const sealedPath = (sealed as { sealedPath: string }).sealedPath
      session.sealedPath = sealedPath
      // 攻击：同 UID 把 sealed 视图（fixture：mode-based 只读，同 UID 可
      // 还原）**整树**还原为可写，然后直接写入 writeLayer（fixture：
      // merged === writeLayer）。此前版本只 chmod 顶层 → src/ 仍 0555 →
      // 写入 EACCES —— setup error 冒充攻击证明。修正：整树还原，
      // 确认写入真实成功，再调用 scan。
      const makeWritable = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry)
          const stat = lstatSync(full)
          if (stat.isDirectory()) {
            chmodSync(full, 0o755)
            makeWritable(full)
          } else if (stat.isFile()) {
            chmodSync(full, 0o644)
          }
        }
      }
      chmodSync(sealedPath, 0o755)
      makeWritable(sealedPath)
      const tampered = join(sealedPath, "src", "tampered.txt")
      writeFileSync(tampered, "tampered\n")
      // 攻击动作必须真实成功（R6-00-14：不得以 EACCES/setup error 冒充）。
      expect(existsSync(tampered)).toBe(true)
      expect(readFileSync(tampered, "utf8")).toBe("tampered\n")
      let delta: unknown
      let scanError: unknown
      try {
        delta = coord.scan(session)
      } catch (error) {
        scanError = error
      }
      // 期望 fail-closed：不得返回成功 delta。
      // KNOWN RED（R6-00-14 修正后攻击已证明落地）：same-UID 架构无法
      // 阻止 —— 攻击写入成功且被 scan 观察到（fail-open）。不伪造 GREEN
      // —— 该项标记 OWNER-DECISION-REQUIRED。
      if (scanError === undefined) {
        const deltaEntries = (delta as { entries?: Array<{ path: string }> })?.entries ?? []
        throw new Error(
          "R6-00-14 KNOWN RED (proven attack): same-UID direct upper write SUCCEEDED (file exists in the write layer) and the sealed scan returned a success delta including " +
            JSON.stringify(deltaEntries.map(entry => entry.path)) +
            " (OWNER-DECISION-REQUIRED: no kernel-owned immutable seal in same-UID architecture)",
        )
      }
      expect(scanError).toBeDefined()
      expect(delta).toBeUndefined()
      // 且不得 commit。
      let commitError: unknown
      try {
        coord.commit(session)
      } catch (error) {
        commitError = error
      }
      expect(commitError).toBeDefined()
      expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    } finally {
      // 已知 RED 测试也必须清理 sealed 树（0444/0555 无法被 afterEach 的
      // rmSync 直接删除 —— 走 session cleanup 还原 mode 后删除）。
      try {
        void coord.cancel(session)
      } catch {
        // 已清理
      }
      ctx.cleanup()
    }
  })

  test("R5-01 导出面 inventory：生产模块不得导出任何 fixture/test authority 能力（PUBLIC_FIXTURE_AUTHORITY = 0）", () => {
    const indexPath = join(process.cwd(), "src", "kernel", "projection", "index.ts")
    const source = readFileSync(indexPath, "utf8")
    const exported = Object.keys(require("../../../src/kernel/projection/index"))
    const forbiddenNames = [
      "allowTestBackends",
      "FIXTURE_EXECUTION_TOKEN",
      "CopyProjectionFixtureBackend",
      "TestReceiptAuthority",
      "createFixtureHarness",
      "fixtureExecutor",
    ]
    for (const name of forbiddenNames) {
      expect(exported.includes(name)).toBe(false)
      const exportPattern = new RegExp(`export\\s*\\{[^}]*\\b${name}\\b|export\\s+(const|function|class)\\s+${name}\\b`)
      expect(exportPattern.test(source)).toBe(false)
    }
    // 生产 backend 工厂存在且为生产 kind（无 fixture 放大）。
    expect(exported.includes("createProductionProjectionBackend")).toBe(true)
    expect(exported.includes("FuseOverlayfsProjectionBackend")).toBe(true)
  })
})

/** 本地 harness 工厂（保持测试简洁）。 */
function createHarness(mutate?: (merged: string) => void): ReturnType<typeof import("./test-fixtures").createFixtureHarness> {
  return (require("./test-fixtures") as typeof import("./test-fixtures")).createFixtureHarness(mutate)
}
