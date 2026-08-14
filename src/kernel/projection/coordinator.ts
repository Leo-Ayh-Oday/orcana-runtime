/**
 * AK-2 Projection Coordinator —— 状态机 + cleanup 所有权 + World commit。
 *
 * 状态机：
 *   world: UNPROJECTED → PROJECTED → DELTA_READY → COMMIT_PENDING → COMMITTED
 *          └── REJECTED / CONFLICTED（终态，不自动 retry/reproject/merge）
 *   execution: PENDING → STARTING → RUNNING → COMPLETED | FAILED | CANCELLED
 *
 * 不变量：
 * - 只有 coordinator 持有 WorldStore 写引用（broker adapter 不得持有）；
 * - cleanup 在正式 World commit 前完成；cleanup 失败阻止 commit；
 * - success/failure/cancel/reject/conflict 全部 cleanup；
 * - exitCode=0 只能进入 DELTA_READY/COMMIT_PENDING；
 * - Effect 恒 NONE、Evidence 恒 PENDING、graphCompletionAllowed=false；
 * - 失败/冲突产生的孤立 CAS 内容只等待安全 GC，不伪装 committed root；
 * - compareAndCommit(baseRevision=snapshot.revision)；WorldConflictError →
 *   CONFLICTED（WORLD_HEAD_MOVED）。
 */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmdirSync,
} from "node:fs"
import { canonicalJson, sha256Digest } from "../world/canonical"
import { digestOf } from "../../runtime/linux/receipt"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { WorldConflictError } from "../world/contracts"
import type { WorldStore } from "../world/store"
import { isTestFixtureBackend, type NativeProjectionBackend, type ProjectionInstance } from "./backend"
import type { WorldProjectionPlan, WorldProjectionReceipt } from "./contracts"
import {
  DEFAULT_PROJECTION_LIMITS,
  ProjectionError,
  applyProjectionStateTransition,
  projectionIntentDigest,
  type ProjectionExecutionIntent,
} from "./contracts"
import {
  parseFilesystemSection,
  type MaterializedSectionEntry,
  type SnapshotMaterializer,
} from "./materializer"
import type { ProjectionDeltaResult } from "./scanner"
import { scanProjectionDelta } from "./scanner"
import type { ProjectionExecutionOutcome } from "./validator"
import { validateProjectionCommit } from "./validator"
import {
  assertTrustedExecutionReceipt,
  isAuthenticatedReceiptAuthority,
  isTestHarnessReceiptAuthority,
  validateProjectionReceiptAuthority,
  type ProjectionReceiptAuthority,
} from "./receipt-authority"
import { removeTreeAnchored } from "./anchored-fs"
import { randomUUID } from "node:crypto"
import {
  defaultIntentReservationPath,
  type IntentReservationInput,
} from "./intent-reservation"
import { DurableIntentReservation } from "./intent-reservation"
import {
  expectedProjectionCellSpecDigest,
  expectedProjectionCellSpecDigestForCell,
} from "./spec-binding"

/** R5-01：production coordinator 不存在任何 receiptless commit 分支。
 *  - 构造时结构性要求 receiptAuthority（所有 backend —— 含 fixture）；
 *  - "fixture" 字符串、结构化 backend 或 TypeScript cast 均不能放大
 *    authority（fixture 执行也必须产出 receipt —— test authority）；
 *  - 生产模块不再导出任何 fixture 执行能力（PUBLIC_FIXTURE_AUTHORITY = 0）、
 *    不再存在 allowTestBackends 选项（WORLD_COMMIT_WITHOUT_RECEIPT = 0）。 */

export type SessionWorldState =
  | "UNPROJECTED"
  | "PROJECTED"
  | "DELTA_READY"
  | "COMMIT_PENDING"
  | "COMMITTED"
  | "CONFLICTED"
  | "REJECTED"
  | "RECONCILING"

export type SessionExecutionState =
  | "PENDING"
  | "STARTING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"

/** 可观测 projection 会话（可变状态；receipt 在终态生成）。 */
export interface ProjectionSession {
  readonly plan: WorldProjectionPlan
  readonly projectionRoot: string
  readonly baseDir: string
  readonly mergedDir: string
  readonly instance: ProjectionInstance
  /** session 创建时的 projection root 身份（P2-1：cleanup 前重新验证）。 */
  readonly rootIdentity: { readonly dev: number; readonly ino: number }
  /** R4-06：seal 后的 scan 输入视图（seal 成功后设置；commit 的
   *  expected-output 验证与 cleanup 都基于它）。 */
  sealedPath?: string
  worldState: SessionWorldState
  executionState: SessionExecutionState
  delta?: ProjectionDeltaResult
  outcome?: ProjectionExecutionOutcome
  /** 本次 commit 的预生成 commitId（P1-3：post-commit uncertainty 查询锚）。 */
  commitId?: string
  /** R2-01：coordinator 生成的 Execution Intent（期望 binding 真源）。 */
  intent: ProjectionExecutionIntent
  receipt?: WorldProjectionReceipt
  /** 单一 cleanup 状态机的最新结果（任何退出路径都记录）。 */
  cleanupState?: { cleanupOk: boolean; rootRemoved: boolean; error?: string }
  /** R5-03：终止保护 —— terminalize 幂等；terminal receipt 最多一个。 */
  terminalized?: boolean
  /** R5-03：进行中的 execute promise（cancel 先 abort、await 它，再清理）。 */
  runningExecute?: Promise<ProjectionExecutionOutcome | void>
  /** R5-03：本 session 的取消信号（cancel 先发出取消再等待 executor）。 */
  abortController?: AbortController
  /** R6-04：retained projection child dirfd（start 打开；cleanup/dispose
   *  关闭 —— materialize/backend/attestation/cleanup 全程覆盖，不关闭后
   *  依赖可交换 pathname）。 */
  rootFd?: number
}

export interface ProjectionCommand {
  readonly executable: string
  readonly args: readonly string[]
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  /** R2-01：coordinator 注入的 Execution Intent（executor/adapter 使用）。 */
  readonly intent?: ProjectionExecutionIntent
}

/** 执行器注入点：adapter（T06）/ 测试 executor。 */
export type ProjectionExecutor = (
  cwd: string,
  command: ProjectionCommand,
) => Promise<ProjectionExecutionOutcome>

export interface ProjectionCoordinatorOptions {
  readonly store: WorldStore
  readonly materializer: SnapshotMaterializer
  readonly backend: NativeProjectionBackend
  /** 投影根（默认 os.tmpdir()/orcana-ak2）。 */
  readonly projectionRoot?: string
  /** 最终 execution receipt 权威（P0-2/P1-6）。commit 必须经它证明
   *  receipt 已持久化、cleanup-finalized、绑定本 session。
   *  R5-01：**所有** backend（含 fixture）构造时结构性要求 —— 缺失即
   *  拒绝构造（不存在 receiptless commit 分支；allowTestBackends 已删除）。
   *  R5-01/R5-06：authority.trustLevel 决定 production acceptance ——
   *  same-uid-untrusted → production World commit fail-closed。 */
  readonly receiptAuthority: ProjectionReceiptAuthority
  /** 测试注入窗口（test-only；生产不传）：projection root 在外层 lstat
   *  验证后、fd open 前调用（R4-00-8 反例的确定性窗口）。
   *  无此选项时零开销（undefined 短路）。 */
  readonly onBeforeProjectionRootOpen?: (root: string) => void
  /** 测试注入窗口（test-only；生产不传）：base root 验证后、projection
   *  child 创建前调用（R5-00-3 反例的确定性 base-swap 窗口）。
   *  无此选项时零开销（undefined 短路）。 */
  readonly onBeforeChildCreate?: (baseRoot: string) => void
  /** 测试注入窗口（test-only；生产不传）：base root 的 parent 验证后、
   *  base mkdir/open 前调用（R6-00-8 反例的确定性 parent-swap 窗口）。
   *  无此选项时零开销（undefined 短路）。 */
  readonly onBeforeBaseMkdir?: (basePath: string) => void
  /** 测试注入窗口（test-only；生产不传）：projection child 打开并捕获
   *  身份后、base dir 创建 / 物化前调用（R6-00-9 反例的确定性 child-swap
   *  窗口）。无此选项时零开销（undefined 短路）。 */
  readonly onAfterChildOpened?: (projectionRoot: string) => void
  /** R6-02：durable intent reservation 持久化路径（缺省 = 共享默认位置；
   *  测试传独立路径隔离）。 */
  readonly intentReservationPath?: string
}

/** 单一 cleanup 状态机结果。 */
export interface ProjectionCleanupResult {
  /** 真实卸载/删除是否成功；false 时 residue 保留（可诊断）。 */
  readonly cleanupOk: boolean
  /** projection root 是否已删除。 */
  readonly rootRemoved: boolean
  /** R5-03：cleanup 阶段（unmount → remove-root）。 */
  readonly phase?: "unmount" | "remove-root" | "none"
  /** R5-03：保留的 residue 路径（未证明卸载 / 身份不符时）。 */
  readonly residue?: string
  /** R5-03：mount truth —— cleanup 时 merged 是否仍为 FUSE mount。 */
  readonly mountStillActive?: boolean
  /** cleanup 异常消息（R2-00-6：异常规范化记录，不逃逸）。 */
  readonly error?: string
}

/** R5-05/R6-02：kernel-owned 一次性 intent reservation —— 一个 intent
 *  只能对应一个 execution cell。R6-02 起由 SQLite unique-key 持久化
 *  支撑（跨 adapter 实例 / 跨 coordinator / 跨进程 / 重启后仍保留）：
 *  内存 Set 已删除（两个 registry / 两个 coordinator / 进程重启后都
 *  不能复用同一 intent）。reserve 必须发生在任意 executor/broker 调用
 *  之前（coordinator.execute 唯一调用点）。 */
export class ProjectionIntentRegistry {
  private readonly durable: DurableIntentReservation

  /** path 缺省 = 共享默认位置（defaultIntentReservationPath）。 */
  constructor(path?: string) {
    this.durable = new DurableIntentReservation(path)
  }

  /** 原子保留（SQLite UNIQUE + INSERT OR IGNORE；跨进程）。已保留
   *  （任何状态，含 UNKNOWN）→ false —— 拒绝第二次 cell，绝不重放。 */
  reserve(intentId: string): boolean {
    return this.durable.reserve({
      intentId,
      worldId: "",
      branchId: "",
      snapshotId: "",
      projectionId: "",
      sessionNonce: "",
    })
  }

  /** 完整元数据保留（coordinator.execute 使用）。 */
  reserveDetailed(input: IntentReservationInput): boolean {
    return this.durable.reserve(input)
  }

  isReserved(intentId: string): boolean {
    return this.durable.isReserved(intentId)
  }

  markDispatched(intentId: string, cellId?: string): void {
    this.durable.markDispatched(intentId, cellId)
  }

  markReceiptBound(intentId: string, receiptDigest: string, cellSpecDigest?: string): void {
    this.durable.markReceiptBound(intentId, receiptDigest, cellSpecDigest)
  }

  markCommitted(intentId: string, commitId: string): void {
    this.durable.markCommitted(intentId, commitId)
  }

  markRejected(intentId: string): void {
    this.durable.markRejected(intentId)
  }

  reconcileStale(maxAgeMs: number): string[] {
    return this.durable.reconcileStale(maxAgeMs)
  }

  close(): void {
    this.durable.close()
  }
}

/**
 * R5-02：可信 projection base root authority。
 *
 * - 安全创建固定 base root（0700；父目录必须是真实目录）；
 * - O_DIRECTORY | O_NOFOLLOW 打开（symlink base → ELOOP → fail-closed）；
 * - 验证 owner === 当前可信 principal（process.getuid()）、mode === 0700、
 *   dev/ino 身份；
 * - session 生命周期内保留 base dirfd + 身份；
 * - child projection 创建/打开/删除**相对 retained base fd**（
 *   /proc/self/fd/<baseFd>/<child> —— 免疫 base path 被 rename/替换）；
 * - 每次 child 操作前 assertPathOwned()（path 身份复核 —— parent swap
 *   fail-closed；外部 sentinel 不得改变）；
 * - 禁止仅靠 resolve()/startsWith()/pathname lstat。
 */
class ProjectionBaseRootAuthority {
  private fd: number | undefined
  private identity: { readonly dev: number; readonly ino: number } | undefined
  /** R6-04：保留的 parent dirfd（验证后**不关闭** —— base 的 mkdir/open
   *  相对它进行；parent pathname 被 rename/替换/symlink 后仍然安全）。 */
  private parentFd: number | undefined
  private parentPath: string | undefined

  /** 测试注入窗口（test-only；生产不传）：parent 验证后、base mkdir 前
   *  （R6-00-8 反例的确定性 parent-swap 窗口）。 */
  private readonly onBeforeBaseMkdir?: (basePath: string) => void

  constructor(readonly basePath: string, onBeforeBaseMkdir?: (basePath: string) => void) {
    this.onBeforeBaseMkdir = onBeforeBaseMkdir
  }

  /** parent 内的相对路径（/proc/self/fd/<parentFd>/<baseName>）。 */
  private parentRelative(baseName: string): string {
    if (this.parentFd === undefined || this.parentPath === undefined) {
      throw new ProjectionError("PROJECTION_BASE_PATH_AUTHORITY", "projection base parent is not prepared")
    }
    return "/proc/self/fd/" + this.parentFd + "/" + baseName
  }

  /** 创建/验证/打开 base root（幂等；返回保留的 dirfd）。 */
  prepare(): number {
    if (this.fd !== undefined) {
      this.assertPathOwned()
      return this.fd
    }
    const base = this.basePath
    // 父目录必须是真实目录（resolve 后单层创建；深层路径由调用方保证）。
    // R6-04-1/2：parent fd 从验证**一直保留**到 base mkdir/open 完成 ——
    // mkdir/open 相对 parent fd（/proc/self/fd/<parentFd>/<baseName>，
    // O_NOFOLLOW 语义；RESOLVE_BENEATH/NO_SYMLINKS 等价约束），不依赖
    // 可交换的 pathname。
    const parent = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "."
    const baseName = base.slice(parent.length + 1)
    if (baseName.length === 0 || baseName === "." || baseName === ".." || /[\\/\0]/.test(baseName)) {
      throw new ProjectionError("PROJECTION_BASE_PATH_AUTHORITY", "invalid projection base name: " + baseName)
    }
    let parentFd: number
    try {
      parentFd = openSync(parent, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
      if (!fstatSync(parentFd).isDirectory()) {
        closeSync(parentFd)
        throw new ProjectionError(
          "PROJECTION_BASE_PATH_AUTHORITY",
          "projection base parent is not a real directory: " + parent,
        )
      }
    } catch (error) {
      if (error instanceof ProjectionError) throw error
      throw new ProjectionError(
        "PROJECTION_BASE_PATH_AUTHORITY",
        "projection base parent cannot be opened securely: " + parent + " (" + (error instanceof Error ? error.message : String(error)) + ")",
      )
    }
    this.parentFd = parentFd
    this.parentPath = parent
    // 测试注入窗口（test-only）：parent 验证后、base mkdir 前（R6-00-8）。
    this.onBeforeBaseMkdir?.(base)
    // base 创建相对 retained parent fd（parent 被替换/变中间 symlink →
    // 写入仍落在原 parent inode —— 外部目录不产生任何 child）。
    const baseEntryPath = this.parentRelative(baseName)
    try {
      mkdirSync(baseEntryPath, { mode: 0o700 })
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
    }
    // O_NOFOLLOW：symlink base → ELOOP/ENOTDIR → fail-closed（R5-00-2）。
    let fd: number
    try {
      fd = openSync(baseEntryPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
    } catch (error) {
      throw new ProjectionError(
        "PROJECTION_BASE_PATH_AUTHORITY",
        "projection base cannot be opened securely (symlink/non-directory?): " + base + " (" + (error instanceof Error ? error.message : String(error)) + ")",
      )
    }
    try {
      const stat = fstatSync(fd)
      if (!stat.isDirectory()) {
        throw new ProjectionError("PROJECTION_BASE_PATH_AUTHORITY", `projection base is not a directory: ${base}`)
      }
      const currentUid = process.getuid?.() ?? 0
      if (stat.uid !== currentUid) {
        throw new ProjectionError(
          "PROJECTION_BASE_PATH_AUTHORITY",
          `projection base owner ${stat.uid} is not the current principal ${currentUid}`,
        )
      }
      if ((stat.mode & 0o777) !== 0o700) {
        throw new ProjectionError(
          "PROJECTION_BASE_PATH_AUTHORITY",
          `projection base mode ${(stat.mode & 0o777).toString(8)} is not 0700`,
        )
      }
      this.fd = fd
      this.identity = { dev: stat.dev, ino: stat.ino }
      return fd
    } catch (error) {
      closeSync(fd)
      throw error
    }
  }

  /** path 身份复核（parent swap / symlink 替换 → fail-closed）。 */
  assertPathOwned(): void {
    if (this.fd === undefined || this.identity === undefined) {
      throw new ProjectionError("PROJECTION_BASE_PATH_AUTHORITY", "projection base is not prepared")
    }
    let stat
    try {
      stat = lstatSync(this.basePath)
    } catch {
      throw new ProjectionError("PROJECTION_BASE_PATH_AUTHORITY", `projection base unreadable: ${this.basePath}`)
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.dev !== this.identity.dev ||
      stat.ino !== this.identity.ino
    ) {
      throw new ProjectionError(
        "PROJECTION_BASE_PATH_AUTHORITY",
        `projection base path identity changed (replaced/renamed); refusing operations under it`,
      )
    }
  }

  /** 相对 retained base fd 的 child 路径（/proc/self/fd/N/<child>）。 */
  private childFdPath(projectionId: string): string {
    if (this.fd === undefined) throw new ProjectionError("PROJECTION_BASE_PATH_AUTHORITY", "projection base is not prepared")
    return `/proc/self/fd/${this.fd}/${projectionId}`
  }

  /** 校验 projectionId（belt：plan validator 已保证，此处防御分隔符）。 */
  private assertSafeChildName(projectionId: string): string {
    if (typeof projectionId !== "string" || !/^[A-Za-z0-9._-]+$/.test(projectionId)) {
      throw new ProjectionError("PROJECTION_ROOT_ESCAPE", `unsafe projection id: ${String(projectionId)}`)
    }
    return projectionId
  }

  /** 相对 base fd 创建 child（EEXIST → 已存在）。 */
  mkdirChild(projectionId: string): void {
    this.assertPathOwned()
    mkdirSync(this.childFdPath(this.assertSafeChildName(projectionId)), { mode: 0o700 })
  }

  /** 相对 base fd 打开 child（O_NOFOLLOW | O_DIRECTORY）。 */
  openChild(projectionId: string): number {
    this.assertPathOwned()
    return openSync(
      this.childFdPath(this.assertSafeChildName(projectionId)),
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    )
  }

  /** 相对 base fd 删除 child 目录项（必须已空）。 */
  removeChild(projectionId: string): void {
    this.assertPathOwned()
    rmdirSync(this.childFdPath(this.assertSafeChildName(projectionId)))
  }

  /** 关闭保留的 dirfd + parent fd（coordinator dispose 时；幂等）。 */
  close(): void {
    if (this.fd !== undefined) {
      closeSync(this.fd)
      this.fd = undefined
      this.identity = undefined
    }
    if (this.parentFd !== undefined) {
      closeSync(this.parentFd)
      this.parentFd = undefined
      this.parentPath = undefined
    }
  }
}

/** 所有退出路径（executor throw / FAILED / CANCELLED / scan failure /
 *  validation rejection / expected output failure / WORLD_HEAD_MOVED /
 *  compareAndCommit failure / unmount failure / root deletion failure）
 *  必须经过的单一清理流程。 */
export interface ProjectionCleanupMachine {
  /** 卸载 + 删根；unmount 失败时保留 residue 并返回 cleanupOk=false。 */
  cleanup(session: ProjectionSession): ProjectionCleanupResult
}

export class ProjectionCoordinator {
  private readonly store: WorldStore
  private readonly materializer: SnapshotMaterializer
  private readonly backend: NativeProjectionBackend
  private readonly baseProjectionRoot: string
  private readonly receiptAuthority: ProjectionReceiptAuthority
  private readonly onBeforeProjectionRootOpen?: (root: string) => void
  private readonly onBeforeChildCreate?: (baseRoot: string) => void
  private readonly onBeforeBaseMkdir?: (basePath: string) => void
  private readonly onAfterChildOpened?: (projectionRoot: string) => void
  /** R5-02：可信 projection base root authority（retained dirfd）。 */
  private readonly baseRoot: ProjectionBaseRootAuthority
  /** R5-05/R6-02：kernel-owned 一次性 intent reservation（durable）。 */
  readonly intentRegistry: ProjectionIntentRegistry
  /** R6-04-5：活跃 session 追踪（dispose 时任一未终态 → fail-closed）。 */
  private readonly activeSessions = new Set<ProjectionSession>()

  constructor(options: ProjectionCoordinatorOptions) {
    this.store = options.store
    this.materializer = options.materializer
    this.backend = options.backend
    // R5-01：所有 backend（含 kind==="fixture" 的任意结构化实现 / cast）
    // 构造时结构性要求 receipt authority —— 不存在 receiptless 分支；
    // allowTestBackends 选项已整体删除（production 模块不再导出任何
    // fixture 执行能力）。
    if (options.receiptAuthority === undefined) {
      throw new ProjectionError(
        "EXECUTION_RECEIPT_REQUIRED",
        "production coordinator requires a receipt authority (receipt-producing executor); refusing construction — receiptless world commit does not exist",
      )
    }
    // R6-01：strict exhaustive runtime validation —— unknown/missing/
    // 错误大小写 trustLevel 或缺失方法在构造时拒绝（fail-closed；
    // EXECUTION_RECEIPT_AUTHORITY_ERROR）。
    this.receiptAuthority = validateProjectionReceiptAuthority(options.receiptAuthority)
    this.onBeforeProjectionRootOpen = options.onBeforeProjectionRootOpen
    this.onBeforeChildCreate = options.onBeforeChildCreate
    this.onBeforeBaseMkdir = options.onBeforeBaseMkdir
    this.onAfterChildOpened = options.onAfterChildOpened
    this.baseProjectionRoot = options.projectionRoot ?? join(tmpdir(), "orcana-ak2")
    this.baseRoot = new ProjectionBaseRootAuthority(resolve(this.baseProjectionRoot), options.onBeforeBaseMkdir)
    // R6-02：durable intent reservation（SQLite；跨 coordinator / 进程）。
    this.intentRegistry = new ProjectionIntentRegistry(options.intentReservationPath ?? defaultIntentReservationPath())
  }

  /** UNPROJECTED → PROJECTED：物化 immutable base + backend 挂载。 */
  start(plan: WorldProjectionPlan): ProjectionSession {
    const snapshot = this.store.snapshots.get(plan.snapshotId)
    if (!snapshot) {
      throw new ProjectionError("SNAPSHOT_NOT_FOUND", `snapshot ${plan.snapshotId} not found`)
    }
    if (snapshot.worldId !== plan.worldId || snapshot.branchId !== plan.branchId) {
      throw new ProjectionError(
        "SNAPSHOT_MISMATCH",
        `snapshot ${snapshot.snapshotId} belongs to ${snapshot.worldId}/${snapshot.branchId}`,
      )
    }
    const world = this.store.getWorld(plan.worldId)
    const branch = this.store.getBranch(plan.worldId, plan.branchId)
    if (!world || !branch) {
      throw new ProjectionError("SNAPSHOT_MISMATCH", `unknown world/branch: ${plan.worldId}/${plan.branchId}`)
    }
    if (world.currentBranchId !== plan.branchId || branch.status !== "active") {
      throw new ProjectionError(
        "VALIDATION_REJECTED",
        `world/branch not commit-ready: ${plan.worldId}/${plan.branchId}`,
      )
    }

    const resolvedBase = resolve(this.baseProjectionRoot)
    // R5-02：可信 base root —— 创建/打开（O_NOFOLLOW）/验证 owner/mode/
    // dev-ino + 保留 dirfd。symlink base / 错误 owner / 非 0700 → 在创建
    // 任何 child / 物化 / CAS 副作用前 fail-closed（R5-00-2）。
    this.baseRoot.prepare()
    // 测试注入窗口（test-only）：base 验证后、child 创建前（R5-00-3）。
    this.onBeforeChildCreate?.(resolvedBase)
    // strict descendant：projection root 必须是固定 root 的直接子目录。
    // R5-02：child 创建/打开相对 retained base fd（pathname 仅用于后端
    // 二进制与诊断 —— 每次操作前 assertPathOwned 复核 path 身份）。
    const projectionRoot = resolve(join(resolvedBase, plan.projectionId))
    if (projectionRoot === resolvedBase || !projectionRoot.startsWith(resolvedBase + sep)) {
      throw new ProjectionError(
        "PROJECTION_ROOT_ESCAPE",
        `projection root escapes base root: ${projectionRoot}`,
      )
    }
    let rootIdentity: { dev: number; ino: number } | undefined
    let rootFd: number | undefined
    let childFdOpen = false
    let instance: ProjectionInstance | undefined
    try {
      try {
        this.baseRoot.mkdirChild(plan.projectionId)
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          throw new ProjectionError("PROJECTION_ALREADY_CLOSED", `projection root exists: ${projectionRoot}`)
        }
        throw error
      }
      // 相对 base fd 打开 child 并记录身份（O_NOFOLLOW；不依赖 pathname）。
      // R6-04-3：child fd **保留**到 session —— materialize/backend 创建/
      // 身份 attestation/cleanup 全程覆盖（不再关闭后依赖可交换 pathname）。
      rootFd = this.baseRoot.openChild(plan.projectionId)
      childFdOpen = true
      try {
        const rootStat = fstatSync(rootFd)
        if (!rootStat.isDirectory()) {
          throw new ProjectionError("PROJECTION_ROOT_ESCAPE", `projection root is not a directory: ${projectionRoot}`)
        }
        rootIdentity = { dev: rootStat.dev, ino: rootStat.ino }
      } catch (error) {
        closeSync(rootFd)
        childFdOpen = false
        throw error
      }
      // 测试注入窗口（test-only）：child fd 身份捕获后、base dir 创建 /
      // 物化前（R6-00-9 反例的确定性 child-swap 窗口）。
      this.onAfterChildOpened?.(projectionRoot)
      // R6-04-2/3：base dir 创建与物化**相对 retained child fd**
      // （/proc/self/fd/<rootFd>/base —— child pathname 被替换后写入仍
      // 落在 session 创建的原始 inode；外部 sentinel/content/mode 不变）。
      const baseDir = this.childFdRelative(rootFd, "base")
      mkdirSync(baseDir, { mode: 0o700 })
      // 物化 immutable lower（内容只来自 snapshot CAS，不读 World HEAD）。
      // materializer 从 WorldStore 取 canonical snapshot 并严格校验身份字段。
      const materialized = this.materializer.materialize(plan.snapshotId, baseDir)
      if (materialized.snapshot.worldId !== plan.worldId || materialized.snapshot.branchId !== plan.branchId) {
        throw new ProjectionError(
          "SNAPSHOT_MISMATCH",
          `canonical snapshot ${plan.snapshotId} belongs to ${materialized.snapshot.worldId}/${materialized.snapshot.branchId}, plan wants ${plan.worldId}/${plan.branchId}`,
        )
      }
      // R6-04-3：backend 创建前**重新证明 path 身份**（pathname 仍指向
      // session 创建的 inode —— swap 后这里 fail-closed，backend 从未在
      // 外部目录创建任何内容；materialize 已写入的原始 inode 与外部无关）。
      {
        const pathStat = lstatSync(projectionRoot)
        if (
          pathStat.isSymbolicLink() ||
          !pathStat.isDirectory() ||
          pathStat.dev !== rootIdentity.dev ||
          pathStat.ino !== rootIdentity.ino
        ) {
          throw new ProjectionError(
            "PROJECTION_ROOT_ESCAPE",
            `projection root path identity changed before backend create (replaced); refusing backend creation under a foreign directory`,
          )
        }
      }
      instance = this.backend.create({ lowerDir: resolve(join(projectionRoot, "base")), projectionRoot, label: "m" })
      instance.assertReady()
      // R6-04-3：backend 创建后再次证明 path 身份（R5 的末尾 recheck
      // 语义保留；rootFd 仍保留 —— 下方 start 完成后注册到 session）。
      {
        const recheckStat = lstatSync(projectionRoot)
        if (
          recheckStat.isSymbolicLink() ||
          !recheckStat.isDirectory() ||
          recheckStat.dev !== rootIdentity.dev ||
          recheckStat.ino !== rootIdentity.ino
        ) {
          closeSync(rootFd)
          childFdOpen = false
          throw new ProjectionError(
            "PROJECTION_ROOT_ESCAPE",
            `projection root identity changed during start; refusing session`,
          )
        }
      }
      // R2-01/R4-03：Execution Intent —— 期望 binding 真源（world/branch/
      // snapshot/projection/session nonce/merged root identity/command/scope/
      // filesystemScope/workspaceIdentity/filesystemPolicyDigest 全部来自
      // kernel-owned plan + session，不是 outcome/executor 自报）。
      const mergedStat = lstatSync(instance.mergedPath)
      const intent: ProjectionExecutionIntent = {
        intentId: plan.intentId ?? randomUUID(),
        worldId: plan.worldId,
        branchId: plan.branchId,
        snapshotId: plan.snapshotId,
        projectionId: plan.projectionId,
        sessionNonce: randomUUID(),
        mergedRootIdentity: { dev: mergedStat.dev, ino: mergedStat.ino },
        command: { executable: "", args: [] },
        scopeDigest: "",
        filesystemScope: {
          writableRoots: Object.freeze([...plan.writableRoots]),
          readonlyRoots: Object.freeze([...plan.readonlyRoots]),
        },
        workspaceIdentity: {
          path: resolve(instance.mergedPath),
          dev: mergedStat.dev,
          ino: mergedStat.ino,
        },
        filesystemPolicyDigest: "",
        // R6-03：kernel-owned 执行 policy（来自 plan —— 不是 adapter
        // 选项自报）；expectedCellSpecDigest 在 execute 时派生（依赖
        // command）。
        profile: plan.profile,
        ...(plan.network === undefined ? {} : { network: plan.network }),
        ...(plan.resources === undefined ? {} : { resources: plan.resources }),
        secretsDigest: plan.secretsDigest,
        expectedCellSpecDigest: "",
      }
      // R5-02/R6-04：start 完成前再次证明 path 身份（openChild 复核的
      // pathname 语义已被上方 path lstat recheck 覆盖 —— 此处保留 base
      // fd 相对复核作为 belt）。
      {
        const recheckFd = this.baseRoot.openChild(plan.projectionId)
        try {
          const recheck = fstatSync(recheckFd)
          if (recheck.dev !== rootIdentity.dev || recheck.ino !== rootIdentity.ino) {
            throw new ProjectionError(
              "PROJECTION_ROOT_ESCAPE",
              `projection root identity changed during start; refusing session`,
            )
          }
        } finally {
          closeSync(recheckFd)
        }
      }
      const session: ProjectionSession = {
        plan,
        projectionRoot,
        baseDir: resolve(join(projectionRoot, "base")),
        mergedDir: instance.mergedPath,
        instance,
        rootIdentity,
        intent,
        worldState: "PROJECTED",
        executionState: "PENDING",
        abortController: new AbortController(),
        // R6-04-3：retained child fd（cleanup/dispose 时关闭）。
        rootFd,
      }
      this.activeSessions.add(session)
      return session
    } catch (error) {
      // R6-04：关闭 retained child fd（若仍打开）。
      if (childFdOpen === true && rootFd !== undefined) {
        try {
          closeSync(rootFd)
        } catch {
          // 已关闭
        }
      }
      // R5-00-4/R5-03：instance 已创建 → 任何后续失败必须先调用
      // ownership-verified cleanup（真实卸载证明），cleanupOk 才允许删除
      // projection root；未证明卸载 → 保留 residue（不遍历/不删除）。
      // 原始错误始终保留（cleanup 异常不覆盖 primary failure）。
      let cleanupOk = instance === undefined
      if (instance !== undefined) {
        try {
          cleanupOk = instance.cleanup()
        } catch {
          cleanupOk = false
        }
      }
      if (cleanupOk && rootIdentity !== undefined) {
        try {
          this.removeProjectionRoot(plan.projectionId, rootIdentity)
        } catch {
          // root 已不存在或身份不符 —— 不删除（residue 保留）。
        }
      }
      throw error
    }
  }

  /** R6-04：相对 child fd 的路径（/proc/self/fd/<fd>/<entry>）。 */
  private childFdRelative(fd: number, entry: string): string {
    return `/proc/self/fd/${fd}/${entry}`
  }

  /** PROJECTED → RUNNING → COMPLETED/FAILED/CANCELLED（P1-2/R2-04：所有
   *  terminal 路径 —— executor throw / FAILED / CANCELLED / timeout /
   *  violation —— 自动 cleanup + world→REJECTED + terminal receipt；
   *  cleanup 抛异常被规范化为 cleanupState 失败记录，绝不逃逸状态机）。 */
  async execute(session: ProjectionSession, command: ProjectionCommand, executor: ProjectionExecutor): Promise<ProjectionExecutionOutcome> {
    if (session.worldState !== "PROJECTED") {
      if (session.worldState === "REJECTED" && session.cleanupState !== undefined) {
        // 已清理的终态 session 不可复用（R2-00-4）。
        throw new ProjectionError(
          "CLEANED_SESSION_REUSED",
          `session is terminal (${session.worldState}); cleaned projection cannot be reused for execute`,
        )
      }
      throw new ProjectionError("PROJECTION_NOT_PROJECTED", `execute requires PROJECTED, got ${session.worldState}`)
    }
    // R2-06-2：execute 前复核 mount 仍是本 session 创建（替换/消失 → 拒绝）。
    // R4-00-6/R4-05：ownership 丢失是 terminal 故障 —— 必须进入终态 +
    // cleanup + terminal receipt（不是裸 throw）。
    if (session.instance.assertMountOwned?.() === false) {
      this.terminalize(
        session,
        "rejected",
        "projection mount no longer owned by this session; execute refused",
      )
      throw new ProjectionError("PROJECTION_NOT_PROJECTED", "projection mount no longer owned by this session; execute refused")
    }
    this.transition(session, { kind: "execute-start" })
    this.transition(session, { kind: "execute-running" })
    // R2-01/R4-03：command 绑定 intent（executable/args/scope 快照进 intent）；
    // filesystemScope/workspaceIdentity/filesystemPolicyDigest 从 kernel-owned
    // plan + session 派生（adapter spawn 前逐字段验证）。
    // R5-00-7a：intent 构建（merged lstat / 期望 policy 派生）抛异常 → 必须
    // terminalize（EXECUTION_INTENT_BUILD_FAILED；不裸传播）。
    let intent: ProjectionExecutionIntent
    try {
      const intentCommand = {
        executable: command.executable,
        args: [...command.args],
        ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      }
      const mergedStat = lstatSync(session.mergedDir)
      intent = {
        ...session.intent,
        command: intentCommand,
        scopeDigest: this.scopeDigestOf(session.plan),
        filesystemScope: {
          writableRoots: Object.freeze([...session.plan.writableRoots]),
          readonlyRoots: Object.freeze([...session.plan.readonlyRoots]),
        },
        workspaceIdentity: {
          path: resolve(session.mergedDir),
          dev: mergedStat.dev,
          ino: mergedStat.ino,
        },
        filesystemPolicyDigest: this.expectedFilesystemPolicyDigest(session),
        // R6-03：expected cellSpecDigest —— kernel-owned/trusted compiler
        // 从权威输入（intent = plan + session）派生（规范化 cellId）。
        // adapter spawn 前对其实际编译 spec 做规范化 digest 比对。
        expectedCellSpecDigest: expectedProjectionCellSpecDigest(
          { ...session.intent, command: intentCommand },
          resolve(session.mergedDir),
          session.plan.writableRoots,
        ),
      }
    } catch (error) {
      this.terminalize(
        session,
        "rejected",
        `execution intent build failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw new ProjectionError(
        "EXECUTION_INTENT_BUILD_FAILED",
        "execution intent build failed (merged view or expected policy derivation); session terminalized",
        error,
      )
    }
    session.intent = intent
    // R5-03：取消信号 —— cancel 先 abort，executor 观察 command.signal。
    const boundCommand: ProjectionCommand = {
      ...command,
      intent,
      signal: command.signal === undefined
        ? session.abortController!.signal
        : AbortSignal.any([command.signal, session.abortController!.signal]),
    }
    // R6-02：durable 一次性 reservation —— **在任意 executor/broker 调用
    // 之前**发生；跨 adapter / coordinator / 进程 / 重启都不可复用。
    // 保留失败（含重建后的 registry）→ terminalize + 精确错误码。
    if (!this.intentRegistry.reserveDetailed({
      intentId: intent.intentId,
      worldId: intent.worldId,
      branchId: intent.branchId,
      snapshotId: intent.snapshotId,
      projectionId: intent.projectionId,
      sessionNonce: intent.sessionNonce,
    })) {
      this.terminalize(
        session,
        "rejected",
        `intent ${intent.intentId} already authorized an execution cell (durable kernel-owned one-time reservation; one intent = one cell; no replay across coordinators/restarts)`,
      )
      throw new ProjectionError(
        "EXECUTION_RECEIPT_BINDING_MISMATCH",
        `intent ${intent.intentId} already authorized an execution cell (durable kernel-owned one-time reservation; one intent = one cell; no replay across coordinators/restarts)`,
      )
    }
    let outcome: ProjectionExecutionOutcome | undefined
    let terminalFailure: unknown = undefined
    let executionPromise: Promise<ProjectionExecutionOutcome> | undefined
    try {
      // R6-04-6：executor 调用位于 try/terminal guard 内 —— **同步 throw**
      // 与 rejected Promise 行为一致（Promise.resolve().then 把同步 throw
      // 转成 rejection，统一走下方 terminalize；绝不留 RUNNING）。
      executionPromise = Promise.resolve().then(() => executor(session.mergedDir, boundCommand))
      session.runningExecute = executionPromise
      // R6-02：DISPATCHED —— executor 已实际调用。
      this.intentRegistry.markDispatched(intent.intentId)
      outcome = await executionPromise
    } catch (error) {
      this.transition(session, { kind: "execute-failed" })
      terminalFailure = error
    } finally {
      if (terminalFailure !== undefined) {
        // R6-02：terminal failure → REJECTED（reservation 不可复用）。
        try {
          this.intentRegistry.markRejected(intent.intentId)
        } catch {
          // reservation 记录失败不掩盖主失败
        }
      }
    }
    if (terminalFailure === undefined && outcome !== undefined) {
      session.outcome = outcome
      if (outcome.cancelled) {
        this.transition(session, { kind: "execute-cancelled" })
      } else if (outcome.exitCode !== 0 || outcome.timedOut || outcome.violation) {
        this.transition(session, { kind: "execute-failed" })
      } else {
        this.transition(session, { kind: "execute-completed" })
      }
      // R6-02：final receipt 已绑定 → RECEIPT_BOUND（durable provenance）。
      if (outcome.executionReceiptId !== undefined) {
        try {
          this.intentRegistry.markReceiptBound(
            session.intent.intentId,
            outcome.executionReceiptId,
            outcome.receiptBinding?.cellSpecDigest,
          )
        } catch {
          // 记录失败不改变执行事实（receipt 校验在 commit 时仍执行）。
        }
      }
    }
    // R6-02：FAILED/CANCELLED outcome（非 throw）→ REJECTED（不可复用）。
    if (
      terminalFailure === undefined &&
      outcome !== undefined &&
      (outcome.cancelled || outcome.exitCode !== 0 || outcome.timedOut || outcome.violation)
    ) {
      try {
        this.intentRegistry.markRejected(session.intent.intentId)
      } catch {
        // 不掩盖主失败
      }
    }
    // R2-06-2/R3-00-4：execute 后复核（COMPLETED 时 mount 必须仍是本
    // session 的）。ownership 丢失是 terminal 故障：必须进入终态 + cleanup
    // + terminal receipt（不是裸 throw）。
    if (session.executionState === "COMPLETED" && session.instance.assertMountOwned?.() === false) {
      this.terminalize(
        session,
        "rejected",
        "projection mount replaced during execution (ownership lost)",
      )
      throw new ProjectionError("PROJECTION_NOT_PROJECTED", "projection mount replaced during execution; scan refused")
    }
    // FAILED / CANCELLED / executor throw 是 terminal：统一 terminalize
    // （cleanup 异常规范化 + 永不抛）+ terminal receipt。
    if (session.executionState === "FAILED" || session.executionState === "CANCELLED") {
      this.terminalize(
        session,
        "rejected",
        terminalFailure === undefined ? undefined : terminalFailure instanceof Error ? terminalFailure.message : String(terminalFailure),
      )
      if (terminalFailure !== undefined) throw terminalFailure
    }
    // terminalFailure 分支已 throw —— 此处 outcome 必定义。
    return outcome as ProjectionExecutionOutcome
  }

  /** COMPLETED → DELTA_READY：确定性 delta（新内容已入 CAS）。
   *  扫描失败（TOCTOU/资源上限/非法条目）→ 同一 cleanup 状态机 + REJECTED。
   *  R2-05-5：后台进程未证明终止（cleanup 未 finalized）不得进入 scan。 */
  scan(session: ProjectionSession): ProjectionDeltaResult {
    if (session.worldState === "REJECTED" && session.cleanupState !== undefined) {
      throw new ProjectionError(
        "CLEANED_SESSION_REUSED",
        `session is terminal (${session.worldState}); cleaned projection cannot be reused for scan`,
      )
    }
    if (session.executionState !== "COMPLETED") {
      throw new ProjectionError(
        "PROJECTION_NOT_PROJECTED",
        `delta scan requires COMPLETED execution, got ${session.executionState}`,
      )
    }
    // R2-06-2/R3-00-5：scan 前复核 mount 仍属本 session。ownership 丢失是
    // terminal 故障：进入终态 + cleanup + terminal receipt。
    if (session.instance.assertMountOwned?.() === false) {
      this.terminalize(
        session,
        "rejected",
        "projection mount no longer owned by this session; scan refused",
      )
      throw new ProjectionError("PROJECTION_NOT_PROJECTED", "projection mount no longer owned by this session; scan refused")
    }
    // R2-05-5/R4-00-7/R5-01：**所有** backend（含 fixture）—— scan 必须
    // 拥有 finalized receipt/cleanup proof（执行 writer 已终止）。
    // 缺失（含 receiptless outcome、无 authority、无 binding）→ 拒绝，
    // 不能跳过（不是条件性检查）；"fixture" 字符串/cast 不能放大 authority。
    const outcome = session.outcome
    if (outcome === undefined || outcome.executionReceiptId === undefined || outcome.receiptBinding === undefined) {
      this.terminalize(
        session,
        "rejected",
        "delta scan requires finalized execution receipt/cleanup proof (execution writers may still run)",
      )
      throw new ProjectionError(
        "EXECUTION_RECEIPT_REQUIRED",
        "delta scan requires finalized receipt/cleanup proof; delta scan refused",
      )
    }
    let finalReceipt
    try {
      finalReceipt = this.receiptAuthority.getFinalReceipt(session.intent.intentId, outcome.receiptBinding.cellId)
      if (finalReceipt === undefined || !this.receiptAuthority.isCleanupFinalized(finalReceipt)) {
        this.terminalize(
          session,
          "rejected",
          "execution cleanup not proven (processes may remain); delta scan refused",
        )
        throw new ProjectionError(
          "EXECUTION_RECEIPT_NOT_FINALIZED",
          "execution cleanup not proven (processes may remain); delta scan refused",
        )
      }
    } catch (error) {
      if (error instanceof ProjectionError && error.code === "EXECUTION_RECEIPT_NOT_FINALIZED") {
        throw error
      }
      // R5-00-7b/c：receipt authority 抛异常（不是返回 undefined）也是
      // terminal 故障 —— 统一 terminalize + 精确错误码。
      this.terminalize(
        session,
        "rejected",
        `execution receipt authority error: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw new ProjectionError(
        "EXECUTION_RECEIPT_AUTHORITY_ERROR",
        "execution receipt authority raised an unexpected error; delta scan refused",
        error,
      )
    }
    // R4-06：seal —— 执行 writer 已终止（cleanup proof）后，把 merged 视图
    // 转为不可写、不可替换的稳定 scan 输入。seal 失败 → 不生成 delta、不写
    // CAS delta content、不 commit World（fail-closed）。
    // R5-00-7d：sealForScan **抛异常**（不是返回 { error }）同样是 terminal
    // 故障 —— 统一 terminalize + DELTA_SCAN_FAILED。
    let sealed
    try {
      sealed = session.instance.sealForScan?.()
    } catch (error) {
      this.terminalize(
        session,
        "rejected",
        `sealForScan raised an unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw new ProjectionError(
        "DELTA_SCAN_FAILED",
        `sealForScan raised an unexpected error; delta scan refused`,
        error,
      )
    }
    if (sealed === undefined) {
      this.terminalize(session, "rejected", "backend cannot seal the scan view (sealForScan unavailable)")
      throw new ProjectionError(
        "DELTA_SCAN_FAILED",
        "backend cannot seal the scan view; delta scan refused",
      )
    }
    if ("error" in sealed) {
      this.terminalize(session, "rejected", `seal failed: ${sealed.error}`)
      throw new ProjectionError(
        "DELTA_SCAN_FAILED",
        `seal failed: ${sealed.error}; delta scan refused`,
      )
    }
    session.sealedPath = sealed.sealedPath
    try {
      const baseIndex = this.buildBaseIndex(session)
      const delta = scanProjectionDelta({
        baseDir: session.baseDir,
        mergedDir: session.sealedPath,
        baseIndex,
        cas: this.store.cas,
        worldId: session.plan.worldId,
        branchId: session.plan.branchId,
        baseRevision: this.store.snapshots.get(session.plan.snapshotId)!.revision,
      })
      session.delta = delta
      this.transition(session, { kind: "scan-completed" })
      return delta
    } catch (error) {
      // R3-00-6：scan 失败路径走统一 terminalize —— cleanup 抛异常被
      // 规范化（cleanupState.error），状态机仍产生确定终态和 receipt。
      this.terminalize(session, "rejected", (error as Error).message, session.delta)
      throw error
    }
  }

  /** DELTA_READY → COMMIT_PENDING → COMMITTED；失败 → REJECTED/CONFLICTED。
   *  返回 store 的 WorldCommitReceipt（正交状态 receipt 在 session.receipt）。
   *
   *  cleanup 顺序（R03/P2-1）：validate → 可信 execution receipt 校验
   *  （P0-2）→ 真实卸载（失败保留 residue 并阻止 commit）→ 验证并删除
   *  projection root → compareAndCommit（P1-3：commitId 预生成；响应不
   *  确定时以权威 commit 记录为准）。 */
  commit(session: ProjectionSession): import("../world/contracts").WorldCommitReceipt {
    if (session.worldState === "REJECTED" && session.cleanupState !== undefined) {
      throw new ProjectionError(
        "CLEANED_SESSION_REUSED",
        `session is terminal (${session.worldState}); cleaned projection cannot be reused for commit`,
      )
    }
    if (session.worldState !== "DELTA_READY") {
      throw new ProjectionError("PROJECTION_NOT_PROJECTED", `commit requires DELTA_READY, got ${session.worldState}`)
    }
    const delta = session.delta!
    const outcome = session.outcome!

    this.transition(session, { kind: "commit-pending" })
    try {
      // 0. R6-01：production authority 门 —— **公开字符串（trustLevel /
      //    kind）不再授予任何东西**。授权只来自：
      //    - authenticated verifier brand（未来 MAC/signature 方案 ——
      //      当前无任何实现可设置 → 恒 false；OWNER-DECISION-REQUIRED）；
      //    - test-only brand 配对（TestReceiptAuthority +
      //      CopyProjectionFixtureBackend，仅 tests/** 构造时可设置 ——
      //      防 API 误用 / 公开字符串伪造；**不解决 same-UID 攻击**，
      //      生产构造路径永不传入）。
      //    production（RuntimeStateReceiptAuthority + FuseOverlayfs 或
      //    普通结构化对象）一律 PRODUCTION_WORLD_COMMIT_BLOCKED。
      if (!this.isProductionCommitAuthorized()) {
        throw new ProjectionError(
          "PRODUCTION_WORLD_COMMIT_BLOCKED",
          "no authenticated receipt verifier is available (self-reported trustLevel strings grant nothing; same-UID JSON receipts are not authenticated authority); production world commit blocked — authenticated authority is OWNER-DECISION-REQUIRED",
        )
      }
      // 1. commit preflight（R5-00-7e：getWorld/getBranch/snapshot 抛异常
      //    也是 terminal 故障 —— 必须在 try 内，统一 terminalize）。
      const world = this.store.getWorld(session.plan.worldId)
      const branch = this.store.getBranch(session.plan.worldId, session.plan.branchId)
      if (!world || !branch) {
        throw new ProjectionError("SNAPSHOT_MISMATCH", "world/branch vanished")
      }
      const snapshot = this.store.snapshots.get(session.plan.snapshotId)!
      // 2. 可信 execution receipt 校验（P0-2/R2-01/R4-03/R5-01）：expected
      //    binding 来自 coordinator 当前 session 的 Execution Intent
      //    （world/branch/snapshot/projection/nonce/merged root/command/
      //    scope/workspace identity/filesystem policy），不是 outcome 自报。
      //    receipt 的 filesystemPolicyDigest 与 coordinator 从 kernel-owned
      //    input 独立派生的期望值比对。**不存在 receiptless 分支** —— 所有
      //    backend（含 fixture）都必须产出 receipt（fixture 用 test
      //    authority；production 用 authenticated authority）。
      if (outcome.executionReceiptId === undefined || outcome.receiptBinding === undefined) {
        throw new ProjectionError(
          "EXECUTION_RECEIPT_REQUIRED",
          "execution receipt required before world commit (receiptless world commit does not exist)",
        )
      }
      const verifiedReceipt = assertTrustedExecutionReceipt(
        this.receiptAuthority,
        session.intent,
        projectionIntentDigest(session.intent),
        outcome.receiptBinding,
        outcome.executionReceiptId,
      )
        // R4-03.4：expected filesystemPolicyDigest 从 kernel-owned input
        // （plan roots + merged hostRoot）独立派生 —— receipt 自报值与
        // claim 互相比对不构成验证；必须与 kernel 派生期望值一致。
        const expectedPolicy = this.expectedFilesystemPolicyDigest(session)
        if (verifiedReceipt.filesystemPolicyDigest !== expectedPolicy) {
          throw new ProjectionError(
            "EXECUTION_RECEIPT_BINDING_MISMATCH",
            `final receipt filesystemPolicyDigest ${verifiedReceipt.filesystemPolicyDigest} does not match the coordinator-derived expected policy digest ${expectedPolicy} (plan scope binding enforced from kernel-owned input)`,
          )
        }
        const receiptViolation = (verifiedReceipt.violations?.length ?? 0) > 0
        // R4-03.6/7：执行结论优先从 verified final receipt 派生 —— 成功
        // 必须是 exitCode===0 且无 signal/oomKilled/pidLimitHit/
        // outputLimitHit/tempLimitHit/timedOut/cancelled/violations/
        // unexpectedWrites。receipt 与 coordinator outcome 冲突 → 拒绝。
        const receiptSuccess =
          verifiedReceipt.exitCode === 0 &&
          verifiedReceipt.signal === null &&
          !verifiedReceipt.timedOut &&
          !verifiedReceipt.cancelled &&
          !verifiedReceipt.oomKilled &&
          !verifiedReceipt.pidLimitHit &&
          !verifiedReceipt.outputLimitHit &&
          !verifiedReceipt.tempLimitHit &&
          (verifiedReceipt.violations?.length ?? 0) === 0 &&
          (verifiedReceipt.unexpectedWrites?.length ?? 0) === 0
        const outcomeSuccess = outcome.exitCode === 0 && !outcome.timedOut && !outcome.cancelled && !outcome.violation
        if (receiptSuccess !== outcomeSuccess) {
          throw new ProjectionError(
            "EXECUTION_RECEIPT_BINDING_MISMATCH",
            `final receipt outcome (exitCode=${verifiedReceipt.exitCode}, signal=${String(verifiedReceipt.signal)}, timedOut=${verifiedReceipt.timedOut}, cancelled=${verifiedReceipt.cancelled}, oomKilled=${verifiedReceipt.oomKilled}, pidLimitHit=${verifiedReceipt.pidLimitHit}, outputLimitHit=${verifiedReceipt.outputLimitHit}, tempLimitHit=${verifiedReceipt.tempLimitHit}, violation=${receiptViolation}) conflicts with coordinator outcome (exitCode=${outcome.exitCode}, timedOut=${outcome.timedOut}, cancelled=${outcome.cancelled}, violation=${outcome.violation})`,
          )
        }
        // R6-03：receipt.cellSpecDigest 必须与 kernel 期望值直接比较 ——
        // kernel 用 receipt 的真实 cellId 经 trusted compiler 重编译
        // （deterministic recompile；权威输入 = session intent）。禁止只
        // 把 receipt 与 outcome 的同源字段互相比对。任何实际执行的
        // profile/network/resource/command/mount 偏差 → digest 不同 →
        // EXECUTION_RECEIPT_BINDING_MISMATCH。
        {
          const expectedSpecDigest = expectedProjectionCellSpecDigestForCell(
            session.intent,
            resolve(session.mergedDir),
            session.plan.writableRoots,
            verifiedReceipt.cellId,
          )
          if (verifiedReceipt.cellSpecDigest !== expectedSpecDigest) {
            throw new ProjectionError(
              "EXECUTION_RECEIPT_BINDING_MISMATCH",
              `final receipt cellSpecDigest ${verifiedReceipt.cellSpecDigest} does not match the kernel-derived expected spec digest ${expectedSpecDigest} for cell ${verifiedReceipt.cellId} (profile/network/resources/command/mounts deviate from the kernel-owned execution policy)`,
            )
          }
        }
        // R2-02：canonical final receipt 进入 World CAS —— 由 World commit
        // 建立 world_commit owner reference（durable provenance；runtime
        // receipt store 删除后仍可恢复）。content 的 canonical 摘要 ==
        // receiptDigest（authority 已做自洽校验）。
        const { receiptDigest: _rd, ...receiptContent } = verifiedReceipt
        this.store.cas.put(Buffer.from(canonicalJson(receiptContent), "utf8"))
      // 3. 验证（sealed 视图仍挂载：expected outputs 存在性/类型；不接收
      //    cleanupOk —— cleanup 的真实结果由下面的卸载步骤决定）。
      try {
        validateProjectionCommit({
          plan: session.plan,
          snapshot,
          world,
          branch,
          currentRevision: world.currentRevision,
          delta,
          mergedDir: session.sealedPath ?? session.mergedDir,
          outcome,
        })
      } catch (error) {
        // stale head（validate 层）→ CONFLICTED，不自动 retry。
        if (error instanceof ProjectionError && error.code === "WORLD_HEAD_MOVED") {
          throw new ProjectionError("WORLD_HEAD_MOVED", error.message)
        }
        throw error
      }
      // 3. 确认真实卸载成功后才允许删除/提交；unmount 失败 → 保留 residue。
      if (!session.instance.cleanup()) {
        throw new ProjectionError(
          "CLEANUP_FAILED",
          "projection unmount failed; residue retained for diagnosis; world commit refused",
        )
      }
      // 4. 卸载成功后验证并删除 projection root（P2-1：重新验证所有权）。
      try {
        this.removeVerifiedProjectionRoot(session)
      } catch (error) {
        throw new ProjectionError(
          "CLEANUP_FAILED",
          "projection root removal failed; world commit refused",
          error instanceof Error ? error.message : String(error),
        )
      }
      // 5. compare-and-commit（P1-3/R2-00-7：commitId 预生成 —— post-commit
      //    uncertainty 的权威查询锚；divergence 检查也在 post-commit 查询
      //    保护内 —— World 已 durable 时绝不 REJECTED）。
      const commitId = session.commitId ?? `ak2-${session.plan.projectionId}-${randomUUID()}`
      session.commitId = commitId
      let receipt
      try {
        receipt = this.store.compareAndCommit({
          worldId: session.plan.worldId,
          branchId: session.plan.branchId,
          baseRevision: snapshot.revision,
          actor: session.plan.actor,
          commitId,
          mutations: delta.mutations,
          ...(outcome.executionReceiptId === undefined
            ? {}
            : { executionReceiptIds: [`sha256:${outcome.executionReceiptId}`] }),
        })
        if (receipt.deltaDigest !== delta.deltaDigest) {
          throw new ProjectionError("DELTA_SCAN_FAILED", "commit delta digest diverged from scanned delta")
        }
      } catch (error) {
        if (error instanceof WorldConflictError) {
          throw new ProjectionError("WORLD_HEAD_MOVED", error.message)
        }
        // World truth 优先于本地控制流异常（P1-3/R2-00-7）：commitId 是
        // 本次 session 预生成的 uuid —— 权威 commit 记录存在即证明本次
        // commit 已经 durable（含 after_commit_before_response fault 与
        // 本地 delta divergence）→ COMMITTED（绝不 REJECTED）。
        const committed = this.store.getCommit(commitId)
        if (committed !== undefined) {
          // R3-02：post-commit reconciliation 必须比较完整 canonical commit
          // request（不能只凭 commitId 存在就认定成功 —— commitId 是
          // 预生成 uuid，但防御巧合复用/篡改仍要对账）。
          const expectedRequestDigest = this.store.computeCommitRequestDigest({
            worldId: session.plan.worldId,
            branchId: session.plan.branchId,
            baseRevision: snapshot.revision,
            actor: session.plan.actor,
            commitId,
            mutations: delta.mutations,
            executionReceiptIds: outcome.executionReceiptId === undefined
              ? []
              : [`sha256:${outcome.executionReceiptId}`],
            effectReceiptIds: [],
          })
          const actualRequestDigest = this.store.getCommitRequestDigest(commitId)
          if (actualRequestDigest !== expectedRequestDigest) {
            // R5-03：post-commit divergence —— commitId 已 durable 但 request
            // digest 与本 session 不一致。**不得谎报 REJECTED**（World 可能
            // 已被不可知 commit 修改）—— 显式 RECONCILING 终态 + 人工对账
            // 证据（terminalized 防 terminalize 覆盖）。
            this.transition(session, { kind: "reconciling" })
            session.terminalized = true
            session.receipt = this.buildReceipt(
              session,
              "RECONCILING",
              `commit id ${commitId} is durable but its request digest diverged from this session's canonical request; manual reconciliation required`,
              delta,
            )
            session.cleanupState = { cleanupOk: true, rootRemoved: true }
            throw new ProjectionError(
              "EXECUTION_RECEIPT_BINDING_MISMATCH",
              `commit id ${commitId} exists but request digest ${actualRequestDigest} does not match this session's canonical request ${expectedRequestDigest}; session state is RECONCILING (manual reconciliation required)`,
            )
          }
          this.transition(session, { kind: "committed" })
          session.receipt = this.buildReceipt(session, "COMMITTED", undefined, delta, committed)
          session.cleanupState = { cleanupOk: true, rootRemoved: true }
          // R6-02：COMMITTED —— durable reservation 终态（provenance）。
          try {
            this.intentRegistry.markCommitted(session.intent.intentId, commitId)
          } catch {
            // 记录失败不改变 World 事实（commit 已 durable）。
          }
          return committed
        }
        throw error
      }
      this.transition(session, { kind: "committed" })
      session.receipt = this.buildReceipt(session, "COMMITTED", undefined, delta, receipt)
      // 已 COMMITTED：本地清理结果只记录，不再改变世界状态。
      session.cleanupState = { cleanupOk: true, rootRemoved: true }
      // R6-02：COMMITTED —— durable reservation 终态（provenance）。
      try {
        this.intentRegistry.markCommitted(session.intent.intentId, commitId)
      } catch {
        // 记录失败不改变 World 事实（commit 已 durable）。
      }
      return receipt
    } catch (error) {
      // R3-00-6b：所有失败路径走统一 terminalize（cleanup 异常规范化）。
      if (error instanceof ProjectionError && error.code === "WORLD_HEAD_MOVED") {
        this.terminalize(session, "conflicted", "WORLD_HEAD_MOVED", delta)
      } else {
        this.terminalize(session, "rejected", (error as Error).message, delta)
      }
      throw error
    }
  }

  /** R5-03：取消路径（async）—— 先发出取消（abort signal）、等待
   *  executor/receipt/cleanup 完成，只能生成一个终态；cleanup 后不得仍有
   *  writer（cleanup 由 execute 完成路径内的 terminalize 执行）。
   *  已终态（COMMITTED/CONFLICTED/REJECTED/RECONCILING）幂等返回。 */
  async cancel(session: ProjectionSession): Promise<ProjectionCleanupResult> {
    if (
      session.worldState === "COMMITTED" ||
      session.worldState === "CONFLICTED" ||
      session.worldState === "REJECTED" ||
      session.worldState === "RECONCILING"
    ) {
      return session.cleanupState ?? Object.freeze({ cleanupOk: false, rootRemoved: false, error: "session already terminal" })
    }
    if (session.worldState === "UNPROJECTED") {
      throw new ProjectionError("PROJECTION_NOT_PROJECTED", "cannot cancel an unprojected session")
    }
    if (session.executionState === "STARTING" || session.executionState === "RUNNING") {
      // R5-00-6/R5-03：先取消（abort）→ 等待 executor 完成（execute 完成
      // 路径负责 terminalize + cleanup —— 绝不在 writer 仍在运行时删除
      // workspace）。
      session.abortController?.abort()
      if (session.runningExecute !== undefined) {
        try {
          await session.runningExecute
        } catch {
          // execute 已完成终态化（错误已被规范化）。
        }
      }
      // 类型窄化兜底：await 后可能仍是 RUNNING（executor 未观察 abort）——
      // 走下方统一 terminalize。
    }
    if ((session.worldState as SessionWorldState) === "REJECTED" && session.cleanupState !== undefined) {
      return session.cleanupState
    }
    // R6-02：取消 → REJECTED（reservation 不可复用）。
    try {
      this.intentRegistry.markRejected(session.intent.intentId)
    } catch {
      // 记录失败不掩盖取消事实
    }
    this.terminalize(session, "rejected", "cancelled by caller")
    return session.cleanupState!
  }

  /** R6-01：production commit authority 门（fail-closed 默认）。
   *  - 公开 trustLevel 字符串不授予任何东西；
   *  - 只有 authenticated verifier brand（未来实现，当前恒 false）或
   *    test-only brand 配对（仅 tests/** 构造）通过；
   *  - same-uid-untrusted / kernel-authenticated 自报字符串 / 普通结构化
   *    对象全部拒绝 → PRODUCTION_WORLD_COMMIT_BLOCKED。 */
  private isProductionCommitAuthorized(): boolean {
    const authority = validateProjectionReceiptAuthority(this.receiptAuthority)
    if (isAuthenticatedReceiptAuthority(authority)) return true
    return isTestHarnessReceiptAuthority(authority) && isTestFixtureBackend(this.backend)
  }

  /** R6-04-5：coordinator dispose/close —— 关闭 retained base dirfd +
   *  retained parent fd；幂等。任一活跃（未终态）session 存在时
   *  fail-closed（INVALID_STATE —— 不得在投影生命周期内丢弃根锚）。
   *  注意：durable intent reservation 是共享资源（跨 coordinator），
   *  不在此关闭。 */
  dispose(): void {
    for (const session of this.activeSessions) {
      const world = session.worldState
      if (
        world !== "COMMITTED" &&
        world !== "CONFLICTED" &&
        world !== "REJECTED" &&
        world !== "RECONCILING"
      ) {
        throw new ProjectionError(
          "INVALID_STATE",
          `cannot dispose coordinator with an active session (${world}/${session.executionState}); terminalize or cancel it first`,
        )
      }
    }
    this.baseRoot.close()
  }

  /** R3-02/R5-03：统一 terminalizer —— 唯一终态化路径（永不抛）。任何
   *  terminal 原因（execute throw/failure/cancel、ownership 丢失、
   *  scan/validation 失败、WORLD_HEAD_MOVED、commit 失败、explicit
   *  cancel、cleanup 失败）都经此：状态经显式 transition 表进入终态 +
   *  cleanup 异常规范化（cleanupState.error）+ terminal receipt。
   *  幂等：terminalized 后再次调用直接返回（最多一个终态、一个 receipt）。 */
  private terminalize(
    session: ProjectionSession,
    worldState: "rejected" | "conflicted",
    reason?: string,
    delta?: ProjectionDeltaResult,
  ): void {
    if (session.terminalized === true) return
    session.terminalized = true
    // 状态演进（显式表；非法边 → INVALID_STATE，绝不静默）。
    if (
      session.worldState === "PROJECTED" &&
      (session.executionState === "PENDING" || session.executionState === "STARTING" || session.executionState === "RUNNING")
    ) {
      this.transition(session, { kind: "execute-cancelled" })
    }
    this.transition(session, { kind: worldState })
    // cleanup 异常永不逃逸（R3-00-6/6b/6c）。
    session.cleanupState = this.cleanupSessionSafe(session)
    session.receipt = this.buildReceipt(
      session,
      worldState === "conflicted" ? "CONFLICTED" : "REJECTED",
      reason,
      delta,
    )
  }

  /** 单一 cleanup 状态机：真实卸载 → 成功才删 upper/work/root；
   *  unmount 失败 → 保留 residue（可诊断），返回 cleanupOk=false。
   *  root 删除失败同样使 cleanupOk=false（P2-1：不得返回
   *  cleanupOk=true + rootRemoved=false）。幂等：重复调用安全。
   *  R5-03：cleanupState 记录 phase / residue / mount truth。 */
  private cleanupSession(session: ProjectionSession): ProjectionCleanupResult {
    const cleanupOk = session.instance.cleanup()
    let rootRemoved = false
    let mountStillActive: boolean | undefined
    try {
      mountStillActive = session.instance.assertMountOwned?.() === true
    } catch {
      mountStillActive = undefined
    }
    let residue: string | undefined
    if (cleanupOk) {
      try {
        this.removeVerifiedProjectionRoot(session)
        rootRemoved = true
      } catch (error) {
        rootRemoved = false
        residue = session.projectionRoot
      }
    } else {
      residue = session.projectionRoot
    }
    // R6-04-3：无论结果如何，retained child fd 在 cleanup 后关闭（幂等）。
    this.closeSessionRootFd(session)
    return Object.freeze({
      cleanupOk: cleanupOk && rootRemoved,
      rootRemoved,
      phase: rootRemoved ? "remove-root" : cleanupOk ? "remove-root" : "unmount",
      ...(residue === undefined ? {} : { residue }),
      ...(mountStillActive === undefined ? {} : { mountStillActive }),
    })
  }

  /** R2-00-6/R2-03：cleanup 抛异常被规范化为明确 cleanup failure ——
   *  异常绝不逃逸状态机（residue 保留，cleanupOk=false 记录）。 */
  private cleanupSessionSafe(session: ProjectionSession): ProjectionCleanupResult {
    try {
      return this.cleanupSession(session)
    } catch (error) {
      return Object.freeze({
        cleanupOk: false,
        rootRemoved: false,
        phase: "unmount",
        residue: session.projectionRoot,
        ...(error instanceof Error ? { error: error.message } : {}),
      })
    }
  }

  /** P2-1/R5-02：删除前重新验证 root 所有权 —— strict descendant of
   *  fixed base root、projectionId 派生路径、session 创建的 dev/ino、
   *  非 symlink；child 打开/删除相对 retained base fd。任何不符 → 拒绝
   *  删除（residue 保留；CLEANUP_FAILED 由调用方包装）。 */
  private removeVerifiedProjectionRoot(session: ProjectionSession): void {
    const resolvedBase = resolve(this.baseProjectionRoot)
    const expected = resolve(join(resolvedBase, session.plan.projectionId))
    const actual = resolve(session.projectionRoot)
    if (actual === resolvedBase || !actual.startsWith(resolvedBase + sep)) {
      throw new ProjectionError(
        "PROJECTION_ROOT_ESCAPE",
        `cleanup refuses non-descendant root: ${actual}`,
      )
    }
    if (actual !== expected) {
      throw new ProjectionError(
        "PROJECTION_ROOT_ESCAPE",
        `cleanup refuses root not derived from projectionId: ${actual} != ${expected}`,
      )
    }
    if (!existsSync(actual)) return
    const stat = lstatSync(actual)
    if (stat.isSymbolicLink()) {
      throw new ProjectionError(
        "PROJECTION_ROOT_ESCAPE",
        `cleanup refuses symlink root: ${actual}`,
      )
    }
    if (stat.dev !== session.rootIdentity.dev || stat.ino !== session.rootIdentity.ino) {
      throw new ProjectionError(
        "PROJECTION_ROOT_ESCAPE",
        `cleanup refuses root whose identity (dev/ino) does not match session-owned root`,
      )
    }
    this.removeProjectionRoot(session.plan.projectionId, session.rootIdentity)
    // R6-04-3：root 已删除 —— retained child fd 不再需要（幂等关闭）。
    this.closeSessionRootFd(session)
  }

  /** R6-04：关闭 session 的 retained child fd（幂等）。 */
  private closeSessionRootFd(session: ProjectionSession): void {
    if (session.rootFd === undefined) return
    try {
      closeSync(session.rootFd)
    } catch {
      // 已关闭
    }
    session.rootFd = undefined
  }

  /** R2-01：plan scope 的 canonical 摘要（filesystem policy binding）。 */
  private scopeDigestOf(plan: WorldProjectionPlan): string {
    return sha256Digest(
      Buffer.from(canonicalJson({ writableRoots: plan.writableRoots, readonlyRoots: plan.readonlyRoots }), "utf8"),
    )
  }

  /** 状态机唯一入口（P2-5）：所有 world/execution 变更经
   *  applyProjectionStateTransition 校验后写入。 */
  private transition(
    session: ProjectionSession,
    transition: import("./contracts").ProjectionStateTransition,
  ): void {
    const next = applyProjectionStateTransition(session.worldState, session.executionState, transition)
    session.worldState = next.world
    session.executionState = next.execution
  }

  /** 生成正交状态 receipt（Effect=NONE、Evidence=PENDING）。
   *  P2-6：execution state 直接使用 session.executionState（execute 的
   *  真值 —— exitCode=0+timedOut/violation 已在 execute 置 FAILED），
   *  不再用第二套条件重新推导。 */
  buildReceipt(
    session: ProjectionSession,
    worldState: SessionWorldState,
    reason?: string,
    delta?: ProjectionDeltaResult,
    worldCommitReceipt?: import("../world/contracts").WorldCommitReceipt,
  ): WorldProjectionReceipt {
    const executionState: SessionExecutionState = session.executionState
    return Object.freeze({
      projectionId: session.plan.projectionId,
      worldId: session.plan.worldId,
      branchId: session.plan.branchId,
      snapshotId: session.plan.snapshotId,
      actor: session.plan.actor,
      executionState,
      worldState,
      effectState: "NONE",
      evidenceState: "PENDING",
      ...(delta === undefined ? {} : { deltaDigest: delta.deltaDigest }),
      ...(worldCommitReceipt === undefined ? {} : { worldCommitReceipt }),
      ...(reason === undefined ? {} : { reason }),
      createdAt: Date.now(),
    })
  }

  /** 从 snapshot filesystem section manifest 重建 path → entry 索引。 */
  private buildBaseIndex(session: ProjectionSession): Map<string, MaterializedSectionEntry> {
    const snapshot = this.store.snapshots.get(session.plan.snapshotId)
    if (!snapshot) throw new ProjectionError("SNAPSHOT_NOT_FOUND", `snapshot ${session.plan.snapshotId} not found`)
    // R3-06.4：section manifest 在读取/JSON parse 前检查 CAS record size。
    const record = this.store.cas.record(snapshot.filesystemDigest)
    if (record !== undefined && record.size > DEFAULT_PROJECTION_LIMITS.maxManifestBytes) {
      throw new ProjectionError(
        "PROJECTION_RESOURCE_LIMIT",
        `filesystem section manifest ${snapshot.filesystemDigest} size ${record.size} exceeds maxManifestBytes ${DEFAULT_PROJECTION_LIMITS.maxManifestBytes} (refused before read/parse)`,
      )
    }
    const bytes = this.store.cas.get(snapshot.filesystemDigest)
    const manifest = parseFilesystemSection(bytes)
    const index = new Map<string, MaterializedSectionEntry>()
    for (const entry of manifest.entries) {
      if (entry.path !== undefined) index.set(entry.path, entry)
    }
    return index
  }

  /** R3-03.4/5 + R3-00-13 + R4-00-8/R4-05.5 + R5-02：fd 锚定、no-follow、
   *  identity-fenced 的删除；child 打开/删除**相对 retained base fd**
   *  （/proc/self/fd/<baseFd>/<projectionId> —— 免疫 base/root pathname
   *  被 rename/替换）。禁止「lstat 后再用可交换 pathname 递归删除」
   *  —— root fd 身份必须立即与 session 创建时的 rootIdentity 复核；身份
   *  不符 → 拒绝删除且不修改任何内容（替换目录原样保留）。通过后才 fd
   *  相对递归删除，fchmod 不跟随 symlink；删除后路径身份再验证，目录项
   *  经 base fd rmdir。 */
  private removeProjectionRoot(projectionId: string, rootIdentity: { readonly dev: number; readonly ino: number }): void {
    const root = resolve(join(this.baseRoot.basePath, projectionId))
    // 测试注入窗口（test-only）：外层验证后、fd open 前 —— R4-00-8
    // 反例的确定性替换点。
    this.onBeforeProjectionRootOpen?.(root)
    const fd = this.baseRoot.openChild(projectionId)
    try {
      const fdStat = fstatSync(fd)
      if (!fdStat.isDirectory()) {
        throw new ProjectionError("PROJECTION_ROOT_ESCAPE", `cleanup refuses non-directory root: ${root}`)
      }
      // R4-05.5/R4-00-8：打开的 fd 必须与 session.rootIdentity 比较
      // （open 指向的 inode 必须正是 session 创建的 root —— 替换目录
      // 不被 chmod/删除）。
      if (fdStat.dev !== rootIdentity.dev || fdStat.ino !== rootIdentity.ino) {
        throw new ProjectionError(
          "PROJECTION_ROOT_ESCAPE",
          `cleanup refuses root whose fd identity does not match session-owned root (replaced)`,
        )
      }
      fchmodSync(fd, 0o700)
      removeTreeAnchored(fd)
      // 删除 root 目录项本身：路径身份再验证（swap 后不删）；目录项
      // rmdir 相对 base fd（目录必须已空 —— 非空 → ENOTEMPTY → 拒绝）。
      const pathStat = lstatSync(root)
      if (
        !pathStat.isDirectory() ||
        pathStat.isSymbolicLink() ||
        pathStat.dev !== rootIdentity.dev ||
        pathStat.ino !== rootIdentity.ino
      ) {
        throw new ProjectionError(
          "PROJECTION_ROOT_ESCAPE",
          `cleanup refuses root whose path identity changed during removal: ${root}`,
        )
      }
      // bun 的 rmSync(force) 对空目录偶发 EFAULT —— 用 rmdir（语义一致）。
      this.baseRoot.removeChild(projectionId)
    } finally {
      closeSync(fd)
    }
  }

  /** R4-03.4：期望 filesystem policy digest —— 从 kernel-owned input
   *  （plan roots + merged hostRoot）按 runtime 的 spec.filesystem canonical
   *  结构独立派生（与 adapter 编译出的 spec.filesystem 完全同构；投影契约
   *  ：emptyHome=true、ownerFiles=writableRoots、target=/workspace/<root>）。
   *  receipt.filesystemPolicyDigest 必须等于该期望值 —— 不能与 receipt/
   *  claim 自报值互相比对。 */
  private expectedFilesystemPolicyDigest(session: ProjectionSession): string {
    return expectedProjectionFilesystemPolicyDigest(session.plan, resolve(session.mergedDir))
  }
}

/** R4-03.4：从 kernel-owned input（plan roots + merged hostRoot）独立派生
 *  期望 filesystem policy digest（导出供测试 fake authority 使用 ——
 *  fake receipt 必须携带与 coordinator 相同的期望值才构成合法证明）。 */
export function expectedProjectionFilesystemPolicyDigest(plan: WorldProjectionPlan, hostRoot: string): string {
  const writableMounts = plan.writableRoots.map(path => ({
    source: resolve(hostRoot, path),
    target: `/workspace/${path}`,
    mode: "rw" as const,
    required: true,
    recursive: true,
  }))
  const readonlyMounts = plan.readonlyRoots.map(path => ({
    source: resolve(hostRoot, path),
    target: `/workspace/${path}`,
    mode: "ro" as const,
    required: true,
    recursive: true,
  }))
  return digestOf({
    readonlyMounts,
    writableMounts,
    tmpfsMounts: [],
    hiddenPaths: [],
    emptyHome: true,
    worktreeRoot: hostRoot,
    ownerFiles: [...plan.writableRoots],
  })
}
