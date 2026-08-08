/** LR2-0D：Gateway 层错误 —— 与 LinuxExecutionError 区分：网关不变量
 *  违反（Intent 携带被禁字段、Context 缺失/未批准）在此 fail-closed。 */

export class ExecutionGatewayError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "ExecutionGatewayError"
    this.code = code
  }
}

export const GATEWAY_ERROR_CODES = {
  /** 缺失受信 Context（enabled/enforced 模式必须有）。 */
  CONTEXT_MISSING: "EXECUTION_CONTEXT_MISSING",
  /** Intent 携带被禁字段（宿主路径/cgroup/argv/seccomp/秘密值）。 */
  INTENT_FORBIDDEN_FIELD: "EXECUTION_INTENT_FORBIDDEN_FIELD",
  /** 批准能力与意图能力不一致。 */
  CAPABILITY_MISMATCH: "EXECUTION_CAPABILITY_MISMATCH",
  /** enforced 模式下 Broker 不可用。 */
  BROKER_UNAVAILABLE: "EXECUTION_BROKER_UNAVAILABLE",
} as const
