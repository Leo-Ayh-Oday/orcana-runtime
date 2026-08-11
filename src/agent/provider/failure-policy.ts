import { classifyProviderError } from "../../provider/retry"
import type { ProviderFinishReason, ProviderMessage } from "../../provider/types"
import {
  formatGenericProviderStreamBlockedReport,
  formatGenericProviderStreamRecoveryPrompt,
  formatProviderStreamBlockedReport,
  formatProviderStreamRecoveryPrompt,
} from "../runtime-failure"
import type { RetryLedger } from "../../runtime/retry-ledger"
import { compactAssistantContext } from "../round/helpers"
import { missingTaskRequirements, type TaskTracker } from "../task-tracker"
import type { ProviderFailure } from "../run/types"

export function isNonRetryableProviderStreamError(error: string): boolean {
  // GATE-02 (GS-03): max_tokens is TRUNCATED — never a generic retryable
  // provider error. The main path (deepseek/anthropic providers) already
  // emits `truncated` events instead of errors; this is the backstop for any
  // path that still surfaces it as an error: re-issuing the same doomed
  // request was the OTS-013 loop.
  return /stop_reason=max_tokens|finish_reason=(length|max_tokens)/i.test(error)
    || /^(auth|client|quota)(?:\s|:)/i.test(error)
    // TB2-1: 工具协议/SSE/传输中断错误不重试同一请求（受约束恢复由
    // tool_protocol_invalid_json 分支处理，其余直接 break，不进 truncation 账本）。
    || /tool-protocol:|malformed SSE|ended unexpectedly without finish_reason/i.test(error)
    || /insufficient[_\s-]*quota|quota[_\s-]*(?:exceeded|insufficient)|(?:exceeded|insufficient)[_\s-]*quota|balance|billing|payment\s*required|prepaid|credits?|额度|余额|欠费|账户余额|资源包|套餐/i.test(error)
}

/**
 * Provider error events historically default to retryable unless they carry a
 * known auth/client/quota marker.
 */
export function failureFromProviderEvent(message: string, kind?: string): ProviderFailure {
  return {
    message,
    retryable: !isNonRetryableProviderStreamError(message),
    yielded: true,
    kind,
  }
}

/** Thrown failures use the provider transport classifier. */
export function failureFromProviderException(error: unknown): ProviderFailure {
  const classified = classifyProviderError(error)
  const record = isRecord(error) ? error : {}
  return {
    message: error instanceof Error ? error.message : String(error),
    retryable: classified.retryable,
    yielded: true,
    // TB2-1: 类型化失败（auth_failure / quota_failure 等）随 error 对象携带。
    kind: typeof record.kind === "string" ? record.kind : undefined,
  }
}

/**
 * IC03 §19: typed finish → ProviderFailure 纯映射。
 *
 *  - complete / tool_action / truncated_* → NOT ProviderFailure（undefined）
 *  - transport_failure → retryable（与 IC03 前策略兼容）
 *  - auth_failure / quota_failure / malformed → non-retryable
 *  - cancelled → non-retryable（cancellation semantics）
 *
 * 这是三个 production Provider 主路径的失败归类入口；
 * isNonRetryableProviderStreamError() / failureFromProviderEvent() 保留为
 * legacy/custom provider compatibility backstop（主路径不再依赖字符串 regex）。
 */
export function failureFromProviderFinish(
  finishReason: ProviderFinishReason,
  message?: string,
): ProviderFailure | undefined {
  switch (finishReason) {
    case "complete":
    case "tool_action":
    case "truncated_before_action":
    case "truncated_after_action":
    case "truncated_partial_tool":
      return undefined
    case "transport_failure":
      return { message: message ?? "provider transport failure", retryable: true, yielded: true, kind: "transport" }
    case "auth_failure":
      return { message: message ?? "provider auth failure", retryable: false, yielded: true, kind: "auth_failure" }
    case "quota_failure":
      return { message: message ?? "provider quota failure", retryable: false, yielded: true, kind: "quota_failure" }
    case "malformed":
      return { message: message ?? "provider response malformed", retryable: false, yielded: true, kind: "malformed" }
    case "cancelled":
      return { message: message ?? "provider round cancelled", retryable: false, yielded: true, kind: "cancelled" }
  }
}

export interface ProviderFailureRecoveryInput {
  failure: ProviderFailure
  round: number
  maxRounds: number
  finalText: string
  taskTracker: TaskTracker | null
  changedFiles: string[]
  /** PR-GATE-06：Run 级 RetryLedger —— 同一 round 的轮续跑（truncation 类）
   *  最多一次，预算与 provider/capability/repair 层共享。 */
  retryLedger?: RetryLedger
  /**
   * IC04 §40: Run 级 RetryCoordinator —— tool protocol constrained recovery
   * 的 authorization 唯一来源（不再直接 retryLedger.canRetry/record）。
   */
  retryCoordinator?: import("../../runtime/retry/coordinator").RetryCoordinator
  /** IC04 §40/§43: 本轮已越过 side-effect boundary → 禁止重发（hard deny）。 */
  sideEffectBoundaryCrossed?: boolean
}

export interface ProviderFailureRecoveryDecision {
  action: "continue" | "break"
  status: string
  messages: ProviderMessage[]
  text?: string
  emitError: boolean
  trace: Record<string, unknown>
  /** TB2-1: 受约束恢复——下一轮压低 thinking budget（只重发一个工具调用）。 */
  reduceThinking?: boolean
}

/** TB2-1: 工具协议受约束恢复提示——禁止重新规划、只重发一个工具调用。 */
export function constrainedToolRecoveryPrompt(): ProviderMessage {
  return {
    role: "user",
    content: [
      "## 工具调用协议错误（受约束恢复）",
      "上一条回复中的工具调用参数不是合法 JSON（或缺少必填字段），所有工具均未执行。",
      "本轮只做一件事：**只重发一个工具调用**，参数必须是合法 JSON 并包含全部必填字段。",
      "禁止重新规划，禁止长篇解释，禁止输出多余文本。",
      "若你仍无法生成合法 JSON，请直接说明无法继续——不要再次尝试。",
    ].join("\n"),
  }
}

/**
 * Pure retry-or-block policy. The Agent loop remains the control-flow owner,
 * but Provider-specific recovery prompts and failure classification stay in
 * the Provider stage.
 */
export function decideProviderFailureRecovery(
  input: ProviderFailureRecoveryInput,
): ProviderFailureRecoveryDecision {
  const { failure } = input

  // TB2-1: invalid tool JSON 只允许一次受约束恢复（tool 类 ledger 上限 = 1）：
  // 降低 thinking budget、禁止重新规划、只重发一个工具调用；第二次仍失败
  // 立即 provider_failure，不再烧完整上下文和剩余轮次。
  if (failure.kind === "tool_protocol_invalid_json" || /invalid tool call JSON/i.test(failure.message)) {
    // TB2-1: run 级指纹（非 per-round）——整次运行最多恢复一次，
    // 第二次仍失败立即 provider_failure，不烧完整上下文和剩余轮次。
    const fingerprint = "tool_protocol:run"
    // IC04 §40/§43: authorization 唯一来源 RetryCoordinator ——
    // side-effect boundary crossed → hard deny（禁止重发）。
    const permit = input.retryCoordinator
      ? input.retryCoordinator.authorizeRetry({ retryClass: "tool", fingerprint, sideEffectBoundaryCrossed: input.sideEffectBoundaryCrossed })
      : input.retryLedger?.canRetry("tool", fingerprint)
        ? { allowed: true }
        : { allowed: false }
    const ledgerAllows = input.retryCoordinator ? permit.allowed : (input.retryLedger?.canRetry("tool", fingerprint) ?? false)
    if (ledgerAllows && input.round + 1 < input.maxRounds) {
      if (!input.retryCoordinator) input.retryLedger?.record("tool", fingerprint)
      return {
        action: "continue",
        reduceThinking: true,
        status: "provider-tool-protocol: constrained recovery (single tool call re-send)",
        messages: [constrainedToolRecoveryPrompt()],
        emitError: !failure.yielded,
        trace: {
          gate: "provider_tool_protocol",
          decision: "continue",
          kind: failure.kind ?? "tool_protocol_invalid_json",
        },
      }
    }
    return {
      action: "break",
      status: "provider-tool-protocol: failed after one constrained recovery",
      messages: [],
      emitError: !failure.yielded,
      trace: {
        gate: "provider_tool_protocol",
        decision: "blocked",
        kind: failure.kind ?? "tool_protocol_invalid_json",
      },
    }
  }

  if (!failure.retryable) {
    return {
      action: "break",
      status: `provider-stream-gate: blocked (non-retryable: ${failure.message.slice(0, 80)})`,
      messages: [],
      emitError: !failure.yielded,
      trace: {
        gate: "provider_stream",
        decision: "blocked",
        reason: "non_retryable",
        error: failure.message,
      },
    }
  }

  // PR-GATE-06：轮续跑属于 truncation 类 —— 同一 round 经 ledger 严格限次
  // （truncation <= 1），不再只依赖 maxRounds 宽松边界。
  const roundFingerprint = `truncation:${input.round}`
  const ledgerAllows = !input.retryLedger || input.retryLedger.canRetry("truncation", roundFingerprint)
  const canRetry = ledgerAllows && input.round + 1 < input.maxRounds
  const assistantContext: ProviderMessage[] = input.finalText.trim()
    ? [{ role: "assistant", content: compactAssistantContext(input.finalText) }]
    : []

  if (input.taskTracker) {
    const missing = missingTaskRequirements(input.taskTracker)
    if (canRetry) {
      input.retryLedger?.record("truncation", roundFingerprint)
      return {
        action: "continue",
        status: "provider-stream-gate: retrying unfinished long task",
        messages: [
          ...assistantContext,
          {
            role: "user",
            content: formatProviderStreamRecoveryPrompt({
              error: failure.message,
              missing,
            }),
          },
        ],
        emitError: !failure.yielded,
        trace: {
          gate: "provider_stream",
          decision: "continue",
          error: failure.message,
          missing,
        },
      }
    }

    return {
      action: "break",
      status: "provider-stream-gate: blocked unfinished long task",
      messages: [],
      text: formatProviderStreamBlockedReport({
        error: failure.message,
        missing,
        changedFiles: input.changedFiles,
      }),
      emitError: !failure.yielded,
      trace: {
        gate: "provider_stream",
        decision: "blocked",
        error: failure.message,
        missing,
      },
    }
  }

  if (canRetry) {
    input.retryLedger?.record("truncation", roundFingerprint)
    return {
      action: "continue",
      status: "provider-stream-gate: retrying interrupted round",
      messages: [
        ...assistantContext,
        {
          role: "user",
          content: formatGenericProviderStreamRecoveryPrompt({
            error: failure.message,
          }),
        },
      ],
      emitError: !failure.yielded,
      trace: {
        gate: "provider_stream",
        decision: "continue",
        error: failure.message,
      },
    }
  }

  return {
    action: "break",
    status: "provider-stream-gate: blocked interrupted round",
    messages: [],
    text: formatGenericProviderStreamBlockedReport({
      error: failure.message,
    }),
    emitError: !failure.yielded,
    trace: {
      gate: "provider_stream",
      decision: "blocked",
      error: failure.message,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
