/**
 * AK2-R6 —— kernel-owned/trusted execution spec compiler。
 *
 * R6-03：expected cellSpecDigest 必须由 kernel 从权威输入（intent =
 * plan + session）派生 —— 不是 adapter 选项自报、更不是 receipt/outcome
 * 同源字段互相比对。本模块使用 runtime 的**唯一正式编译器**
 * （compileCapabilityRequest —— policy-compiler.ts）：
 *
 * - buildProjectionExecutionRequest：intent → UntrustedCapabilityRequest
 *   （command/profile/network/resources/mounts/env 全部来自 kernel 输入）；
 * - buildProjectionAuthority：session workspace + intent identity
 *   （runId=intentId / nodeRunId / attempt / cellId 可覆盖 —— 使重编译
 *   完全 deterministic）；
 * - expectedProjectionCellSpecDigest：规范化 cellId 的期望 digest
 *   （adapter spawn 前比对）；
 * - expectedProjectionCellSpecDigestForCell：用 receipt 的真实 cellId
 *   重编译并与 receipt.cellSpecDigest 直接比较（commit 时）。
 *
 * 环境变量 ORCANA_PROJECTION_INTENT 不能单独充当实际 spec 证明 —— 它
 * 只是 binding 链的一环；spec 事实由上述 digest 比较证明。
 */

import { ProjectionError, projectionIntentDigest, type ProjectionExecutionIntent } from "./contracts"
import type { UntrustedCapabilityRequest, TrustedExecutionAuthority } from "../../runtime/linux/contracts"
import { compileCapabilityRequest } from "../../runtime/linux/policy-compiler"
import { cellSpecDigest, cellSpecDigestNormalized } from "../../runtime/linux/receipt"

export const NORMALIZED_CELL_ID = "kernel-expected-cell"

/** intent（kernel-owned）→ UntrustedCapabilityRequest（与 adapter 构造
 *  完全同构；字段全部来自 intent，不读取任何 adapter 选项）。 */
export function buildProjectionExecutionRequest(intent: ProjectionExecutionIntent): UntrustedCapabilityRequest {
  return {
    command: {
      executable: intent.command.executable,
      args: [...intent.command.args],
      relativeCwd: ".",
      stdin: "closed",
    },
    profile: intent.profile,
    ...(intent.network === undefined
      ? {}
      : {
          network: {
            mode: intent.network.mode,
            ...(intent.network.allowedHosts === undefined ? {} : { allowedHosts: [...intent.network.allowedHosts] }),
            ...(intent.network.allowedPorts === undefined ? {} : { allowedPorts: [...intent.network.allowedPorts] }),
          },
        }),
    timeoutMs: intent.command.timeoutMs,
    writableMounts: intent.filesystemScope.writableRoots.map(path => ({
      source: { type: "workspace-relative", path },
      target: `/workspace/${path}`,
      mode: "rw" as const,
    })),
    readonlyMounts: intent.filesystemScope.readonlyRoots.map(path => ({
      source: { type: "workspace-relative", path },
      target: `/workspace/${path}`,
      mode: "ro" as const,
    })),
    env: { ORCANA_PROJECTION_INTENT: projectionIntentDigest(intent) },
    ...(intent.resources?.memoryMaxBytes === undefined ? {} : { memoryMaxBytes: intent.resources.memoryMaxBytes }),
    ...(intent.resources?.pidsMax === undefined ? {} : { pidsMax: intent.resources.pidsMax }),
    ...(intent.resources?.stdoutMaxBytes === undefined ? {} : { stdoutMaxBytes: intent.resources.stdoutMaxBytes }),
    ...(intent.resources?.stderrMaxBytes === undefined ? {} : { stderrMaxBytes: intent.resources.stderrMaxBytes }),
  }
}

/** session workspace + intent identity → TrustedExecutionAuthority
 *  （cellId 覆盖使重编译 deterministic）。 */
export function buildProjectionAuthority(
  intent: ProjectionExecutionIntent,
  hostRoot: string,
  ownerFiles: readonly string[],
  cellId?: string,
): TrustedExecutionAuthority {
  return {
    identity: {
      runId: intent.intentId,
      nodeRunId: `${intent.intentId}:n1`,
      attempt: 1,
      ...(cellId === undefined ? {} : { cellId }),
    },
    workspace: {
      workspaceId: `projection-${intent.projectionId}`,
      physicalWorkspaceKey: `projection-${intent.projectionId}`,
      projectId: `projection-${intent.projectionId}`,
      hostRoot,
      kind: "worktree",
      access: "readwrite",
      ownerFiles: [...ownerFiles],
    },
  }
}

/** kernel-owned/trusted 编译（唯一正式入口）；失败 → EXECUTION_INTENT_
 *  BUILD_FAILED（fail-closed）。 */
export function compileProjectionSpec(
  intent: ProjectionExecutionIntent,
  hostRoot: string,
  ownerFiles: readonly string[],
  cellId: string,
): import("../../runtime/linux/contracts").ExecutionCellSpec {
  const request = buildProjectionExecutionRequest(intent)
  const authority = buildProjectionAuthority(intent, hostRoot, ownerFiles, cellId)
  const compiled = compileCapabilityRequest(request, authority)
  if (!compiled.ok) {
    throw new ProjectionError(
      "EXECUTION_INTENT_BUILD_FAILED",
      `kernel-owned spec compile failed: ${compiled.errors.join("; ")}`,
    )
  }
  return compiled.spec
}

/** 规范化期望 digest（cellId 无关）—— adapter spawn 前比对。 */
export function expectedProjectionCellSpecDigest(
  intent: ProjectionExecutionIntent,
  hostRoot: string,
  ownerFiles: readonly string[],
): string {
  const spec = compileProjectionSpec(intent, hostRoot, ownerFiles, NORMALIZED_CELL_ID)
  return cellSpecDigestNormalized(spec, NORMALIZED_CELL_ID)
}

/** 用真实 cellId 重编译的期望 digest —— commit 时与 receipt.cellSpecDigest
 *  直接比较（deterministic recompile；同源互相比对被禁止）。 */
export function expectedProjectionCellSpecDigestForCell(
  intent: ProjectionExecutionIntent,
  hostRoot: string,
  ownerFiles: readonly string[],
  cellId: string,
): string {
  const spec = compileProjectionSpec(intent, hostRoot, ownerFiles, cellId)
  return cellSpecDigest(spec)
}
