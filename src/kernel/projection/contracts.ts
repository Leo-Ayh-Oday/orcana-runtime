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

/** 冻结的 projection 状态组合。 */
export interface ProjectionStateVector {
  readonly execution: ProjectionExecutionState
  readonly world: ProjectionWorldState
  readonly effect: ProjectionEffectState
  readonly evidence: ProjectionEvidenceState
}

/** 冻结的 projection 状态组合（合法组合的唯一真源）。
 *
 *  Reachable model（与 coordinator 实际演进一致，P2-5）：
 *  - UNPROJECTED：仅 PENDING（未投影）
 *  - PROJECTED：PENDING/STARTING/RUNNING/COMPLETED/FAILED/CANCELLED
 *    （执行发生在投影之后；执行终止后世界仍处于投影态等待统一
 *    terminalization / cleanup）
 *  - DELTA_READY：仅 COMPLETED（扫描要求执行成功）
 *  - COMMIT_PENDING：仅 COMPLETED
 *  - COMMITTED：仅 COMPLETED（World 已 durable commit）
 *  - CONFLICTED：仅 COMPLETED（stale head 冲突）
 *  - REJECTED：COMPLETED/FAILED/CANCELLED（执行成功但世界拒绝；执行
 *    失败；执行取消）
 *
 *  effect/evidence 在 AK-2 恒为 NONE/PENDING；graph completion 不在
 *  此模型中。 */
export const PROJECTION_STATE_VECTORS: Readonly<Record<ProjectionWorldState, readonly ProjectionStateVector[]>> =
  Object.freeze({
    UNPROJECTED: Object.freeze([
      Object.freeze({ execution: "PENDING", world: "UNPROJECTED", effect: "NONE", evidence: "PENDING" }),
    ]),
    PROJECTED: Object.freeze([
      Object.freeze({ execution: "PENDING", world: "PROJECTED", effect: "NONE", evidence: "PENDING" }),
      Object.freeze({ execution: "STARTING", world: "PROJECTED", effect: "NONE", evidence: "PENDING" }),
      Object.freeze({ execution: "RUNNING", world: "PROJECTED", effect: "NONE", evidence: "PENDING" }),
      Object.freeze({ execution: "COMPLETED", world: "PROJECTED", effect: "NONE", evidence: "PENDING" }),
      Object.freeze({ execution: "FAILED", world: "PROJECTED", effect: "NONE", evidence: "PENDING" }),
      Object.freeze({ execution: "CANCELLED", world: "PROJECTED", effect: "NONE", evidence: "PENDING" }),
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

/** 合法 world/execution 组合的唯一真源（reachable model）。 */
export function isValidProjectionStateVector(
  world: ProjectionWorldState,
  execution: ProjectionExecutionState,
): boolean {
  return PROJECTION_STATE_VECTORS[world].some(vector => vector.execution === execution)
}

/** 状态转移事件（coordinator 唯一状态演进入口）。 */
export type ProjectionStateTransition =
  | { readonly kind: "start" }
  | { readonly kind: "execute-start" }
  | { readonly kind: "execute-running" }
  | { readonly kind: "execute-completed" }
  | { readonly kind: "execute-failed" }
  | { readonly kind: "execute-cancelled" }
  | { readonly kind: "scan-completed" }
  | { readonly kind: "commit-pending" }
  | { readonly kind: "committed" }
  | { readonly kind: "conflicted" }
  | { readonly kind: "rejected" }

/** 状态对（from 或 to）。 */
export type ProjectionStatePair = {
  readonly world: ProjectionWorldState
  readonly execution: ProjectionExecutionState
}

/** R2-04：显式状态迁移白名单 —— (fromWorld, fromExecution, event) → target。
 *  未列出的任何组合一律 INVALID_STATE。 */
export const PROJECTION_TRANSITION_TABLE: Readonly<Record<ProjectionStateTransition["kind"], ReadonlyArray<{ readonly from: ProjectionStatePair; readonly to: ProjectionStatePair }>>> =
  Object.freeze({
    start: Object.freeze([{ from: { world: "UNPROJECTED", execution: "PENDING" }, to: { world: "PROJECTED", execution: "PENDING" } }]),
    "execute-start": Object.freeze([{ from: { world: "PROJECTED", execution: "PENDING" }, to: { world: "PROJECTED", execution: "STARTING" } }]),
    "execute-running": Object.freeze([{ from: { world: "PROJECTED", execution: "STARTING" }, to: { world: "PROJECTED", execution: "RUNNING" } }]),
    "execute-completed": Object.freeze([{ from: { world: "PROJECTED", execution: "RUNNING" }, to: { world: "PROJECTED", execution: "COMPLETED" } }]),
    "execute-failed": Object.freeze([{ from: { world: "PROJECTED", execution: "RUNNING" }, to: { world: "PROJECTED", execution: "FAILED" } }]),
    "execute-cancelled": Object.freeze([
      { from: { world: "PROJECTED", execution: "PENDING" }, to: { world: "PROJECTED", execution: "CANCELLED" } },
      { from: { world: "PROJECTED", execution: "STARTING" }, to: { world: "PROJECTED", execution: "CANCELLED" } },
      { from: { world: "PROJECTED", execution: "RUNNING" }, to: { world: "PROJECTED", execution: "CANCELLED" } },
    ]),
    "scan-completed": Object.freeze([
      { from: { world: "PROJECTED", execution: "COMPLETED" }, to: { world: "DELTA_READY", execution: "COMPLETED" } },
    ]),
    "commit-pending": Object.freeze([{ from: { world: "DELTA_READY", execution: "COMPLETED" }, to: { world: "COMMIT_PENDING", execution: "COMPLETED" } }]),
    committed: Object.freeze([{ from: { world: "COMMIT_PENDING", execution: "COMPLETED" }, to: { world: "COMMITTED", execution: "COMPLETED" } }]),
    conflicted: Object.freeze([{ from: { world: "COMMIT_PENDING", execution: "COMPLETED" }, to: { world: "CONFLICTED", execution: "COMPLETED" } }]),
    // rejected 保留 execution（REJECTED 可配 COMPLETED/FAILED/CANCELLED）。
    rejected: Object.freeze([
      { from: { world: "PROJECTED", execution: "FAILED" }, to: { world: "REJECTED", execution: "FAILED" } },
      { from: { world: "PROJECTED", execution: "CANCELLED" }, to: { world: "REJECTED", execution: "CANCELLED" } },
      { from: { world: "PROJECTED", execution: "COMPLETED" }, to: { world: "REJECTED", execution: "COMPLETED" } },
      { from: { world: "DELTA_READY", execution: "COMPLETED" }, to: { world: "REJECTED", execution: "COMPLETED" } },
      { from: { world: "COMMIT_PENDING", execution: "COMPLETED" }, to: { world: "REJECTED", execution: "COMPLETED" } },
    ]),
  }) as unknown as Readonly<Record<ProjectionStateTransition["kind"], ReadonlyArray<{ readonly from: ProjectionStatePair; readonly to: ProjectionStatePair }>>>

/** R2-01：Projection Execution Intent —— coordinator 在 start 时生成、
 *  不可复用（session nonce）的期望执行绑定。Expected binding 来自当前
 *  session/plan/command（不是 outcome 自报）。
 *
 *  R4-03：intent 成为「期望执行绑定」的唯一真源 —— coordinator 从
 *  kernel-owned input（plan + session）独立派生 filesystemScope /
 *  workspaceIdentity / filesystemPolicyDigest；adapter 必须在 spawn 前
 *  逐字段验证 spec 与 intent 一致（executor 不得同时提供声明和证明）。 */
export interface ProjectionExecutionIntent {
  /** 每次 start 唯一（uuid）。 */
  readonly intentId: string
  readonly worldId: string
  readonly branchId: string
  readonly snapshotId: string
  readonly projectionId: string
  /** session 唯一 nonce（uuid）—— 历史 intent 不可重放。 */
  readonly sessionNonce: string
  /** resolved merged root 的 dev/ino 身份。 */
  readonly mergedRootIdentity: { readonly dev: number; readonly ino: number }
  /** 当前 command（executable/args/timeoutMs）。 */
  readonly command: { readonly executable: string; readonly args: readonly string[]; readonly timeoutMs?: number }
  /** canonical(writableRoots + readonlyRoots) 的摘要（filesystem policy）。 */
  readonly scopeDigest: string
  /** R4-03：plan 声明的 canonical 可写/只读 roots（adapter spawn 前逐字段
   *  验证；来自 kernel-owned plan，不是 adapter 选项自报）。 */
  readonly filesystemScope: { readonly writableRoots: readonly string[]; readonly readonlyRoots: readonly string[] }
  /** R4-03：merged workspace 的 canonical path + dev/ino 身份（adapter
   *  spawn 前验证；来自 session 创建时 lstat，kernel-owned）。 */
  readonly workspaceIdentity: { readonly path: string; readonly dev: number; readonly ino: number }
  /** R4-03：期望 filesystem policy digest —— coordinator 从 plan roots +
   *  merged hostRoot 按 runtime 的 spec.filesystem canonical 结构独立派生
   *  （kernel-owned；不能与 receipt/claim 自报值互相比对）。 */
  readonly filesystemPolicyDigest: string
}

/** intent 的 canonical 摘要（注入 spec 环境变量 → 进入 cellSpecDigest →
 *  由 broker 填入 final receipt.projectionIntentDigest）。 */
export function projectionIntentDigest(intent: ProjectionExecutionIntent): string {
  const { canonicalJson, sha256Digest } = require("../world/canonical") as typeof import("../world/canonical")
  return sha256Digest(Buffer.from(canonicalJson(intent), "utf8"))
}

/** 状态机模型：唯一真源（R2-04）—— 显式白名单查表；未列出的边一律
 *  INVALID_STATE（含终态、未投影直接 committed、非法起点等）。 */
export function applyProjectionStateTransition(
  world: ProjectionWorldState,
  execution: ProjectionExecutionState,
  transition: ProjectionStateTransition,
): { readonly world: ProjectionWorldState; readonly execution: ProjectionExecutionState } {
  const entries = PROJECTION_TRANSITION_TABLE[transition.kind]
  for (const entry of entries) {
    if (entry.from.world === world && entry.from.execution === execution) {
      if (!isValidProjectionStateVector(entry.to.world, entry.to.execution)) {
        throw new ProjectionError(
          "INVALID_STATE",
          `projection transition ${transition.kind} would reach illegal state (${entry.to.world}/${entry.to.execution})`,
        )
      }
      return entry.to
    }
  }
  throw new ProjectionError(
    "INVALID_STATE",
    `projection transition ${transition.kind} is not allowed from (${world}/${execution})`,
  )
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
  /** R3-06.5：section/world/FileManifest JSON 单对象最大字节（parse 前预检）。 */
  readonly maxManifestBytes: number
  /** R3-06.5：单条目 metadata JSON 最大字节。 */
  readonly maxMetadataBytes: number
}

export const DEFAULT_PROJECTION_LIMITS: ProjectionLimits = Object.freeze({
  maxDepth: 64,
  maxEntries: 100_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTreeBytes: 512 * 1024 * 1024,
  maxFileChunks: 4096,
  maxManifestBytes: 64 * 1024 * 1024,
  maxMetadataBytes: 1024 * 1024,
})

/** 运行时验证 limits（P2-4）：每字段必须 Number.isSafeInteger 且 > 0。
 *  跨字段关系：maxTreeBytes ≥ maxFileBytes；maxFileChunks 至少 1。
 *  任何非法值（NaN/Infinity/-Infinity/0/负/unsafe integer）→ 拒绝。 */
export function validateProjectionLimits(limits: ProjectionLimits): ProjectionLimits {
  const fields: Array<[keyof ProjectionLimits, string]> = [
    ["maxDepth", "maxDepth"],
    ["maxEntries", "maxEntries"],
    ["maxFileBytes", "maxFileBytes"],
    ["maxTreeBytes", "maxTreeBytes"],
    ["maxFileChunks", "maxFileChunks"],
  ]
  for (const [key, label] of fields) {
    const value = limits[key]
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new ProjectionError(
        "PROJECTION_RESOURCE_LIMIT",
        `projection limit ${label} must be a positive safe integer, got ${String(value)}`,
      )
    }
  }
  if (limits.maxTreeBytes < limits.maxFileBytes) {
    throw new ProjectionError(
      "PROJECTION_RESOURCE_LIMIT",
      `projection limit maxTreeBytes (${limits.maxTreeBytes}) must be >= maxFileBytes (${limits.maxFileBytes})`,
    )
  }
  // R3-06.5：manifest/metadata 上限必须是正 safe integer。
  const newFields: Array<[keyof ProjectionLimits, string]> = [
    ["maxManifestBytes", "maxManifestBytes"],
    ["maxMetadataBytes", "maxMetadataBytes"],
  ]
  for (const [key, label] of newFields) {
    const value = limits[key]
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new ProjectionError(
        "PROJECTION_RESOURCE_LIMIT",
        `projection limit ${label} must be a positive safe integer, got ${String(value)}`,
      )
    }
  }
  return limits
}

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
  | "INVALID_STATE"
  | "CLEANED_SESSION_REUSED"
  | "EXECUTION_RECEIPT_REQUIRED"
  | "EXECUTION_RECEIPT_REPLAY"
  | "EXECUTION_RECEIPT_NOT_PERSISTED"
  | "EXECUTION_RECEIPT_NOT_FINALIZED"
  | "EXECUTION_RECEIPT_FORGED"
  | "EXECUTION_RECEIPT_BINDING_MISMATCH"
  | "EXECUTION_RECEIPT_AUTHORITY_ERROR"
  | "PROJECTION_BASE_PATH_AUTHORITY"
  | "EXECUTION_INTENT_BUILD_FAILED"
  | "PRODUCTION_WORLD_COMMIT_BLOCKED"

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
