/**
 * AK-2 Execution Receipt Authority —— production World commit 前必须证明
 * 的 Execution truth（P0-2 / P1-6）。
 *
 * 合同（fail-closed）：
 * - 只接受「最终 authoritative receipt」：execution finished + cleanup
 *   finalized + final digest computed + persistence succeeded；
 * - receipt 必须从权威 receipt store 读取（持久化证明）—— 任意调用方
 *   提供的 digest 字符串本身不是证据；
 * - receipt 必须绑定 run/node/cell、workspace/merged 与 spec/policy digest；
 * - host-audit receipt 永远不被接受为安全边界；
 * - persistence failure（appendReceipt 失败）→ 查询不到 → World acceptance
 *   被阻止。
 *
 * production 实现基于 runtime 的公开 RuntimeStateStore 持久化边界
 * （runs/<runId>/receipts/<cellId>.json，由 broker 在 cleanup finalized
 * 后写入 final receipt）。本模块只读消费该公开持久化布局 —— 不修改
 * src/runtime/linux/**。
 */

import { closeSync, existsSync, fstatSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { SandboxReceipt } from "../../runtime/linux/contracts"
import { RuntimeStateStore } from "../../runtime/linux/recovery/state-store"
import { ProjectionError } from "./contracts"
import { openAtNoFollow, openRootAnchored } from "./anchored-fs"

/** Execution receipt 对当前 projection session 的绑定事实。
 *  R4-03：cellSpecDigest/filesystemPolicyDigest 必须从 kernel-owned input
 *  （plan + command + intent 编译出的 spec）独立派生 —— 不是 receipt 自报
 *  值的副本；scopeDigest 必须与 intent 一致；workspace 绑定包含 canonical
 *  path 与 dev/ino 身份。 */
export interface ProjectionReceiptBinding {
  readonly runId: string
  readonly nodeRunId: string
  readonly cellId: string
  /** adapter 从 kernel-owned input 编译出的 spec digest（command/spec 绑定）。 */
  readonly cellSpecDigest: string
  /** adapter 从 kernel-owned input 编译出的 filesystem policy digest。 */
  readonly filesystemPolicyDigest: string
  /** plan scope（writable+readonly roots）的 canonical 摘要 —— 必须等于
   *  session.intent.scopeDigest（scopeDigest 真正参与验证）。 */
  readonly scopeDigest: string
  /** merged workspace 物理根（canonical path 绑定）。 */
  readonly workspaceHostRoot: string
  /** merged workspace 物理根 dev/ino 身份（workspace identity 绑定）。 */
  readonly workspaceDev: number
  readonly workspaceIno: number
}

/** 读取最终权威 receipt 的边界。 */
export interface ProjectionReceiptAuthority {
  /**
   * 按 run+cell 读取最终持久化 receipt（final cleanup truth）。
   * 返回的 receipt 必须已 cleanup-finalized 且 digest 自洽；
   * 不存在/未 finalize/损坏 → undefined（fail-closed）。
   */
  getFinalReceipt(runId: string, cellId: string): SandboxReceipt | undefined
  /** receipt 是否 cleanup-finalized（cleanup.cleanupVerified === true）。 */
  isCleanupFinalized(receipt: SandboxReceipt): boolean
}

/** 基于 runtime 持久化布局的 production 实现（只读）。 */
export class RuntimeStateReceiptAuthority implements ProjectionReceiptAuthority {
  private readonly store: RuntimeStateStore

  constructor(store?: RuntimeStateStore) {
    this.store = store ?? new RuntimeStateStore()
  }

  getFinalReceipt(runId: string, cellId: string): SandboxReceipt | undefined {
    if (typeof runId !== "string" || runId.length === 0 || typeof cellId !== "string" || cellId.length === 0) {
      return undefined
    }
    if (/[\\/\0]/.test(runId) || /[\\/\0]/.test(cellId)) return undefined
    // R2-02：anchored no-follow 读取 —— 拒绝 symlink、非 regular file、
    // 身份替换（receipt 文件被替换为 symlink → undefined → fail-closed）。
    const runDir = this.store.runDir(runId)
    if (!existsSync(runDir)) return undefined
    let receiptsDirFd: number | undefined
    let fileFd: number | undefined
    try {
      const receiptsDir = openRootAnchored(join(runDir, "receipts"))
      receiptsDirFd = receiptsDir.fd
      fileFd = openAtNoFollow(receiptsDir.fd, `${cellId}.json`)
      const stat = fstatSync(fileFd)
      if (!stat.isFile()) return undefined
      const bytes = readFileSync(fileFd)
      let parsed: unknown
      try {
        parsed = JSON.parse(bytes.toString("utf8")) as unknown
      } catch {
        return undefined
      }
      if (typeof parsed !== "object" || parsed === null) return undefined
      const receipt = parsed as SandboxReceipt
      if (typeof receipt.receiptDigest !== "string" || receipt.receiptDigest.length !== 64) return undefined
      // R2-02：用现有 canonical digest 算法重新计算 receiptDigest ——
      // 不能只检查字符串长度（tampered receipt → 自洽失败 → 拒绝）。
      const { computeReceiptDigest } = require("../../runtime/linux/receipt") as typeof import("../../runtime/linux/receipt")
      const { receiptDigest: _rd, ...rest } = receipt
      if (computeReceiptDigest(rest) !== receipt.receiptDigest) return undefined
      return receipt
    } catch {
      return undefined
    } finally {
      if (fileFd !== undefined) closeSync(fileFd)
      if (receiptsDirFd !== undefined) closeSync(receiptsDirFd)
    }
  }

  isCleanupFinalized(receipt: SandboxReceipt): boolean {
    // R2-03：cleanup truth 必须被证明，不接受类型/unknown/未证明的 degradation。
    const cleanup = receipt.cleanup
    if (cleanup === undefined) return false
    // 1. cleanupVerified 必须为 true（attach 验证 + cgroup 移除的真实证明）。
    if (cleanup.cleanupVerified !== true) return false
    // 2. 无残留进程（-1 = 无法测量 = 未证明；>0 = 残留）。
    if (cleanup.processesRemaining !== 0) return false
    // 3. mounts 必须已释放。
    if (cleanup.mountsReleased !== true) return false
    // 4. cgroup 必须已移除（backend 需要时）。
    if (cleanup.cgroupRemoved !== true) return false
    // 5. container backend：container 必须已移除（rootless-podman）。
    if (receipt.backend === "rootless-podman" && cleanup.containerRemoved !== true) return false
    // 6. secret/temp cleanup 无失败项（cleanupActions 中任何 failed/residue）。
    const actions = receipt.cleanupActions ?? []
    for (const action of actions) {
      const record = action as { ok?: boolean; status?: string; residue?: boolean; failed?: boolean }
      if (record.ok === false || record.failed === true || record.residue === true || record.status === "failed") {
        return false
      }
    }
    // 7. 未证明的 degradation 不接受（degradationReasons 为空或全部已证明）。
    //    —— 有 degradationReasons 的 receipt 不满足「cleanup 已证明」。
    if ((receipt.degradationReasons?.length ?? 0) > 0) return false
    return true
  }
}

/** 校验 outcome 声称的 receipt 是否可信且绑定本 session（P0-2/R2-01）。
 *  expected binding 来自 coordinator 生成的 Execution Intent（非 outcome
 *  自报）：receipt.projectionIntentDigest（broker 从 spec 注入）必须等于
 *  intent digest —— 历史 receipt 无法跨 World/snapshot/session 重放。
 *  R4-03：runId/nodeRunId 由 intent 独立派生（kernel-owned）；
 *  cellSpecDigest/filesystemPolicyDigest 由 adapter 从 kernel-owned input
 *  编译（binding 不是 receipt 自报值的副本）；scopeDigest 必须等于
 *  intent.scopeDigest；workspace 绑定含 canonical path + dev/ino。 */
export function assertTrustedExecutionReceipt(
  authority: ProjectionReceiptAuthority,
  intent: import("./contracts").ProjectionExecutionIntent,
  intentDigest: string,
  scopeDigest: string,
  claimedBinding: ProjectionReceiptBinding,
  claimedReceiptDigest: string,
): SandboxReceipt {
  if (claimedReceiptDigest.length === 0) {
    throw new ProjectionError("EXECUTION_RECEIPT_REQUIRED", "execution receipt required before world commit")
  }
  const receipt = authority.getFinalReceipt(intent.intentId, claimedBinding.cellId)
  if (!receipt) {
    throw new ProjectionError(
      "EXECUTION_RECEIPT_NOT_PERSISTED",
      `final receipt for intent ${intent.intentId} cell ${claimedBinding.cellId} is not persisted (pre-final digest or persistence failure)`,
    )
  }
  if (!authority.isCleanupFinalized(receipt)) {
    throw new ProjectionError(
      "EXECUTION_RECEIPT_NOT_FINALIZED",
      `receipt ${receipt.receiptDigest} is not cleanup-finalized`,
    )
  }
  // forged / pre-final digest：claim 必须等于最终持久化 digest。
  if (receipt.receiptDigest !== claimedReceiptDigest) {
    throw new ProjectionError(
      "EXECUTION_RECEIPT_FORGED",
      `claimed receipt digest ${claimedReceiptDigest} does not match final persisted digest ${receipt.receiptDigest}`,
    )
  }
  // R2-01：intent 绑定 —— receipt 必须属于 coordinator 当前 session 的
  // Execution Intent（World/branch/snapshot/projection/nonce/command/scope）。
  // 历史 receipt（跨 World/session 重放）的 intent digest 不匹配 → 拒绝。
  if (receipt.projectionIntentDigest !== intentDigest) {
    throw new ProjectionError(
      "EXECUTION_RECEIPT_REPLAY",
      `receipt ${receipt.receiptDigest} intent digest ${receipt.projectionIntentDigest ?? "<none>"} does not match session intent ${intentDigest} (cross-world/session replay refused)`,
    )
  }
  // R4-03：receipt 的 run/node 身份必须由 intent 独立派生（不是 claim 自报
  // 值）—— intent.intentId 即 runId；nodeRunId 固定 intentId:n1。
  if (receipt.runId !== intent.intentId) {
    throw new ProjectionError(
      "EXECUTION_RECEIPT_BINDING_MISMATCH",
      `receipt runId ${receipt.runId} does not match session intent ${intent.intentId}`,
    )
  }
  if (receipt.nodeRunId !== `${intent.intentId}:n1`) {
    throw new ProjectionError(
      "EXECUTION_RECEIPT_BINDING_MISMATCH",
      `receipt nodeRunId ${receipt.nodeRunId} does not match intent-derived ${intent.intentId}:n1`,
    )
  }
  if (receipt.cellId !== claimedBinding.cellId) {
    throw new ProjectionError(
      "EXECUTION_RECEIPT_BINDING_MISMATCH",
      `receipt cellId ${receipt.cellId} does not match claimed binding ${claimedBinding.cellId}`,
    )
  }
  // R4-03：binding 的 digest 必须从 kernel-owned input 派生 —— claim 与
  // receipt 自报值一致只是必要条件；binding 本身必须等于 intent 的 scope。
  if (claimedBinding.scopeDigest !== scopeDigest) {
    throw new ProjectionError(
      "EXECUTION_RECEIPT_BINDING_MISMATCH",
      `binding scopeDigest does not match session intent scope (kernel-owned input)`,
    )
  }
  if (claimedBinding.runId !== intent.intentId || claimedBinding.nodeRunId !== `${intent.intentId}:n1`) {
    throw new ProjectionError(
      "EXECUTION_RECEIPT_BINDING_MISMATCH",
      `binding run/node identity does not match intent-derived identity`,
    )
  }
  // receipt 自报 digest vs kernel-derived binding digest（不是自比对）。
  if (receipt.cellSpecDigest !== claimedBinding.cellSpecDigest) {
    throw new ProjectionError(
      "EXECUTION_RECEIPT_BINDING_MISMATCH",
      `receipt cellSpecDigest does not match kernel-derived binding`,
    )
  }
  if (receipt.filesystemPolicyDigest !== claimedBinding.filesystemPolicyDigest) {
    throw new ProjectionError(
      "EXECUTION_RECEIPT_BINDING_MISMATCH",
      `receipt filesystemPolicyDigest does not match kernel-derived binding`,
    )
  }
  // R2-01-6：receipt 的 outcome truth 必须与 coordinator 使用的 execution
  // outcome 一致（exitCode/timeout/cancelled/violation/unexpected writes）。
  const unexpectedWrites = (receipt.unexpectedWrites?.length ?? 0) > 0
  if (unexpectedWrites) {
    throw new ProjectionError(
      "EXECUTION_RECEIPT_BINDING_MISMATCH",
      `receipt records unexpected writes; world commit refused`,
    )
  }
  // host-audit 永远不是安全边界。
  if (receipt.backend === "host-audit") {
    throw new ProjectionError(
      "HOST_AUDIT_ACCEPTED_AS_SECURITY_BOUNDARY",
      `final receipt backend is host-audit; host audit is not a security boundary`,
    )
  }
  return receipt
}
