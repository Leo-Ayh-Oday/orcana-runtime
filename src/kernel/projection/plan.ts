/**
 * AK-2 WorldProjectionPlan runtime validation + freeze。
 *
 * 所有输入在构造时验证并深冻结；直接调用方无法绕过 TS 类型传入
 * 非法 mode/graphCompletionAllowed/路径。
 */

import type { WorldProjectionPlan, WorldProjectionPlanInput } from "./contracts"

export type { WorldProjectionPlanInput }
import { ProjectionError } from "./contracts"
import { assertProjectionId, assertSafeProjectionId, buildProjectionScope } from "./path-policy"

export function validateWorldProjectionPlan(input: WorldProjectionPlanInput): WorldProjectionPlan {
  // projectionId 是文件系统 token：safe-token 语法（拒绝 / \ . .. 等）。
  const projectionId = assertSafeProjectionId(input.projectionId)
  const worldId = assertProjectionId(input.worldId, "worldId")
  const branchId = assertProjectionId(input.branchId, "branchId")
  const snapshotId = assertProjectionId(input.snapshotId, "snapshotId")
  const actor = assertProjectionId(input.actor, "actor")

  if (input.mode !== "native") {
    throw new ProjectionError(
      "MODE_FAIL_CLOSED",
      `projection mode ${String(input.mode)} is not supported in AK-2 (only native)`,
    )
  }
  if (input.graphCompletionAllowed !== false) {
    throw new ProjectionError(
      "GRAPH_COMPLETION_FORBIDDEN",
      "graphCompletionAllowed must be false in AK-2",
    )
  }

  const scope = buildProjectionScope(
    input.writableRoots,
    input.readonlyRoots,
    input.expectedOutputs,
  )

  return Object.freeze({
    projectionId,
    worldId,
    branchId,
    snapshotId,
    actor,
    mode: "native" as const,
    writableRoots: scope.writableRoots,
    readonlyRoots: scope.readonlyRoots,
    expectedOutputs: scope.expectedOutputs,
    graphCompletionAllowed: false,
  })
}
