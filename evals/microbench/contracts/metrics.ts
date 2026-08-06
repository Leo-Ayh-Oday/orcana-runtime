/** ORMB Hard Gates — 通过门槛。每个 gate 的失败用例数必须为 0。 */

export const HARD_GATES = [
  // ORMB-PP：provider 协议
  "DUPLICATE_TOOL_CALL", // 同一 tool call 被 emit 两次
  "TOOL_RESULT_MISMATCH", // tool call 的 id/name/input 错配
  "RETRY_AFTER_SIDE_EFFECT", // 已产出 text/tool 后仍发生重试
  "LOST_TOOL_CALL", // provider 声明了 tool call 却未 emit
  "MISSING_STOP_REASON_ACCEPTED", // EOF 无 stop_reason 却产出 done
  "SILENT_MODEL_SWITCH", // actualModel ≠ requestedModel 但未上报
  "TOKEN_TELEMETRY_MISSING", // 有 usage 的流未 emit token_usage
  "ABORT_IGNORED", // abort 后流未关闭/仍在产出
  // ORMB-TU：工具调用高风险项（计划 §三：高风险错误调用 = 0）
  "HALLUCINATED_TOOL", // 调用工作区中不存在的工具（虚构工具）
  "UNSAFE_SIDE_EFFECT", // 只读任务出现写副作用/越权写
  "REDUNDANT_SIDE_EFFECT", // 同一副作用操作被执行两次
  // ORMB-SR/TR：路由高风险项（计划 §四/§五：Forbidden 激活 ≤1%、高风险漏判 = 0）
  "FORBIDDEN_SKILL_ACTIVATION", // 禁激活技能被激活（负迁移风险）
  "RISK_HIGH_MISS", // GT 高风险任务被分诊为 low
  "MODE_MISMATCH", // 分诊 mode 与 GT 不符（计划 §五 Mode Macro F1 目标 ≥93%）
  "NEEDS_WEB_MISMATCH", // needsWeb 判断与 GT 不符（计划 §五 needsWeb 误触发 ≤5%）
] as const

export type HardGateName = (typeof HARD_GATES)[number]
