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
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WorldConflictError } from "../world/contracts"
import type { WorldStore } from "../world/store"
import type { NativeProjectionBackend, ProjectionInstance } from "./backend"
import type { WorldProjectionPlan, WorldProjectionReceipt } from "./contracts"
import { ProjectionError } from "./contracts"
import {
  parseFilesystemSection,
  type MaterializedSectionEntry,
  type SnapshotMaterializer,
} from "./materializer"
import type { ProjectionDeltaResult } from "./scanner"
import { scanProjectionDelta } from "./scanner"
import type { ProjectionExecutionOutcome } from "./validator"
import { validateProjectionCommit } from "./validator"

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
  worldState: SessionWorldState
  executionState: SessionExecutionState
  delta?: ProjectionDeltaResult
  outcome?: ProjectionExecutionOutcome
  receipt?: WorldProjectionReceipt
}

export interface ProjectionCommand {
  readonly executable: string
  readonly args: readonly string[]
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
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
}

export class ProjectionCoordinator {
  private readonly store: WorldStore
  private readonly materializer: SnapshotMaterializer
  private readonly backend: NativeProjectionBackend
  private readonly baseProjectionRoot: string

  constructor(options: ProjectionCoordinatorOptions) {
    this.store = options.store
    this.materializer = options.materializer
    this.backend = options.backend
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

    const projectionRoot = join(this.baseProjectionRoot, plan.projectionId)
    if (existsSync(projectionRoot)) {
      throw new ProjectionError("PROJECTION_ALREADY_CLOSED", `projection root exists: ${projectionRoot}`)
    }
    mkdirSync(projectionRoot, { mode: 0o700 })
    const baseDir = join(projectionRoot, "base")
    try {
      mkdirSync(baseDir, { mode: 0o700 })
      // 物化 immutable lower（内容只来自 snapshot CAS，不读 World HEAD）。
      this.materializer.materialize(snapshot, baseDir)
      const instance = this.backend.create({ lowerDir: baseDir, projectionRoot, label: "m" })
      instance.assertReady()
      return {
        plan,
        projectionRoot,
        baseDir,
        mergedDir: instance.mergedPath,
        instance,
        worldState: "PROJECTED",
        executionState: "PENDING",
      }
    } catch (error) {
      this.removeProjectionRoot(projectionRoot)
      throw error
    }
  }

  /** PROJECTED → RUNNING → COMPLETED/FAILED/CANCELLED。
   *  executor 抛异常时也执行 cleanup（不变量：任何路径不留残留），
   *  然后原样重抛（调用方决定重试/上报策略）。 */
  async execute(session: ProjectionSession, command: ProjectionCommand, executor: ProjectionExecutor): Promise<ProjectionExecutionOutcome> {
    if (session.worldState !== "PROJECTED") {
      throw new ProjectionError("PROJECTION_NOT_PROJECTED", `execute requires PROJECTED, got ${session.worldState}`)
    }
    session.executionState = "STARTING"
    session.executionState = "RUNNING"
    let outcome: ProjectionExecutionOutcome
    try {
      outcome = await executor(session.mergedDir, command)
    } catch (error) {
      session.executionState = "FAILED"
      try {
        session.instance.cleanup()
      } finally {
        this.removeProjectionRoot(session.projectionRoot)
      }
      throw error
    }
    session.outcome = outcome
    if (outcome.cancelled) session.executionState = "CANCELLED"
    else if (outcome.exitCode !== 0 || outcome.timedOut || outcome.violation) session.executionState = "FAILED"
    else session.executionState = "COMPLETED"
    return outcome
  }

  /** COMPLETED → DELTA_READY：确定性 delta（新内容已入 CAS）。 */
  scan(session: ProjectionSession): ProjectionDeltaResult {
    if (session.executionState !== "COMPLETED") {
      throw new ProjectionError(
        "PROJECTION_NOT_PROJECTED",
        `delta scan requires COMPLETED execution, got ${session.executionState}`,
      )
    }
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
    session.worldState = "DELTA_READY"
    return delta
  }

  /** DELTA_READY → COMMIT_PENDING → COMMITTED；失败 → REJECTED/CONFLICTED。
   *  返回 store 的 WorldCommitReceipt（正交状态 receipt 在 session.receipt）。 */
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

    session.worldState = "COMMIT_PENDING"
    try {
      // 1. 验证（merged 仍挂载：expected outputs 存在性/类型）。
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
          cleanupOk: true,
        })
      } catch (error) {
        // stale head（validate 层）→ CONFLICTED，不自动 retry。
        if (error instanceof ProjectionError && error.code === "WORLD_HEAD_MOVED") {
          session.worldState = "CONFLICTED"
          session.receipt = this.buildReceipt(session, "CONFLICTED", "WORLD_HEAD_MOVED", delta)
          throw error
        }
        throw error
      }
      // 2. cleanup 成功后才允许 commit（只卸载本 projection 资源）。
      if (!session.instance.cleanup()) {
        throw new ProjectionError("CLEANUP_FAILED", "projection cleanup failed; world commit refused")
      }
      // 3. compare-and-commit（baseRevision = snapshot.revision）。
      let receipt
      try {
        receipt = this.store.compareAndCommit({
          worldId: session.plan.worldId,
          branchId: session.plan.branchId,
          baseRevision: snapshot.revision,
          actor: session.plan.actor,
          mutations: delta.mutations,
          ...(outcome.executionReceiptId === undefined
            ? {}
            : { executionReceiptIds: [outcome.executionReceiptId] }),
        })
      } catch (error) {
        if (error instanceof WorldConflictError) {
          session.worldState = "CONFLICTED"
          session.receipt = this.buildReceipt(session, "CONFLICTED", "WORLD_HEAD_MOVED", delta)
          throw new ProjectionError("WORLD_HEAD_MOVED", error.message)
        }
        throw error
      }
      if (receipt.deltaDigest !== delta.deltaDigest) {
        throw new ProjectionError("DELTA_SCAN_FAILED", "commit delta digest diverged from scanned delta")
      }
      session.worldState = "COMMITTED"
      session.receipt = this.buildReceipt(session, "COMMITTED", undefined, delta, receipt)
      return receipt
    } catch (error) {
      if (error instanceof ProjectionError && error.code === "WORLD_HEAD_MOVED") throw error
      session.worldState = "REJECTED"
      session.receipt = this.buildReceipt(session, "REJECTED", (error as Error).message, delta)
      throw error
    } finally {
      // 任何路径都清理投影根（instance 已卸载；根目录删除幂等）。
      this.removeProjectionRoot(session.projectionRoot)
    }
  }

  /** 取消/失败路径：cleanup（幂等）。 */
  cancel(session: ProjectionSession): void {
    try {
      session.instance.cleanup()
    } finally {
      this.removeProjectionRoot(session.projectionRoot)
    }
  }

  /** 生成正交状态 receipt（Effect=NONE、Evidence=PENDING）。 */
  buildReceipt(
    session: ProjectionSession,
    worldState: SessionWorldState,
    reason?: string,
    delta?: ProjectionDeltaResult,
    worldCommitReceipt?: import("../world/contracts").WorldCommitReceipt,
  ): WorldProjectionReceipt {
    const executionState: SessionExecutionState =
      worldState === "COMMITTED" || worldState === "DELTA_READY" || worldState === "COMMIT_PENDING" || worldState === "CONFLICTED"
        ? "COMPLETED"
        : worldState === "REJECTED"
          ? session.outcome?.cancelled
            ? "CANCELLED"
            : session.outcome && session.outcome.exitCode !== 0
              ? "FAILED"
              : "COMPLETED"
          : session.executionState
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
    try {
      this.chmodTreeWritable(root)
    } catch {
      // 已删
    }
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // cleanup failure 由 instance.cleanup() 报告；根删除尽力而为
    }
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
