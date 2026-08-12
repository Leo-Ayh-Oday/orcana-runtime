/**
 * AK-2 Projection Contracts —— WorldProjectionPlan 与正交状态。
 *
 * 不变量（ADR-AK-002 / AK-2 stage）：
 * - Execution success ≠ World commit ≠ Evidence completion ≠ Graph completion；
 * - direct/live 只是 ABI 枚举，当前必须 fail-closed（mode 只能是 native）；
 * - graphCompletionAllowed 恒为 false；
 * - 所有 canonical arrays 与返回对象运行时冻结。
 */

import type { CasDigest, WorldCommitReceipt } from "../world/contracts"

/** Projection mode —— ABI 枚举。AK-2 只实现 native；direct/live fail-closed。 */
export type ProjectionMode = "direct" | "native" | "live"

/** World（commit）正交状态 —— 与 Execution 状态完全分离。 */
export type ProjectionWorldState =
  | "UNPROJECTED"
  | "PROJECTED"
  | "DELTA_READY"
  | "COMMIT_PENDING"
  | "COMMITTED"
  | "CONFLICTED"
  | "REJECTED"

/** Execution 正交状态 —— 只描述 Linux 上实际发生了什么。 */
export type ProjectionExecutionState =
  | "PENDING"
  | "STARTING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"

/** Effect 状态 —— AK-2 恒为 NONE（Effect Kernel 不在本阶段）。 */
export type ProjectionEffectState = "NONE"

/** Evidence 状态 —— AK-2 恒为 PENDING（Evidence authority 不在本阶段）。 */
export type ProjectionEvidenceState = "PENDING"

/** 冻结的 projection 状态组合（合法组合的真源）。 */
export interface ProjectionStateVector {
  readonly execution: ProjectionExecutionState
  readonly world: ProjectionWorldState
  readonly effect: ProjectionEffectState
  readonly evidence: ProjectionEvidenceState
}

/** 合法状态向量约束：
 *  - execution 达到 COMPLETED 只能使 world 进入 DELTA_READY/COMMIT_PENDING/
 *    COMMITTED/CONFLICTED/REJECTED；
 *  - REJECTED 可配 COMPLETED/FAILED/CANCELLED（执行成功但世界拒绝、执行
 *    失败、执行取消都合法）；
 *  - effect/evidence 在 AK-2 恒为 NONE/PENDING；
 *  - graph completion 不在此向量中（AK-2 无此权威）。
 *
 *  非法组合（不可表达）：world=COMMITTED 配 execution≠COMPLETED、
 *  world=UNPROJECTED/PROJECTED 配 execution≠PENDING、world=DELTA_READY/
 *  COMMIT_PENDING/CONFLICTED 配 execution≠COMPLETED。 */
export const PROJECTION_STATE_VECTORS: Readonly<Record<ProjectionWorldState, readonly ProjectionStateVector[]>> =
  Object.freeze({
    UNPROJECTED: Object.freeze([
      Object.freeze({ execution: "PENDING", world: "UNPROJECTED", effect: "NONE", evidence: "PENDING" }),
    ]),
    PROJECTED: Object.freeze([
      Object.freeze({ execution: "PENDING", world: "PROJECTED", effect: "NONE", evidence: "PENDING" }),
    ]),
    DELTA_READY: Object.freeze([
      Object.freeze({ execution: "COMPLETED", world: "DELTA_READY", effect: "NONE", evidence: "PENDING" }),
    ]),
    COMMIT_PENDING: Object.freeze([
      Object.freeze({ execution: "COMPLETED", world: "COMMIT_PENDING", effect: "NONE", evidence: "PENDING" }),
    ]),
    COMMITTED: Object.freeze([
      Object.freeze({ execution: "COMPLETED", world: "COMMITTED", effect: "NONE", evidence: "PENDING" }),
    ]),
    CONFLICTED: Object.freeze([
      Object.freeze({ execution: "COMPLETED", world: "CONFLICTED", effect: "NONE", evidence: "PENDING" }),
    ]),
    REJECTED: Object.freeze([
      Object.freeze({ execution: "COMPLETED", world: "REJECTED", effect: "NONE", evidence: "PENDING" }),
      Object.freeze({ execution: "FAILED", world: "REJECTED", effect: "NONE", evidence: "PENDING" }),
      Object.freeze({ execution: "CANCELLED", world: "REJECTED", effect: "NONE", evidence: "PENDING" }),
    ]),
  })

/** world 状态下 execution 是否合法（正交状态契约）。 */
export function isValidProjectionStateVector(
  world: ProjectionWorldState,
  execution: ProjectionExecutionState,
): boolean {
  return PROJECTION_STATE_VECTORS[world].some(vector => vector.execution === execution)
}

/** WorldProjectionPlan —— 由调用方（Graph/调度）构造、本模块 runtime
 *  验证并冻结。所有路径均为 canonical POSIX relative path。 */
export interface WorldProjectionPlanInput {
  readonly projectionId: string
  readonly worldId: string
  readonly branchId: string
  readonly snapshotId: string
  readonly actor: string
  /** 唯一受支持模式；direct/live fail-closed。 */
  readonly mode: ProjectionMode
  /** 互不相交的 canonical 相对路径集合（执行可写范围）。 */
  readonly writableRoots: readonly string[]
  /** 互不相交的 canonical 相对路径集合（只读范围，与 writable 不重叠）。 */
  readonly readonlyRoots: readonly string[]
  /** 必须位于 writableRoots 且不在 readonlyRoots 的 canonical 相对路径。 */
  readonly expectedOutputs: readonly string[]
  /** 必须为 false（AK-2 无 Graph completion authority）。 */
  readonly graphCompletionAllowed: false
}

export interface WorldProjectionPlan {
  readonly projectionId: string
  readonly worldId: string
  readonly branchId: string
  readonly snapshotId: string
  readonly actor: string
  readonly mode: "native"
  readonly writableRoots: readonly string[]
  readonly readonlyRoots: readonly string[]
  readonly expectedOutputs: readonly string[]
  readonly graphCompletionAllowed: false
}

/** Projection receipt —— 只记录本 projection 的事实，不提供 Graph/
 *  Evidence completion authority。 */
export interface WorldProjectionReceipt {
  readonly projectionId: string
  readonly worldId: string
  readonly branchId: string
  readonly snapshotId: string
  readonly actor: string
  readonly executionState: ProjectionExecutionState
  readonly worldState: ProjectionWorldState
  readonly effectState: "NONE"
  readonly evidenceState: "PENDING"
  /** DELTA_READY/COMMIT_PENDING/COMMITTED 时的 canonical delta digest。 */
  readonly deltaDigest?: CasDigest
  /** COMMITTED 时的 World commit receipt。 */
  readonly worldCommitReceipt?: WorldCommitReceipt
  /** REJECTED/CONFLICTED 原因（fail-closed 细节）。 */
  readonly reason?: string
  readonly createdAt: number
}

/** Projection 资源配额 —— 确定性上限，超限 fail-closed（防深树/超大文件
 *  OOM/stack overflow/CAS 膨胀）。测试可注入更小值。 */
export interface ProjectionLimits {
  /** traversal 最大深度（含根）。 */
  readonly maxDepth: number
  /** 单侧视图最大 entry 数（file+directory）。 */
  readonly maxEntries: number
  /** 单文件最大字节（物化重建与扫描读取共用）。 */
  readonly maxFileBytes: number
  /** 单视图全部文件总字节上限。 */
  readonly maxTreeBytes: number
  /** FileManifest 最大 chunk 数。 */
  readonly maxFileChunks: number
}

export const DEFAULT_PROJECTION_LIMITS: ProjectionLimits = Object.freeze({
  maxDepth: 64,
  maxEntries: 100_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTreeBytes: 512 * 1024 * 1024,
  maxFileChunks: 4096,
})

/** Projection 失败错误码。 */
export type ProjectionErrorCode =
  | "INVALID_PROJECTION_ID"
  | "INVALID_WORLD_ID"
  | "INVALID_BRANCH_ID"
  | "INVALID_SNAPSHOT_ID"
  | "INVALID_ACTOR"
  | "MODE_FAIL_CLOSED"
  | "GRAPH_COMPLETION_FORBIDDEN"
  | "INVALID_PATH"
  | "NON_CANONICAL_PATH"
  | "SCOPE_AMBIGUITY"
  | "SCOPE_OVERLAP"
  | "DUPLICATE_SCOPE_ROOT"
  | "EXPECTED_OUTPUT_OUTSIDE_WRITABLE"
  | "EXPECTED_OUTPUT_INSIDE_READONLY"
  | "PROJECTION_ALREADY_CLOSED"
  | "PROJECTION_NOT_PROJECTED"
  | "SNAPSHOT_NOT_FOUND"
  | "SNAPSHOT_MISMATCH"
  | "MATERIALIZATION_FAILED"
  | "BACKEND_UNAVAILABLE"
  | "DELTA_SCAN_FAILED"
  | "VALIDATION_REJECTED"
  | "CLEANUP_FAILED"
  | "WORLD_HEAD_MOVED"
  | "EXECUTION_FAILED"
  | "EXECUTION_CANCELLED"
  | "UNEXPECTED_WRITE"
  | "OBJECT_ID_COLLISION"
  | "HOST_AUDIT_ACCEPTED_AS_SECURITY_BOUNDARY"
  | "PROJECTION_RESOURCE_LIMIT"
  | "PROJECTION_ROOT_ESCAPE"

export class ProjectionError extends Error {
  readonly kind = "ProjectionError" as const

  constructor(
    readonly code: ProjectionErrorCode,
    message?: string,
    readonly detail?: unknown,
  ) {
    super(message ?? `PROJECTION_${code}`)
    this.name = "ProjectionError"
  }
}
