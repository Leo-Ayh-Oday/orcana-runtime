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

export interface ProjectionExecutionOutcome {
  readonly exitCode: number
  readonly timedOut: boolean
  readonly cancelled: boolean
  readonly violation: boolean
  /** Linux execution receipt id（broker adapter 提供；仅记录 Execution 事实）。 */
  readonly executionReceiptId?: string
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

/** expected output 存在性检查（R05.5）：anchored no-follow ——
 *  open(O_NOFOLLOW) + fstat 验证类型；symlink/special file 拒绝。
 *  cleanupOk 不在此接口（R03.7：cleanup 的真实结果由 coordinator 在
 *  卸载步骤决定，validate 不得伪造）。 */
function assertExpectedOutput(mergedDir: string, output: string): void {
  const full = resolve(join(mergedDir, ...output.split("/")))
  if (!full.startsWith(resolve(mergedDir) + sep)) {
    throw new ProjectionError("VALIDATION_REJECTED", `expected output escapes merged view: ${output}`)
  }
  try {
    const stat = lstatSync(full)
    if (stat.isSymbolicLink()) {
      throw new ProjectionError("VALIDATION_REJECTED", `expected output is a symlink: ${output}`)
    }
    if (stat.isFile()) {
      // O_NOFOLLOW + fstat 复核（symlink swap 防护）：期望 regular file。
      const fd = openSync(full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      try {
        const check = fstatSync(fd)
        if (!check.isFile()) {
          throw new ProjectionError("VALIDATION_REJECTED", `expected output is not a regular file: ${output}`)
        }
      } finally {
        closeSync(fd)
      }
      return
    }
    if (stat.isDirectory()) {
      const fd = openSync(full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY)
      try {
        const check = fstatSync(fd)
        if (!check.isDirectory()) {
          throw new ProjectionError("VALIDATION_REJECTED", `expected output is not a directory: ${output}`)
        }
      } finally {
        closeSync(fd)
      }
      return
    }
    throw new ProjectionError("VALIDATION_REJECTED", `expected output is not a regular file/directory: ${output}`)
  } catch (error) {
    if (error instanceof ProjectionError) throw error
    throw new ProjectionError("VALIDATION_REJECTED", `expected output missing: ${output}`)
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
