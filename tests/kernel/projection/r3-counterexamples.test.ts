/**
 * AK2-R3 Correction Gate —— R3-00 先红反例冻结。
 *
 * 每个反例在修复前必须 RED（断言生产代码当前错误行为），修复后 GREEN。
 * 分三层：
 * - FIXTURE：fixture backend + fake receipt authority（deterministic）；
 * - REAL：真实 fuse-overlayfs / 磁盘 receipt store；
 * - OWNER-DECISION-REQUIRED：证明性测试（记录 authority 缺口，不要求修复）。
 */

import { afterEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ProjectionError } from "../../../src/kernel/projection/contracts"
import { ProjectionCoordinator, expectedProjectionFilesystemPolicyDigest, type ProjectionExecutor, type ProjectionSession } from "../../../src/kernel/projection/coordinator"
import { SnapshotMaterializer } from "../../../src/kernel/projection/materializer"
import {
  CopyProjectionFixtureBackend,
  TestProjectionCoordinator,
  TestReceiptAuthority,
  fixtureExecutor,
} from "./test-fixtures"
import {
  FuseOverlayfsProjectionBackend,
  type NativeProjectionBackend,
  type ProjectionInstance,
} from "../../../src/kernel/projection/backend"
import { validateWorldProjectionPlan, type WorldProjectionPlanInput } from "../../../src/kernel/projection/plan"
import { createTestWorldStore, type TestWorldStore } from "../world/helpers"
import type { WorldProjectionPlan } from "../../../src/kernel/projection/contracts"
import type { CasDigest } from "../../../src/kernel/world"
import type { SandboxReceipt } from "../../../src/runtime/linux/contracts"
import { RuntimeStateReceiptAuthority, type ProjectionReceiptAuthority } from "../../../src/kernel/projection/receipt-authority"
import { RuntimeStateStore } from "../../../src/runtime/linux/recovery/state-store"
import { createHash } from "node:crypto"
import { scanProjectionDelta } from "../../../src/kernel/projection/scanner"

/** 内存 CAS（scanner 测试同构）。 */
class MemCas {
  readonly objects = new Map<string, Buffer>()
  put(content: Uint8Array, _mediaType = "application/octet-stream") {
    const bytes = Buffer.from(content)
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as CasDigest
    if (!this.objects.has(digest)) this.objects.set(digest, bytes)
    return { digest, size: bytes.byteLength, mediaType: "", mediaTypes: [], isManifest: false, createdAt: 0, refCount: 0 }
  }
  has(digest: CasDigest): boolean {
    return this.objects.has(digest)
  }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ak2-r3-${label}-`))
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      // ENOENT → 已删（幂等竞态）；其它删除失败必须可见，不得静默吞掉。
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.error(`[ak2-test-cleanup] rmSync(${dir}) failed; residue may remain`, error)
      }
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
    purpose: "ak2 r3",
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
      // R6-03：plan 声明的 readonlyRoots 必须在 World 中存在（kernel spec
      // compiler 对 required mount source 做存在性校验）。
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

/** R5-01：不存在 receiptless 分支 —— fixture 执行也必须产出 receipt
 *  （TestReceiptAuthority；test-only）。activeAuthority 由 coordinator 工厂
 *  设置，mutateExecutor 注册到同一 authority。 */
let activeAuthority: TestReceiptAuthority

function coordinator(
  ctx: TestWorldStore,
  backend?: NativeProjectionBackend | CopyProjectionFixtureBackend,
  receiptAuthority?: ProjectionReceiptAuthority,
): ProjectionCoordinator {
  const materializer = new SnapshotMaterializer({
    getSnapshot: id => ctx.store.snapshots.get(id),
    getCasRecord: digest => ctx.store.cas.record(digest),
    readCasObject: digest => ctx.store.cas.get(digest),
  })
  const effective = receiptAuthority ?? new TestReceiptAuthority()
  if (effective instanceof TestReceiptAuthority) activeAuthority = effective
  // R7-01：正向 fixture 测试经 TestProjectionCoordinator test-only
  // composition 进入 commit 路径（生产 gate 恒 fail-closed）。
  return new TestProjectionCoordinator({
    store: ctx.store,
    materializer,
    backend: (backend ?? new CopyProjectionFixtureBackend()) as unknown as NativeProjectionBackend,
    projectionRoot: tmpRoot("projroot"),
    receiptAuthority: effective,
    // R7-03：durable reservation path 是必填 kernel 配置（测试用 per-test 路径）。
    intentReservationPath: join(tmpRoot("res"), "res.sqlite"),
  })
}

function mutateExecutor(actions: (merged: string) => void): ProjectionExecutor {
  // fakeAuthority 流程中注册的 receipt 会被 bindOutcome 覆盖（仅 scan 门需要）；
  // 缺省流程用 coordinator 的 TestReceiptAuthority。
  return fixtureExecutor(activeAuthority ?? new TestReceiptAuthority(), actions)
}

/** fake final receipt（digest 自洽；与 coordinator.test.ts 同构）。 */
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

function fakeAuthority(overrides: Partial<SandboxReceipt> & { hidden?: boolean } = {}): ProjectionReceiptAuthority & {
  setIntentDigest(digest: string | undefined): void
  setFilesystemPolicyDigest(digest: string): void
  setCellSpecDigest(digest: string): void
  setCleanupFinalized(finalized: boolean): void
  currentDigest(): string | undefined
} {
  const { hidden, ...receiptOverrides } = overrides
  let intentDigest: string | undefined
  // R4-03.4：fake receipt 必须携带 coordinator 派生的期望 policy digest。
  let filesystemPolicyDigest = "d".repeat(64)
  // R6-03：commit 时 kernel 用 receipt 真实 cellId 重编译期望 spec digest ——
  // fake receipt 的 cellSpecDigest 必须由 bindIntent 从 session 派生。
  let cellSpecDigest = "c".repeat(64)
  let cleanupFinalized = true
  const seedReceipt = fakeFinalReceipt(receiptOverrides)
  let latestDigest: string | undefined = seedReceipt.receiptDigest
  const inner: ProjectionReceiptAuthority = {
    // R5-01：显式 trust level（test-harness —— 只可配对 test-only fixture）。
    // R6-01：test-harness brand（WeakSet）—— 结构化对象 + 公开字符串不再
    // 授予 commit 授权；仅 tests/** 构造的 branded fixture 配对可通过 gate。
    trustLevel: "test-harness" as const,
    getFinalReceipt: () => {
      if (hidden === true) return undefined
      if (intentDigest === undefined) return undefined
      const receipt = fakeFinalReceipt({ ...receiptOverrides, filesystemPolicyDigest, cellSpecDigest })
      const { receiptDigest: _rd, ...content } = receipt
      const withIntent = { ...content, projectionIntentDigest: intentDigest }
      const { computeReceiptDigest: crd } = require("../../../src/runtime/linux/receipt") as typeof import("../../../src/runtime/linux/receipt")
      latestDigest = crd(withIntent)
      return { ...content, projectionIntentDigest: intentDigest, receiptDigest: latestDigest }
    },
    isCleanupFinalized: () => cleanupFinalized,
  }
  // R7-01：test-only authority 只存在于 tests/**（无生产 brand）。
  return Object.assign(inner, {
    setIntentDigest(digest: string | undefined): void {
      intentDigest = digest
    },
    setFilesystemPolicyDigest(digest: string): void {
      filesystemPolicyDigest = digest
    },
    setCellSpecDigest(digest: string): void {
      cellSpecDigest = digest
    },
    setCleanupFinalized(finalized: boolean): void {
      cleanupFinalized = finalized
    },
    currentDigest(): string | undefined {
      if (intentDigest === undefined) return latestDigest
      const { computeReceiptDigest: crd } = require("../../../src/runtime/linux/receipt") as typeof import("../../../src/runtime/linux/receipt")
      const { receiptDigest: _rd, ...content } = fakeFinalReceipt({ ...receiptOverrides, filesystemPolicyDigest, cellSpecDigest })
      return crd({ ...content, projectionIntentDigest: intentDigest })
    },
  })
}

function bindIntent(auth: ReturnType<typeof fakeAuthority>, session: ProjectionSession): void {
  const { projectionIntentDigest } = require("../../../src/kernel/projection/contracts") as typeof import("../../../src/kernel/projection/contracts")
  const { expectedProjectionFilesystemPolicyDigest } = require("../../../src/kernel/projection/coordinator") as typeof import("../../../src/kernel/projection/coordinator")
  const { expectedProjectionCellSpecDigestForCell } = require("../../../src/kernel/projection/spec-binding") as typeof import("../../../src/kernel/projection/spec-binding")
  auth.setIntentDigest(projectionIntentDigest(session.intent))
  // R4-03.4：fake receipt 的 filesystemPolicyDigest 必须等于 coordinator
  // 从 kernel-owned input 派生的期望值（receipt 与期望比对，非自报互比）。
  auth.setFilesystemPolicyDigest(expectedProjectionFilesystemPolicyDigest(session.plan, session.mergedDir))
  // R6-03：fake receipt 的 cellSpecDigest 必须等于 kernel 用 receipt 真实
  // cellId（cell-fake）重编译的期望 spec digest。
  auth.setCellSpecDigest(expectedProjectionCellSpecDigestForCell(session.intent, session.mergedDir, session.plan.writableRoots, "cell-fake"))
}

async function sessionAtDeltaReady(
  coord: ProjectionCoordinator,
  plan: WorldProjectionPlan,
  // R7 调和：ctx 未在函数体中使用 —— 下划线前缀保留形参位（调用点位置兼容）。
  _ctx: TestWorldStore,
  actions: (merged: string) => void = merged => writeFileSync(join(merged, "src/main.ts"), "changed\n"),
  auth?: ReturnType<typeof fakeAuthority>,
): Promise<ProjectionSession> {
  const session = coord.start(plan)
  await coord.execute(session, { executable: "noop", args: [] }, mutateExecutor(actions))
  // R4-00-7/R4-01：production backend 的 scan 需要 finalized receipt/
  // cleanup proof —— 测试在 scan 前绑定 fake authority outcome。
  if (auth !== undefined) {
    bindIntent(auth, session)
    bindOutcome(session, auth)
  }
  coord.scan(session)
  return session
}

function bindOutcome(session: ProjectionSession, auth: ReturnType<typeof fakeAuthority>): void {
  session.outcome = {
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    violation: false,
    executionReceiptId: auth.currentDigest()!,
    receiptBinding: {
      runId: "run-fake",
      nodeRunId: "run-fake:n1",
      cellId: "cell-fake",
      // R6-03：claim 的 cellSpecDigest 必须与 receipt 一致（kernel 用真实
      // cellId 重编译派生 —— 不硬编码）。
      cellSpecDigest: (() => {
        const { expectedProjectionCellSpecDigestForCell } = require("../../../src/kernel/projection/spec-binding") as typeof import("../../../src/kernel/projection/spec-binding")
        return expectedProjectionCellSpecDigestForCell(session.intent, session.mergedDir, session.plan.writableRoots, "cell-fake")
      })(),
      filesystemPolicyDigest: expectedProjectionFilesystemPolicyDigest(session.plan, session.mergedDir),
      workspaceHostRoot: session.mergedDir,
    },
  }
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
      // R6-03：kernel-owned spec compiler 对 required mount source 做
      // 存在性校验 —— stub 必须镜像 plan 声明的 roots（含 readonlyRoots）。
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

describe("AK2-R3 反例（R3-00 先红冻结）", () => {
  test("R3-00-1：production backend + receiptless 必须结构性拒绝（构造即要求 receipt authority）", () => {
    const { ctx } = buildWorld()
    const materializer = new SnapshotMaterializer({
      getSnapshot: id => ctx.store.snapshots.get(id),
      getCasRecord: digest => ctx.store.cas.record(digest),
      readCasObject: digest => ctx.store.cas.get(digest),
    })
    // R5-01：所有 backend（含 fixture）构造时结构性要求 receipt authority。
    let refused = false
    try {
      new ProjectionCoordinator({
        store: ctx.store,
        materializer,
        backend: productionKindBackend(),
        projectionRoot: tmpRoot("prod"),
      } as never)
    } catch (error) {
      refused = (error as ProjectionError).code === "EXECUTION_RECEIPT_REQUIRED"
    }
    expect(refused).toBe(true)
    ctx.cleanup()
  })

  test("R5-01：fixture backend 无 receipt authority 必须拒绝构造（receiptless 分支不存在）", () => {
    const { ctx } = buildWorld()
    const materializer = new SnapshotMaterializer({
      getSnapshot: id => ctx.store.snapshots.get(id),
      getCasRecord: digest => ctx.store.cas.record(digest),
      readCasObject: digest => ctx.store.cas.get(digest),
    })
    let refused = false
    try {
      new ProjectionCoordinator({
        store: ctx.store,
        materializer,
        backend: new CopyProjectionFixtureBackend(),
        projectionRoot: tmpRoot("nofix"),
      } as never)
    } catch (error) {
      refused = (error as ProjectionError).code === "EXECUTION_RECEIPT_REQUIRED"
    }
    expect(refused).toBe(true)
    ctx.cleanup()
  })

  test("R3-00-2：final receipt exitCode!=0 与 executor success outcome 冲突 → 拒绝", async () => {
    const { ctx, snapshotId } = buildWorld()
    // receipt 声称 exitCode=1（失败）但 outcome 是 success → 冲突必须拒绝。
    const auth = fakeAuthority({ exitCode: 1 })
    const coord = coordinator(ctx, undefined, auth)
    const session = await sessionAtDeltaReady(coord, makePlan(snapshotId), ctx, undefined, auth)
    try {
      coord.commit(session)
      throw new Error("R3-00-2 RED: receipt exitCode=1 accepted with success outcome")
    } catch (error) {
      expect((error as ProjectionError).code).toMatch(/EXECUTION_RECEIPT_BINDING_MISMATCH|EXECUTION_RECEIPT_REPLAY/)
    }
    expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
    ctx.cleanup()
  })

  test("R3-00-2b：final receipt timedOut/cancelled/violations 与 success outcome 冲突 → 拒绝", async () => {
    for (const overrides of [{ timedOut: true }, { cancelled: true }, { violations: [{ kind: "policy" as const, detail: "x" }] }]) {
      const { ctx, snapshotId } = buildWorld()
      const auth = fakeAuthority(overrides as Partial<SandboxReceipt>)
      const coord = coordinator(ctx, undefined, auth)
      const session = await sessionAtDeltaReady(coord, makePlan(snapshotId), ctx, undefined, auth)
      try {
        coord.commit(session)
        throw new Error("R3-00-2b RED: conflicting receipt accepted")
      } catch (error) {
        expect((error as ProjectionError).code).toMatch(/EXECUTION_RECEIPT_BINDING_MISMATCH|EXECUTION_RECEIPT_REPLAY/)
      }
      expect(ctx.store.getWorld("world-c")!.currentRevision).toBe(1n)
      ctx.cleanup()
    }
  })

  test("R3-00-3 OWNER-DECISION-REQUIRED：同 UID 修改 receipt 并重算公开 digest 仍被 authority 接受（无密钥 authority 缺口证据）", () => {
    // 证明性测试：生产 authority 基于公开 sha256 digest + 文件可写。
    // 同 UID 攻击者可修改 cleanup truth（mountsReleased=false→true）并重算
    // digest —— 当前实现会接受。无独立 UID/受保护 daemon/MAC key 无法区分
    // 真伪 —— 该子项标记 OWNER-DECISION-REQUIRED（R3-01.6）。
    const root = tmpRoot("odr")
    const store = new RuntimeStateStore({ root })
    const auth = new RuntimeStateReceiptAuthority(store)
    const runId = `run-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    const cellId = "cell-tampered"
    const dir = join(root, "runs", runId, "receipts")
    mkdirSync(dir, { recursive: true })
    // 1. 合法 final receipt（cleanup 未证明：mountsReleased=false）。
    const legit = fakeFinalReceipt()
    legit.cleanup = { ...legit.cleanup!, mountsReleased: false }
    const { computeReceiptDigest } = require("../../../src/runtime/linux/receipt") as typeof import("../../../src/runtime/linux/receipt")
    writeFileSync(join(dir, `${cellId}.json`), JSON.stringify({ ...legit, receiptDigest: computeReceiptDigest(legit) }))
    expect(auth.getFinalReceipt(runId, cellId)).toBeDefined()
    // 2. 同 UID 攻击：改 cleanup truth（mountsReleased=false→true +
    // cleanupVerified=true）并重算公开 digest。
    const forged = fakeFinalReceipt()
    forged.cleanup = { ...forged.cleanup!, mountsReleased: true, cleanupVerified: true }
    writeFileSync(join(dir, `${cellId}.json`), JSON.stringify({ ...forged, receiptDigest: computeReceiptDigest(forged) }))
    // 缺口证据：伪造被接受（当前实现无密钥真实性）。修复需要
    // OWNER-DECISION-REQUIRED（独立 UID / daemon / MAC key / 可信 IPC）。
    const accepted = auth.getFinalReceipt(runId, cellId)
    expect(accepted).toBeDefined()
    expect(accepted!.cleanup!.mountsReleased).toBe(true)
    // 说明：本测试 PASS 即证明缺口存在（公开 hash 不是真实性）。
  })

  test("R3-00-4：execute 后 mount ownership 丢失 → 必须进入终态并 cleanup", async () => {
    const { ctx, snapshotId } = buildWorld()
    let owned = true
    const backend = productionKindBackend({
      assertMountOwned: () => owned,
    })
    const coord = coordinator(ctx, backend, fakeAuthority())
    const session = coord.start(makePlan(snapshotId))
    owned = true
    try {
      await coord.execute(session, { executable: "noop", args: [] }, mutateExecutor(() => {
        // 执行期间 mount 被替换（execute 后复核失败 → terminalize）。
        owned = false
      }))
    } catch (error) {
      void error // 基线约定：best-effort 清理/预期失败，显式吞掉（不掩盖测试主体结果）
      // execute 后 ownership 检查失败 → 终态 + cleanup（R3-02 terminalizer）。
    }
    // R3-00-4：execute 后 ownership 复核失败必须 terminalize（REJECTED +
    // cleanupState 记录 + terminal receipt）。
    try {
      coord.scan(session)
      throw new Error("R3-00-4 RED: scan after ownership loss not rejected")
    } catch (error) {
      expect(session.worldState).toBe("REJECTED")
      // 执行本身成功（COMPLETED 事实）—— ownership 丢失使 world 进入终态。
      expect(session.executionState).toBe("COMPLETED")
      expect(session.cleanupState).toBeDefined()
      expect(session.receipt).toBeDefined()
      expect(session.receipt!.worldState).toBe("REJECTED")
      expect((error as ProjectionError).code).toMatch(/PROJECTION_NOT_PROJECTED|CLEANED_SESSION_REUSED/)
    }
    ctx.cleanup()
  })

  test("R3-00-5：scan 前 ownership 丢失 → 必须进入终态并 cleanup", async () => {
    const { ctx, snapshotId } = buildWorld()
    let owned = true
    const backend = productionKindBackend({ assertMountOwned: () => owned })
    const coord = coordinator(ctx, backend, fakeAuthority())
    const session = coord.start(makePlan(snapshotId))
    await coord.execute(session, { executable: "noop", args: [] }, mutateExecutor(() => {}))
    owned = false
    try {
      coord.scan(session)
      throw new Error("R3-00-5 RED: scan accepted after ownership loss")
    } catch (error) {
      expect(session.worldState).toBe("REJECTED")
      expect(session.cleanupState).toBeDefined()
      expect(session.receipt).toBeDefined()
      expect(session.receipt!.worldState).toBe("REJECTED")
      expect((error as ProjectionError).code).toBe("PROJECTION_NOT_PROJECTED")
    }
    ctx.cleanup()
  })

  test("R3-00-6：scan 中 cleanup() 抛异常仍必须产生确定终态和 receipt", async () => {
    const { ctx, snapshotId } = buildWorld()
    const auth = fakeAuthority()
    const backend = productionKindBackend({
      cleanup: () => {
        throw new Error("R3-00-6 cleanup exploded")
      },
    })
    const coord = coordinator(ctx, backend, auth)
    const session = coord.start(makePlan(snapshotId))
    await coord.execute(session, { executable: "noop", args: [] }, mutateExecutor(merged => {
      // symlink 条目使 scan 必然失败（DELTA_SCAN_FAILED）→ 触发 cleanup。
      symlinkSync("/nonexistent-sentinel", join(merged, "evil-link"))
    }))
    // production scan 需要 finalized receipt/cleanup proof（R4-00-7）。
    bindIntent(auth, session)
    bindOutcome(session, auth)
    // scan 抛（symlink 拒绝）→ 失败路径触发 cleanup → cleanup 抛 → 必须
    // 仍 terminalize。
    try {
      coord.scan(session)
    } catch (error) {
      void error // 基线约定：best-effort 清理/预期失败，显式吞掉（不掩盖测试主体结果）
      // scan 失败路径触发 cleanup → cleanup 抛 → 必须仍 terminalize。
    }
    expect(session.worldState).toBe("REJECTED")
    expect(session.cleanupState).toBeDefined()
    expect(session.cleanupState!.cleanupOk).toBe(false)
    expect(session.cleanupState!.error).toBeDefined()
    expect(session.receipt).toBeDefined()
    expect(session.receipt!.worldState).toBe("REJECTED")
    ctx.cleanup()
  })

  test("R3-00-6b：commit 中 cleanup() 抛异常仍必须产生确定终态和 receipt", async () => {
    const { ctx, snapshotId } = buildWorld()
    const auth = fakeAuthority()
    const backend = productionKindBackend({
      cleanup: () => {
        throw new Error("R3-00-6b cleanup exploded")
      },
    })
    const coord = coordinator(ctx, backend, auth)
    const session = await sessionAtDeltaReady(coord, makePlan(snapshotId), ctx, undefined, auth)
    try {
      coord.commit(session)
    } catch (error) {
      void error // 基线约定：best-effort 清理/预期失败，显式吞掉（不掩盖测试主体结果）
      // commit 失败路径触发 cleanup → cleanup 抛 → 必须仍 terminalize。
    }
    expect(session.worldState).toBe("REJECTED")
    expect(session.cleanupState).toBeDefined()
    expect(session.cleanupState!.cleanupOk).toBe(false)
    expect(session.cleanupState!.error).toContain("R3-00-6b")
    expect(session.receipt).toBeDefined()
    expect(session.receipt!.worldState).toBe("REJECTED")
    ctx.cleanup()
  })

  test("R3-00-6c：cancel 中 cleanup() 抛异常仍必须产生确定终态", async () => {
    const { ctx, snapshotId } = buildWorld()
    const backend = productionKindBackend({
      cleanup: () => {
        throw new Error("R3-00-6c cleanup exploded")
      },
    })
    const coord = coordinator(ctx, backend, fakeAuthority())
    const session = coord.start(makePlan(snapshotId))
    coord.cancel(session)
    expect(session.worldState).toBe("REJECTED")
    expect(session.executionState).toBe("CANCELLED")
    expect(session.cleanupState).toBeDefined()
    expect(session.cleanupState!.cleanupOk).toBe(false)
    expect(session.cleanupState!.error).toContain("R3-00-6c")
    expect(session.receipt).toBeDefined()
    ctx.cleanup()
  })

  test("R3-00-7：start→cancel→execute/scan/commit 全部拒绝复用", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = coordinator(ctx, undefined)
    const session = coord.start(makePlan(snapshotId))
    coord.cancel(session)
    // execute 复用 → 拒绝。
    await expect(
      coord.execute(session, { executable: "noop", args: [] }, mutateExecutor(() => {})),
    ).rejects.toThrow("cleaned projection cannot be reused")
    // scan 复用 → 拒绝。
    expect(() => coord.scan(session)).toThrow(/cleaned projection cannot be reused|requires COMPLETED/)
    // commit 复用 → 拒绝。
    expect(() => coord.commit(session)).toThrow(/cleaned projection cannot be reused|requires DELTA_READY/)
    ctx.cleanup()
  })

  test("R3-00-8：foreign mount 替换后 cleanup 不得 unmount 或递归删除 foreign 内容（真实 FUSE）", () => {
    // 真实 fuse-overlayfs：本 session 挂载 → 卸载 → 同路径 foreign 重挂载
    //（新 upper）→ 旧 instance.cleanup() 必须返回 false 且不删除 foreign
    // 挂载内容、不卸载 foreign。
    const root = tmpRoot("foreign")
    const lower = join(root, "lower")
    mkdirSync(lower)
    writeFileSync(join(lower, "f.txt"), "x")
    chmodSync(lower, 0o755)
    const backend = new FuseOverlayfsProjectionBackend()
    const instance = backend.create({ lowerDir: lower, projectionRoot: root, label: "own" })
    expect(instance.assertMountOwned!()).toBe(true)
    instance.cleanup()
    expect(instance.assertMountOwned!()).toBe(false)
    // foreign 重挂载（同 merged 路径，新 upper/work）。
    const foreignUpper = join(root, "upper-foreign")
    const foreignWork = join(root, "work-foreign")
    mkdirSync(foreignUpper, { mode: 0o700 })
    mkdirSync(foreignWork, { mode: 0o700 })
    mkdirSync(join(root, "merged-own"), { mode: 0o700 })
    writeFileSync(join(foreignUpper, "foreign-marker.txt"), "foreign")
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process")
    execFileSync("fuse-overlayfs", ["-o", `lowerdir=${lower},upperdir=${foreignUpper},workdir=${foreignWork}`, join(root, "merged-own")])
    try {
      // 旧 instance cleanup：foreign（非 owned）→ 必须返回 false（failure），
      // 不得抛、不得卸载 foreign、不得删除 foreign 内容。
      const result = instance.cleanup()
      expect(result).toBe(false)
      // foreign 仍挂载且内容可见。
      const statfs = require("node:fs").statfsSync(join(root, "merged-own"))
      expect(statfs.type).toBe(0x65735546)
      expect(readFileSync(join(root, "merged-own", "foreign-marker.txt"), "utf8")).toBe("foreign")
      // foreign upper 未被删除。
      expect(readFileSync(join(foreignUpper, "foreign-marker.txt"), "utf8")).toBe("foreign")
    } finally {
      execFileSync("fusermount3", ["-u", join(root, "merged-own")], { stdio: "ignore" })
    }
  })

  test("R3-00-9：commit 成功后 runtime receipt 删除 + verifyIntegrity/gc → World CAS receipt 仍存在", async () => {
    const { ctx, snapshotId } = buildWorld()
    const auth = fakeAuthority()
    const coord = coordinator(ctx, undefined, auth)
    const session = await sessionAtDeltaReady(coord, makePlan(snapshotId), ctx, undefined, auth)
    const receipt = coord.commit(session)
    expect(receipt.newRevision).toBe(2n)
    const receiptCasDigest = `sha256:${auth.currentDigest()!}` as CasDigest
    expect(ctx.store.cas.has(receiptCasDigest)).toBe(true)
    // 删除 runtime receipt（模拟 store 被清理）→ CAS 恢复。
    auth.setIntentDigest(undefined)
    // gc：不得删除已提交 receipt（world_commit owner link 保护）。
    if (typeof (ctx.store.cas as { gc?: () => unknown }).gc === "function") {
      ;(ctx.store.cas as { gc: () => unknown }).gc()
    }
    expect(ctx.store.cas.has(receiptCasDigest)).toBe(true)
    // verifyIntegrity：commit row / CAS object / link 三者一致 → 0 issues。
    const issues = ctx.store.verifyIntegrity()
    expect(issues.filter((i: { code: string }) => i.code !== "CAS_ORPHANED_OBJECTS")).toEqual([])
    ctx.cleanup()
  })

  test("R3-00-10：stale/idempotency conflict 不得留下虚假 world_commit CAS link", () => {
    const ctx = createTestWorldStore()
    ctx.store.createWorld({ worldId: "w-link", branchId: "b", rootObjectId: "r", owner: "o", purpose: "p" })
    const d1 = ctx.store.cas.put(Buffer.from("x\n"), "text/plain").digest
    ctx.store.compareAndCommit({ worldId: "w-link", branchId: "b", baseRevision: 0n, actor: "a", mutations: [{ type: "object.put", objectId: "fa", objectType: "file", path: "a", contentRef: d1 }] })
    const receiptCas = ctx.store.cas.put(Buffer.from(JSON.stringify({ r: 1 })), "application/json").digest
    // stale commit（baseRevision 0 但 head 已 1）→ 拒绝。
    expect(() =>
      ctx.store.compareAndCommit({
        worldId: "w-link", branchId: "b", baseRevision: 0n, actor: "a", commitId: "c-stale",
        mutations: [{ type: "object.put", objectId: "fb", objectType: "file", path: "b", contentRef: d1 }],
        executionReceiptIds: [receiptCas],
      }),
    ).toThrow(/WORLD_CONFLICT|expected revision/)
    // 虚假 link 不得残留。
    const links = ctx.store.cas.linksForOwner("world_commit", "c-stale")
    expect(links.filter((l: { digest: string }) => l.digest === receiptCas)).toEqual([])
    ctx.cleanup()
  })

  test("R3-00-10b：idempotency conflict（同 commitId 不同请求）不得留下虚假 link", () => {
    const ctx = createTestWorldStore()
    ctx.store.createWorld({ worldId: "w-idem", branchId: "b", rootObjectId: "r", owner: "o", purpose: "p" })
    const d1 = ctx.store.cas.put(Buffer.from("x\n"), "text/plain").digest
    const receiptCas = ctx.store.cas.put(Buffer.from(JSON.stringify({ r: 1 })), "application/json").digest
    ctx.store.compareAndCommit({
      worldId: "w-idem", branchId: "b", baseRevision: 0n, actor: "a", commitId: "c-1",
      mutations: [{ type: "object.put", objectId: "fa", objectType: "file", path: "a", contentRef: d1 }],
    })
    // 同 commitId + 不同 mutations（含 receipt）→ idempotency conflict。
    expect(() =>
      ctx.store.compareAndCommit({
        worldId: "w-idem", branchId: "b", baseRevision: 0n, actor: "a", commitId: "c-1",
        mutations: [{ type: "object.put", objectId: "fb", objectType: "file", path: "b", contentRef: d1 }],
        executionReceiptIds: [receiptCas],
      }),
    ).toThrow(/idempotency conflict/)
    const links = ctx.store.cas.linksForOwner("world_commit", "c-1")
    expect(links.filter((l: { digest: string }) => l.digest === receiptCas)).toEqual([])
    ctx.cleanup()
  })

  test("R3-00-11：World namespace 反例（非 canonical path / 跨 commit file-parent / 祖先缺失）", () => {
    const mk = () => {
      const c = createTestWorldStore()
      c.store.createWorld({ worldId: "w-ns", branchId: "b", rootObjectId: "r", owner: "o", purpose: "p" })
      return c
    }
    // 11a: ../x 非 canonical → 拒绝。
    {
      const c = mk()
      const d = c.store.cas.put(Buffer.from("x\n"), "text/plain").digest
      expect(() =>
        c.store.compareAndCommit({ worldId: "w-ns", branchId: "b", baseRevision: 0n, actor: "a", mutations: [{ type: "object.put", objectId: "o1", objectType: "file", path: "../x", contentRef: d }] }),
      ).toThrow(/canonical|path/i)
      expect(c.store.getWorld("w-ns")!.currentRevision).toBe(0n)
      c.cleanup()
    }
    // 11b: a//b 非 canonical → 拒绝。
    {
      const c = mk()
      const d = c.store.cas.put(Buffer.from("x\n"), "text/plain").digest
      expect(() =>
        c.store.compareAndCommit({ worldId: "w-ns", branchId: "b", baseRevision: 0n, actor: "a", mutations: [{ type: "object.put", objectId: "o1", objectType: "file", path: "a//b", contentRef: d }] }),
      ).toThrow(/canonical|path/i)
      expect(c.store.getWorld("w-ns")!.currentRevision).toBe(0n)
      c.cleanup()
    }
    // 11c: 既有 file a 后 put a/b（file 成为祖先）→ 拒绝。
    {
      const c = mk()
      const d = c.store.cas.put(Buffer.from("x\n"), "text/plain").digest
      c.store.compareAndCommit({ worldId: "w-ns", branchId: "b", baseRevision: 0n, actor: "a", mutations: [{ type: "object.put", objectId: "fa", objectType: "file", path: "a", contentRef: d }] })
      expect(() =>
        c.store.compareAndCommit({ worldId: "w-ns", branchId: "b", baseRevision: 1n, actor: "a", mutations: [{ type: "object.put", objectId: "fb", objectType: "file", path: "a/b", contentRef: d }] }),
      ).toThrow(/file|ancestor|namespace/i)
      expect(c.store.getWorld("w-ns")!.currentRevision).toBe(1n)
      c.cleanup()
    }
    // 11d: 祖先缺失（put a/b 无 dir a）→ 拒绝（最终 namespace 完整性）。
    {
      const c = mk()
      const d = c.store.cas.put(Buffer.from("x\n"), "text/plain").digest
      expect(() =>
        c.store.compareAndCommit({ worldId: "w-ns", branchId: "b", baseRevision: 0n, actor: "a", mutations: [{ type: "object.put", objectId: "fb", objectType: "file", path: "a/b", contentRef: d }] }),
      ).toThrow(/ancestor|directory|namespace/i)
      expect(c.store.getWorld("w-ns")!.currentRevision).toBe(0n)
      c.cleanup()
    }
  })

  test("R3-00-12：onFileReadAfter 期间修改已处理 sibling → scanner 必须拒绝（terminal barrier）", () => {
    const root = tmpRoot("sib")
    const base = join(root, "base")
    const merged = join(root, "merged")
    mkdirSync(base)
    mkdirSync(merged)
    const cas = new MemCas()
    const baseIndex = new Map()
    writeFileSync(join(merged, "a.txt"), "AAAABBBB")
    writeFileSync(join(merged, "b.txt"), "CCCCDDDD")
    let hookRan = false
    try {
      scanProjectionDelta({
        baseDir: base,
        mergedDir: merged,
        baseIndex,
        cas,
        worldId: "w",
        branchId: "b",
        baseRevision: 1n,
        onFileReadAfter: (relative: string) => {
          if (relative !== "b.txt") return
          hookRan = true
          // 已处理 sibling 的 same-size 原地覆盖（a.txt 已 digest 完成）。
          writeFileSync(join(merged, "a.txt"), "BBBBAAAA")
        },
      })
      throw new Error("R3-00-12 RED: sibling mutation after digest accepted")
    } catch (error) {
      expect(hookRan).toBe(true)
      expect((error as ProjectionError).code).toBe("DELTA_SCAN_FAILED")
    }
  })

  test("R3-00-12b：onFileReadAfter 期间新增 sibling → scanner 必须拒绝", () => {
    const root = tmpRoot("sib2")
    const base = join(root, "base")
    const merged = join(root, "merged")
    mkdirSync(base)
    mkdirSync(merged)
    const cas = new MemCas()
    writeFileSync(join(merged, "a.txt"), "AAAABBBB")
    let hookRan = false
    try {
      scanProjectionDelta({
        baseDir: base,
        mergedDir: merged,
        baseIndex: new Map(),
        cas,
        worldId: "w",
        branchId: "b",
        baseRevision: 1n,
        onFileReadAfter: () => {
          if (hookRan) return
          hookRan = true
          writeFileSync(join(merged, "new-sibling.txt"), "NEW")
        },
      })
      throw new Error("R3-00-12b RED: new sibling after membership snapshot accepted")
    } catch (error) {
      expect(hookRan).toBe(true)
      expect((error as ProjectionError).code).toBe("DELTA_SCAN_FAILED")
    }
  })

  test("R3-00-13：projection root 内子项被 swap 为 symlink → 外部 sentinel 不得被 chmod/delete", async () => {
    const { ctx, snapshotId } = buildWorld()
    const coord = coordinator(ctx, undefined)
    const plan = makePlan(snapshotId)
    const session = coord.start(plan)
    // 在 merged 内创建子目录 + sentinel 在投影根外。
    const sentinel = join(tmpRoot("sentinel"), "sentinel.txt")
    writeFileSync(sentinel, "S")
    chmodSync(sentinel, 0o600)
    // 把 src 子项替换为 symlink → sentinel（root 本身身份未变；目标目录
    // 即 merged/src —— 在下方 executor 内经 merged 参数重新派生）。
    // 用真实 cleanup（commit 路径）验证 chmod 不跟随。
    await coord.execute(session, { executable: "noop", args: [] }, mutateExecutor(merged => {
      // 删除 src 内真实文件，放 symlink → sentinel。
      rmSync(join(merged, "src", "main.ts"), { force: true })
      symlinkSync(sentinel, join(merged, "src", "main.ts"))
    }))
    try {
      coord.scan(session)
    } catch (error) {
      void error // 基线约定：best-effort 清理/预期失败，显式吞掉（不掩盖测试主体结果）
      // scan 拒绝 symlink（DELTA_SCAN_FAILED）→ terminalize → cleanup
      //（fd 锚定删除，不得跟随 symlink chmod sentinel）。
    }
    try {
      coord.commit(session)
    } catch (error) {
      void error // 基线约定：best-effort 清理/预期失败，显式吞掉（不掩盖测试主体结果）
      // 已终态 → 复用拒绝。
    }
    const mode = statSync(sentinel).mode & 0o777
    expect(mode.toString(8)).toBe("600")
    expect(readFileSync(sentinel, "utf8")).toBe("S")
    ctx.cleanup()
  })
})
