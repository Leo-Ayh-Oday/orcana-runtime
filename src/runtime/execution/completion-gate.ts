/** LR2-0I（ADR-LR2-001/003）：Node Completion Gate —— 写节点完成判定。
 *
 *  完成链：ToolResult + Final Receipt + Verification Evidence + Ownership
 *  Evidence → Node Completion Gate。Graph 节点不能只依据 ToolResult 判断
 *  完成 —— Receipt 必须完整、无未批准写入、Cleanup 满足策略、Verification
 *  通过。服务节点走 SERVICE_READY 语义（不使用短任务完成语义）。
 *
 *  本模块是可测试的完成契约；生产 graph 集成（run scope 持有 EvidenceLedger
 *  并接线）在 LR2-0 收尾完成。
 */

import type { SandboxReceipt } from "../linux/contracts"
import { receiptComplete } from "../linux/receipt"
import { ingestSandboxReceipt, type EvidenceLedger, type EvidenceEntry } from "../../agent/evidence-ledger"

export interface NodeCompletionInput {
  /** 工具执行结果（ToolResult 的投影）。 */
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
  /** 完整 SandboxReceipt（LR2-0H：无推定值）。 */
  receipt?: SandboxReceipt
  /** 未批准写入（超出 approved 写入集的路径）。 */
  unexpectedWrites?: string[]
  /** 验证证据（Verification Evidence；缺省 = 未验证）。 */
  verificationPassed?: boolean
  /** 所有权证据（Ownership Evidence；缺省 = 未确认）。 */
  ownershipConfirmed?: boolean
}

export type CompletionVerdict =
  | { completed: true }
  | { completed: false; reasons: string[] }

/** 写节点完成条件（LR2-0I）：
 *  exitCode 满足要求 AND Receipt 完整 AND 无未批准写入
 *  AND Cleanup 满足策略 AND Verification 通过。 */
export function evaluateNodeCompletion(input: NodeCompletionInput): CompletionVerdict {
  const reasons: string[] = []
  if (input.timedOut) reasons.push("timed out")
  if (input.aborted) reasons.push("aborted")
  if (input.exitCode !== 0) reasons.push(`exit code ${input.exitCode}`)
  if (!input.receipt) {
    reasons.push("missing execution receipt")
  } else {
    if (!receiptComplete(input.receipt)) reasons.push("receipt incomplete")
    // "Cleanup 满足策略"：进程残留归零是硬条件（receiptComplete 已含）；
    // 有委托时 cleanupVerified=true 是强保证 —— 未验证时如实降级，但
    // 只要 processesRemaining===0 即满足完成条件（弱保证可审计）。
    if ((input.unexpectedWrites?.length ?? 0) > 0) {
      reasons.push(`${input.unexpectedWrites!.length} unexpected writes`)
    }
  }
  if (input.verificationPassed === false) reasons.push("verification failed")
  if (input.verificationPassed === undefined) reasons.push("verification not run")
  if (input.ownershipConfirmed === false) reasons.push("ownership not confirmed")
  return reasons.length > 0 ? { completed: false, reasons } : { completed: true }
}

/** 服务节点就绪判定：Service Cell 不使用短任务完成语义（LR2-0I）。 */
export interface ServiceReadinessInput {
  processRunning: boolean
  ready: boolean
  healthOk: boolean
  leaseHeld: boolean
}

export function evaluateServiceReady(input: ServiceReadinessInput): CompletionVerdict {
  const reasons: string[] = []
  if (!input.processRunning) reasons.push("process not running")
  if (!input.ready) reasons.push("readiness probe not passed")
  if (!input.healthOk) reasons.push("health check failed")
  if (!input.leaseHeld) reasons.push("lease expired")
  return reasons.length > 0 ? { completed: false, reasons } : { completed: true }
}

/** Receipt → Evidence 绑定适配器：写入 Run 级 EvidenceLedger（调用方持有）。
 *  Evidence 绑定 receiptDigest（LR2-0H：完整 Outcome 摘要）。 */
export function bindReceiptEvidence(ledger: EvidenceLedger, receipt: SandboxReceipt): EvidenceEntry | null {
  return ingestSandboxReceipt(ledger, receipt)
}
