/**
 * AK-2 Commit Validator —— World commit 前的全部 fail-closed 检查。
 *
 * 验证顺序（coordinator 调用）：
 * 1. snapshot/world/branch 身份与 base revision（stale → WORLD_HEAD_MOVED）；
 * 2. execution outcome（exitCode!=0 / timeout / cancel / violation → REJECTED）；
 * 3. cleanup 已完成（失败 → CLEANUP_FAILED，阻止 commit）；
 * 4. 所有 create/write/delete/rename 均在 writableRoots；
 *    readonlyRoots 任何变化 / 未授权写入 → REJECTED；
 * 5. expectedOutputs 存在且为允许类型（symlink output → REJECTED）；
 * 6. delta digest 与 commit receipt 一致性由 coordinator 复核。
 */

import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import type { AgentWorld, WorldBranch, WorldSnapshot } from "../world/contracts"
import type { WorldProjectionPlan } from "./contracts"
import { ProjectionError } from "./contracts"
import { pathWithinAny } from "./path-policy"
import type { ProjectionDeltaResult } from "./scanner"
import { openRootAnchored, statExpectedOutputAnchored } from "./anchored-fs"

export interface ProjectionExecutionOutcome {
  readonly exitCode: number
  readonly timedOut: boolean
  readonly cancelled: boolean
  readonly violation: boolean
  /** Linux execution receipt id（broker adapter 提供；仅记录 Execution 事实）。
   *  只携带**最终**持久化 receipt 的 digest（P1-6：pre-final digest 永不
   *  进入 World commit）。 */
  readonly executionReceiptId?: string
  /** receipt 对当前 projection session 的绑定事实（P0-2）。 */
  readonly receiptBinding?: import("./receipt-authority").ProjectionReceiptBinding
}

export interface ProjectionValidationInput {
  readonly plan: WorldProjectionPlan
  readonly snapshot: WorldSnapshot
  readonly world: AgentWorld
  readonly branch: WorldBranch
  /** 验证时 World 的当前 revision（== snapshot.revision 才可 commit）。 */
  readonly currentRevision: bigint
  readonly delta: ProjectionDeltaResult
  /** merged view（expected outputs 存在性检查）。 */
  readonly mergedDir: string
  readonly outcome: ProjectionExecutionOutcome
}

export interface ProjectionValidationResult {
  readonly ok: true
  readonly reason: undefined
}

/** expected output 存在性检查（R05.5/P1-5）：anchored no-follow 原语 ——
 *  root dirfd + 逐层 O_NOFOLLOW 锚定 + fstat 类型验证（symlink/special
 *  file 拒绝；父目录替换不影响已锚定 fd）。
 *  cleanupOk 不在此接口（R03.7：cleanup 的真实结果由 coordinator 在
 *  卸载步骤决定，validate 不得伪造）。 */
function assertExpectedOutput(mergedDir: string, output: string): void {
  const full = resolve(join(mergedDir, ...output.split("/")))
  if (!full.startsWith(resolve(mergedDir) + sep)) {
    throw new ProjectionError("VALIDATION_REJECTED", `expected output escapes merged view: ${output}`)
  }
  let root
  try {
    root = openRootAnchored(mergedDir)
  } catch (error) {
    // validator 语义统一：merged 视图不可用/缺失 → VALIDATION_REJECTED。
    throw new ProjectionError(
      "VALIDATION_REJECTED",
      `expected output check failed: ${output}`,
      error instanceof Error ? error.message : String(error),
    )
  }
  try {
    statExpectedOutputAnchored(root.fd, output, output)
  } finally {
    closeSync(root.fd)
  }
}

/** 验证；任何失败抛 ProjectionError（code 见各分支）。
 *  不接收 cleanupOk —— cleanup 的真实结果由 coordinator 卸载步骤决定。 */
export function validateProjectionCommit(input: ProjectionValidationInput): ProjectionValidationResult {
  const { plan, snapshot, world, branch, delta, mergedDir, outcome } = input

  // 1. snapshot/world/branch 身份。
  if (snapshot.worldId !== plan.worldId || snapshot.branchId !== plan.branchId) {
    throw new ProjectionError(
      "SNAPSHOT_MISMATCH",
      `snapshot ${snapshot.snapshotId} belongs to ${snapshot.worldId}/${snapshot.branchId}, plan wants ${plan.worldId}/${plan.branchId}`,
    )
  }
  if (world.worldId !== plan.worldId) {
    throw new ProjectionError("SNAPSHOT_MISMATCH", `world ${world.worldId} does not match plan ${plan.worldId}`)
  }
  if (world.status !== "active" || branch.status !== "active") {
    throw new ProjectionError("VALIDATION_REJECTED", `world/branch is not active (${world.status}/${branch.status})`)
  }
  if (world.currentBranchId !== plan.branchId) {
    throw new ProjectionError("VALIDATION_REJECTED", `world current branch is ${world.currentBranchId}, plan wants ${plan.branchId}`)
  }
  // base revision：snapshot.revision 必须等于验证时的 World head。
  if (input.currentRevision !== snapshot.revision) {
    throw new ProjectionError(
      "WORLD_HEAD_MOVED",
      `snapshot revision ${snapshot.revision} but world head is ${input.currentRevision}`,
    )
  }

  // 2. execution outcome。
  if (outcome.cancelled) {
    throw new ProjectionError("EXECUTION_CANCELLED", "execution was cancelled; world commit refused")
  }
  if (outcome.timedOut || outcome.exitCode !== 0 || outcome.violation) {
    throw new ProjectionError(
      "EXECUTION_FAILED",
      `execution outcome ${outcome.exitCode} (timeout=${outcome.timedOut}, violation=${outcome.violation}) refuses world commit`,
    )
  }

  // 3. 路径归属。
  const writable = plan.writableRoots
  const readonly = plan.readonlyRoots
  for (const entry of delta.entries) {
    if (entry.kind === "rename") {
      for (const path of [entry.oldPath, entry.newPath]) {
        if (pathWithinAny(path, readonly)) {
          throw new ProjectionError("VALIDATION_REJECTED", `rename touches readonly path: ${path}`)
        }
        if (!pathWithinAny(path, writable)) {
          throw new ProjectionError("VALIDATION_REJECTED", `rename path outside writable roots: ${path}`)
        }
      }
      continue
    }
    const path = entry.path
    if (pathWithinAny(path, readonly)) {
      throw new ProjectionError("VALIDATION_REJECTED", `mutation touches readonly path: ${path}`)
    }
    if (!pathWithinAny(path, writable)) {
      throw new ProjectionError("VALIDATION_REJECTED", `mutation path outside writable roots: ${path}`)
    }
  }

  // 5. expected outputs（anchored no-follow 原语）。
  for (const output of plan.expectedOutputs) {
    assertExpectedOutput(mergedDir, output)
  }

  return { ok: true, reason: undefined }
}
