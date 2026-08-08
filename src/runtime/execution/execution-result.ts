/** LR2-0D（ADR-LR2-003）：ExecutionResult —— Gateway 执行的批量结果。
 *  与 ExecutionReceipt 配套：exitCode/signal/timedOut 是执行事实，receipt
 *  是完整观测（metrics 三态、cleanup 实测），Evidence 绑定在完成链上层。 */

import type { SandboxReceipt } from "../linux/contracts"
import type { ProcessEvent } from "../process-executor"

export type ExecutionEvent = ProcessEvent

export interface ExecutionResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  aborted: boolean
  /** 完整 SandboxReceipt（LR2-0H：metrics 三态 + cleanup 实测，无推定值）。 */
  receipt?: SandboxReceipt
}
