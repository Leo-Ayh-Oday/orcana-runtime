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

/** R6-03：kernel-owned 执行 profile 白名单（strict exhaustive ——
 *  unknown/missing 一律拒绝；缺省 build）。 */
const EXECUTION_PROFILES: ReadonlySet<string> = new Set([
  "inspect",
  "build",
  "test",
  "dependency",
  "service",
  "untrusted",
  "evolution",
])

const NETWORK_MODES: ReadonlySet<string> = new Set([
  "none",
  "loopback",
  "proxy-allowlist",
  "full-approved",
])

function assertPositiveSafeInteger(value: unknown, name: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ProjectionError(
      "INVALID_ACTOR",
      `plan ${name} must be a positive safe integer, got ${String(value)}`,
    )
  }
}

export function validateWorldProjectionPlan(input: WorldProjectionPlanInput): WorldProjectionPlan {
  // projectionId 是文件系统 token：safe-token 语法（拒绝 / \ . .. 等）。
  const projectionId = assertSafeProjectionId(input.projectionId)
  const worldId = assertProjectionId(input.worldId, "worldId")
  const branchId = assertProjectionId(input.branchId, "branchId")
  const snapshotId = assertProjectionId(input.snapshotId, "snapshotId")
  const actor = assertProjectionId(input.actor, "actor")

  // R6-03：strict exhaustive 验证 kernel-owned 执行 policy。
  const profile = input.profile ?? "build"
  if (!EXECUTION_PROFILES.has(profile)) {
    throw new ProjectionError(
      "INVALID_ACTOR",
      `plan profile ${String(profile)} is not a recognized ExecutionProfile`,
    )
  }
  if (input.network !== undefined) {
    if (!NETWORK_MODES.has(input.network.mode)) {
      throw new ProjectionError(
        "INVALID_ACTOR",
        `plan network.mode ${String(input.network.mode)} is not a recognized NetworkMode`,
      )
    }
    if (input.network.allowedHosts !== undefined) {
      for (const host of input.network.allowedHosts) {
        if (typeof host !== "string" || host.length === 0) {
          throw new ProjectionError("INVALID_ACTOR", "plan network.allowedHosts entries must be non-empty strings")
        }
      }
    }
    if (input.network.allowedPorts !== undefined) {
      for (const port of input.network.allowedPorts) {
        assertPositiveSafeInteger(port, "network.allowedPorts entry")
      }
    }
  }
  if (input.resources !== undefined) {
    for (const [name, value] of Object.entries(input.resources)) {
      assertPositiveSafeInteger(value, `resources.${name}`)
    }
  }
  const secretsDigest = input.secretsDigest ?? ""
  if (secretsDigest.length !== 0 && !/^[a-f0-9]{64}$/.test(secretsDigest)) {
    throw new ProjectionError("INVALID_ACTOR", "plan secretsDigest must be a 64-hex sha256 digest")
  }
  const intentId = input.intentId
  if (intentId !== undefined && (typeof intentId !== "string" || !/^[A-Za-z0-9._:-]+$/.test(intentId))) {
    throw new ProjectionError("INVALID_ACTOR", "plan intentId must be a safe token")
  }

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
    profile,
    ...(input.network === undefined ? {} : {
      network: Object.freeze({
        mode: input.network.mode,
        ...(input.network.allowedHosts === undefined ? {} : { allowedHosts: Object.freeze([...input.network.allowedHosts]) }),
        ...(input.network.allowedPorts === undefined ? {} : { allowedPorts: Object.freeze([...input.network.allowedPorts]) }),
      }),
    }),
    ...(input.resources === undefined ? {} : { resources: Object.freeze({ ...input.resources }) }),
    secretsDigest,
    ...(intentId === undefined ? {} : { intentId }),
  })
}
