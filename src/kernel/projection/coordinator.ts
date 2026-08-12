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

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { canonicalJson, sha256Digest } from "../world/canonical"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { WorldConflictError } from "../world/contracts"
import type { WorldStore } from "../world/store"
import type { NativeProjectionBackend, ProjectionInstance } from "./backend"
import type { WorldProjectionPlan, WorldProjectionReceipt } from "./contracts"
import { ProjectionError, applyProjectionStateTransition, projectionIntentDigest, type ProjectionExecutionIntent } from "./contracts"
import {
  parseFilesystemSection,
  type MaterializedSectionEntry,
  type SnapshotMaterializer,
} from "./materializer"
import type { ProjectionDeltaResult } from "./scanner"
import { scanProjectionDelta } from "./scanner"
import type { ProjectionExecutionOutcome } from "./validator"
import { validateProjectionCommit } from "./validator"
import { assertTrustedExecutionReceipt, type ProjectionReceiptAuthority } from "./receipt-authority"
import { randomUUID } from "node:crypto"

export type SessionWorldState =
  | "UNPROJECTED"
  | "PROJECTED"
  | "DELTA_READY"
  | "COMMIT_PENDING"
  | "COMMITTED"
  | "CONFLICTED"
  | "REJECTED"

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
  /** 显式 test capability：允许 kind="fixture" backend（生产必须缺省拒绝）。 */
  readonly allowTestBackends?: boolean
  /** 最终 execution receipt 权威（P0-2/P1-6）。production commit 必须
   *  经它证明 receipt 已持久化、cleanup-finalized、绑定本 session。
   *  缺省时 production（非 fixture）commit 拒绝。 */
  readonly receiptAuthority?: ProjectionReceiptAuthority
  /** 显式 test capability：允许无 receipt 的 fixture executor 提交
   *  （仅测试；production 必须缺省拒绝）。 */
  readonly allowFixtureExecution?: boolean
}

/** 单一 cleanup 状态机结果。 */
export interface ProjectionCleanupResult {
  /** 真实卸载/删除是否成功；false 时 residue 保留（可诊断）。 */
  readonly cleanupOk: boolean
  /** projection root 是否已删除。 */
  readonly rootRemoved: boolean
  /** cleanup 异常消息（R2-00-6：异常规范化记录，不逃逸）。 */
  readonly error?: string
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
  private readonly receiptAuthority?: ProjectionReceiptAuthority
  private readonly allowFixtureExecution: boolean

  constructor(options: ProjectionCoordinatorOptions) {
    this.store = options.store
    this.materializer = options.materializer
    this.backend = options.backend
    // 生产 gate：fixture backend 必须显式 test capability 才可经 coordinator 使用。
    if (options.backend.kind === "fixture" && options.allowTestBackends !== true) {
      throw new ProjectionError(
        "BACKEND_UNAVAILABLE",
        "test fixture backend requires explicit allowTestBackends (test-only capability); production coordinator refuses it",
      )
    }
    this.receiptAuthority = options.receiptAuthority
    this.allowFixtureExecution = options.allowFixtureExecution === true
    this.baseProjectionRoot = options.projectionRoot ?? join(tmpdir(), "orcana-ak2")
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
    // strict descendant：projection root 必须是固定 root 的直接子目录。
    // assertSafeProjectionId 已保证 token 无路径分隔符；此处 resolve 后
    // 再验证（防御：projectionRoot 构造与所有权不变量）。
    const projectionRoot = resolve(join(resolvedBase, plan.projectionId))
    if (projectionRoot === resolvedBase || !projectionRoot.startsWith(resolvedBase + sep)) {
      throw new ProjectionError(
        "PROJECTION_ROOT_ESCAPE",
        `projection root escapes base root: ${projectionRoot}`,
      )
    }
    if (existsSync(projectionRoot)) {
      throw new ProjectionError("PROJECTION_ALREADY_CLOSED", `projection root exists: ${projectionRoot}`)
    }
    mkdirSync(projectionRoot, { mode: 0o700 })
    // P2-1：记录 session 创建的 root 身份（dev/ino）供 cleanup 前验证。
    const rootStat = lstatSync(projectionRoot)
    const rootIdentity = { dev: rootStat.dev, ino: rootStat.ino }
    const baseDir = join(projectionRoot, "base")
    try {
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
      const instance = this.backend.create({ lowerDir: baseDir, projectionRoot, label: "m" })
      instance.assertReady()
      // R2-01：Execution Intent —— 期望 binding 真源（world/branch/snapshot/
      // projection/session nonce/merged root identity/command/scope）。
      const mergedStat = lstatSync(instance.mergedPath)
      const intent: ProjectionExecutionIntent = {
        intentId: randomUUID(),
        worldId: plan.worldId,
        branchId: plan.branchId,
        snapshotId: plan.snapshotId,
        projectionId: plan.projectionId,
        sessionNonce: randomUUID(),
        mergedRootIdentity: { dev: mergedStat.dev, ino: mergedStat.ino },
        command: { executable: "", args: [] },
        scopeDigest: "",
      }
      return {
        plan,
        projectionRoot,
        baseDir,
        mergedDir: instance.mergedPath,
        instance,
        rootIdentity,
        intent,
        worldState: "PROJECTED",
        executionState: "PENDING",
      }
    } catch (error) {
      // R2-06-8：start 失败路径也走 ownership-verified cleanup（dev/ino
      // 身份验证 + 非 symlink + descendant），禁止直接 pathname 递归删除。
      try {
        const stat = lstatSync(projectionRoot)
        if (!stat.isSymbolicLink() && stat.dev === rootIdentity.dev && stat.ino === rootIdentity.ino) {
          this.removeProjectionRoot(projectionRoot)
        }
      } catch {
        // root 已不存在或身份不符 —— 不删除（residue 保留）。
      }
      throw error
    }
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
    if (session.instance.assertMountOwned?.() === false) {
      throw new ProjectionError("PROJECTION_NOT_PROJECTED", "projection mount no longer owned by this session; execute refused")
    }
    this.transition(session, { kind: "execute-start" })
    this.transition(session, { kind: "execute-running" })
    // R2-01：command 绑定 intent（executable/args/scope 快照进 intent）。
    const intentCommand = {
      executable: command.executable,
      args: [...command.args],
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
    }
    const intent: ProjectionExecutionIntent = {
      ...session.intent,
      command: intentCommand,
      scopeDigest: this.scopeDigestOf(session.plan),
    }
    session.intent = intent
    const boundCommand: ProjectionCommand = { ...command, intent }
    let outcome: ProjectionExecutionOutcome | undefined
    let terminalFailure: unknown = undefined
    try {
      outcome = await executor(session.mergedDir, boundCommand)
    } catch (error) {
      this.transition(session, { kind: "execute-failed" })
      terminalFailure = error
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
    }
    // R2-06-2：execute 后复核（COMPLETED 时 mount 必须仍是本 session 的）。
    if (session.executionState === "COMPLETED" && session.instance.assertMountOwned?.() === false) {
      throw new ProjectionError("PROJECTION_NOT_PROJECTED", "projection mount replaced during execution; scan refused")
    }
    // FAILED / CANCELLED / executor throw 是 terminal：world→REJECTED +
    // 统一 cleanup（异常规范化）+ terminal receipt。
    if (session.executionState === "FAILED" || session.executionState === "CANCELLED") {
      this.transition(session, { kind: "rejected" })
      session.cleanupState = this.cleanupSessionSafe(session)
      session.receipt = this.buildReceipt(
        session,
        "REJECTED",
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
    if (session.executionState !== "COMPLETED") {
      throw new ProjectionError(
        "PROJECTION_NOT_PROJECTED",
        `delta scan requires COMPLETED execution, got ${session.executionState}`,
      )
    }
    // R2-06-2：scan 前复核 mount 仍属本 session。
    if (session.instance.assertMountOwned?.() === false) {
      throw new ProjectionError("PROJECTION_NOT_PROJECTED", "projection mount no longer owned by this session; scan refused")
    }
    // R2-05-5：production 路径 —— receipt 的 cleanup 必须已证明
    // （processesRemaining===0 等）；未证明（后台进程可能存活）→ 拒绝 scan。
    const outcome = session.outcome
    if (outcome !== undefined && outcome.executionReceiptId !== undefined && this.receiptAuthority !== undefined && outcome.receiptBinding !== undefined) {
      const finalReceipt = this.receiptAuthority.getFinalReceipt(session.intent.intentId, outcome.receiptBinding.cellId)
      if (finalReceipt === undefined || !this.receiptAuthority.isCleanupFinalized(finalReceipt)) {
        throw new ProjectionError(
          "PROJECTION_NOT_PROJECTED",
          "execution cleanup not proven (processes may remain); delta scan refused",
        )
      }
    }
    try {
      const baseIndex = this.buildBaseIndex(session)
      const delta = scanProjectionDelta({
        baseDir: session.baseDir,
        mergedDir: session.mergedDir,
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
      session.cleanupState = this.cleanupSession(session)
      this.transition(session, { kind: "rejected" })
      session.receipt = this.buildReceipt(session, "REJECTED", (error as Error).message, session.delta)
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
    if (session.worldState !== "DELTA_READY") {
      throw new ProjectionError("PROJECTION_NOT_PROJECTED", `commit requires DELTA_READY, got ${session.worldState}`)
    }
    const delta = session.delta!
    const outcome = session.outcome!
    const world = this.store.getWorld(session.plan.worldId)
    const branch = this.store.getBranch(session.plan.worldId, session.plan.branchId)
    if (!world || !branch) {
      throw new ProjectionError("SNAPSHOT_MISMATCH", "world/branch vanished")
    }
    const snapshot = this.store.snapshots.get(session.plan.snapshotId)!

    this.transition(session, { kind: "commit-pending" })
    try {
      // 1. 可信 execution receipt 校验（P0-2/R2-01）：expected binding 来自
      //    coordinator 当前 session 的 Execution Intent（world/branch/snapshot/
      //    projection/nonce/merged root/command/scope），不是 outcome 自报。
      //    receipt.projectionIntentDigest 由 broker 从 spec 注入 —— 历史
      //    receipt 无法跨 World/session 重放。fixture executor 只在显式
      //    test-only capability 下放行。
      if (outcome.executionReceiptId !== undefined) {
        if (this.receiptAuthority === undefined || outcome.receiptBinding === undefined) {
          throw new ProjectionError(
            "EXECUTION_RECEIPT_REQUIRED",
            "execution receipt presented without receipt authority/binding; world commit refused",
          )
        }
        const verifiedReceipt = assertTrustedExecutionReceipt(
          this.receiptAuthority,
          session.intent,
          projectionIntentDigest(session.intent),
          this.scopeDigestOf(session.plan),
          outcome.receiptBinding,
          outcome.executionReceiptId,
        )
        // R2-02：canonical final receipt 进入 World CAS —— 由 World commit
        // 建立 world_commit owner reference（durable provenance；runtime
        // receipt store 删除后仍可恢复）。content 的 canonical 摘要 ==
        // receiptDigest（authority 已做自洽校验）。
        const { receiptDigest: _rd, ...receiptContent } = verifiedReceipt
        this.store.cas.put(Buffer.from(canonicalJson(receiptContent), "utf8"))
      } else if (!this.allowFixtureExecution) {
        // 无 receipt（fixture executor 路径）且未显式授权 → production bypass。
        throw new ProjectionError(
          "EXECUTION_RECEIPT_REQUIRED",
          "execution receipt required before world commit (fixture execution is not a production authority)",
        )
      }
      // 2. 验证（merged 仍挂载：expected outputs 存在性/类型；不接收
      //    cleanupOk —— cleanup 的真实结果由下面的卸载步骤决定）。
      try {
        validateProjectionCommit({
          plan: session.plan,
          snapshot,
          world,
          branch,
          currentRevision: world.currentRevision,
          delta,
          mergedDir: session.mergedDir,
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
          this.transition(session, { kind: "committed" })
          session.receipt = this.buildReceipt(session, "COMMITTED", undefined, delta, committed)
          session.cleanupState = { cleanupOk: true, rootRemoved: true }
          return committed
        }
        throw error
      }
      this.transition(session, { kind: "committed" })
      session.receipt = this.buildReceipt(session, "COMMITTED", undefined, delta, receipt)
      // 已 COMMITTED：本地清理结果只记录，不再改变世界状态。
      session.cleanupState = { cleanupOk: true, rootRemoved: true }
      return receipt
    } catch (error) {
      // 所有失败路径：同一 cleanup 状态机（幂等；unmount 失败保留 residue）。
      session.cleanupState = this.cleanupSession(session)
      if (error instanceof ProjectionError && error.code === "WORLD_HEAD_MOVED") {
        this.transition(session, { kind: "conflicted" })
        session.receipt = this.buildReceipt(session, "CONFLICTED", "WORLD_HEAD_MOVED", delta)
        throw error
      }
      this.transition(session, { kind: "rejected" })
      session.receipt = this.buildReceipt(session, "REJECTED", (error as Error).message, delta)
      throw error
    }
  }

  /** 取消/失败路径：同一 cleanup 状态机（幂等）。 */
  cancel(session: ProjectionSession): ProjectionCleanupResult {
    session.cleanupState = this.cleanupSession(session)
    return session.cleanupState
  }

  /** 单一 cleanup 状态机：真实卸载 → 成功才删 upper/work/root；
   *  unmount 失败 → 保留 residue（可诊断），返回 cleanupOk=false。
   *  root 删除失败同样使 cleanupOk=false（P2-1：不得返回
   *  cleanupOk=true + rootRemoved=false）。幂等：重复调用安全。 */
  private cleanupSession(session: ProjectionSession): ProjectionCleanupResult {
    const cleanupOk = session.instance.cleanup()
    let rootRemoved = false
    if (cleanupOk) {
      try {
        this.removeVerifiedProjectionRoot(session)
        rootRemoved = true
      } catch {
        rootRemoved = false
      }
    }
    return Object.freeze({ cleanupOk: cleanupOk && rootRemoved, rootRemoved })
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
        ...(error instanceof Error ? { error: error.message } : {}),
      })
    }
  }

  /** P2-1：删除前重新验证 root 所有权 —— strict descendant of fixed base
   *  root、projectionId 派生路径、session 创建的 dev/ino、非 symlink。
   *  任何不符 → 拒绝删除（residue 保留；CLEANUP_FAILED 由调用方包装）。 */
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
    this.removeProjectionRoot(actual)
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
    const bytes = this.store.cas.get(snapshot.filesystemDigest)
    const manifest = parseFilesystemSection(bytes)
    const index = new Map<string, MaterializedSectionEntry>()
    for (const entry of manifest.entries) {
      if (entry.path !== undefined) index.set(entry.path, entry)
    }
    return index
  }

  private removeProjectionRoot(root: string): void {
    this.chmodTreeWritable(root)
    rmSync(root, { recursive: true, force: true })
  }

  private chmodTreeWritable(dir: string): void {
    if (!existsSync(dir)) return
    chmodSync(dir, 0o700)
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stat = lstatSync(full)
      if (stat.isDirectory()) this.chmodTreeWritable(full)
    }
  }
}
