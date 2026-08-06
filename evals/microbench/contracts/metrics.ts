/** ORMB Hard Gates — ORMB-PP 的通过门槛。每个 gate 的失败用例数必须为 0。 */

export const HARD_GATES = [
  "DUPLICATE_TOOL_CALL", // 同一 tool call 被 emit 两次
  "TOOL_RESULT_MISMATCH", // tool call 的 id/name/input 错配
  "RETRY_AFTER_SIDE_EFFECT", // 已产出 text/tool 后仍发生重试
  "LOST_TOOL_CALL", // provider 声明了 tool call 却未 emit
  "MISSING_STOP_REASON_ACCEPTED", // EOF 无 stop_reason 却产出 done
  "SILENT_MODEL_SWITCH", // actualModel ≠ requestedModel 但未上报
  "TOKEN_TELEMETRY_MISSING", // 有 usage 的流未 emit token_usage
  "ABORT_IGNORED", // abort 后流未关闭/仍在产出
] as const

export type HardGateName = (typeof HARD_GATES)[number]
