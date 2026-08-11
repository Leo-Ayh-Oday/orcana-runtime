import type {
  LLMProvider,
  ProviderCallOptions,
  ProviderFinishInfo,
  ProviderFinishReason,
  ProviderTokenUsage,
  StreamEvent,
} from "../../provider/types"
import { mergeProviderTokenUsage } from "../../provider/usage"
import { getRunRetryLedger } from "../../runtime/execution-context"
import type { RoundToolCall, ThinkingBlock } from "../run/types"
import {
  failureFromProviderEvent,
  failureFromProviderException,
} from "./failure-policy"
import {
  createProviderRoundResult,
  type ProviderRoundResult,
} from "./round-result"
import {
  createProviderRoundRetryState,
  type ProviderRoundRetryState,
} from "./round-retry-state"

export interface ProviderStreamInput {
  provider: LLMProvider
  request: ProviderCallOptions
  abortSignal?: AbortSignal
  idleTimeoutMs?: number
}

export interface ProviderRoundRunnerInput extends ProviderStreamInput {
  bufferText: boolean
}

export function providerIdleTimeoutMs(): number {
  const raw = Number(process.env.ORCANA_PROVIDER_IDLE_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 180_000
}

function providerAbortError(reason?: unknown): Error {
  const error = new Error(
    reason === undefined ? "provider round aborted" : `provider round aborted: ${String(reason)}`,
  )
  error.name = "AbortError"
  return error
}

export async function nextProviderEvent(
  iterator: AsyncIterator<StreamEvent>,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<IteratorResult<StreamEvent>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortHandler: (() => void) | undefined
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`provider stream idle timeout after ${Math.round(timeoutMs / 1000)}s`)),
          timeoutMs,
        )
      }),
      new Promise<never>((_, reject) => {
        const rejectAborted = () => reject(providerAbortError(abortSignal?.reason))
        if (abortSignal?.aborted) {
          rejectAborted()
          return
        }
        abortHandler = rejectAborted
        abortSignal?.addEventListener("abort", abortHandler, { once: true })
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (abortHandler) abortSignal?.removeEventListener("abort", abortHandler)
  }
}

function closeProviderIterator(iterator: AsyncIterator<StreamEvent> | undefined): void {
  if (!iterator?.return) return
  try {
    const closing = iterator.return()
    void Promise.resolve(closing).catch(() => {})
  } catch {
    // Provider iterator cleanup is best-effort after its AbortSignal fires.
  }
}

/**
 * The single Provider stream lifecycle entry point used by the Agent Kernel.
 * It owns the child AbortController, idle timeout and iterator cleanup while
 * preserving raw Provider event order for specialized consumers.
 */
export async function* streamProviderRoundEvents(
  input: ProviderStreamInput,
): AsyncGenerator<StreamEvent> {
  const parentSignal = input.abortSignal ?? input.request.abortSignal
  const providerAbort = new AbortController()
  const abortActiveProvider = () => {
    if (!providerAbort.signal.aborted) providerAbort.abort(parentSignal?.reason)
  }
  parentSignal?.addEventListener("abort", abortActiveProvider, { once: true })
  if (parentSignal?.aborted) abortActiveProvider()

  let providerIterator: AsyncIterator<StreamEvent> | undefined
  try {
    providerIterator = input.provider.streamChat({
      ...input.request,
      abortSignal: providerAbort.signal,
      // PR-GATE-06：主路径 provider 重试统一走 Run 级 RetryLedger。
      retryLedger: getRunRetryLedger(),
    })[Symbol.asyncIterator]()
    while (true) {
      const next = await nextProviderEvent(
        providerIterator,
        input.idleTimeoutMs ?? providerIdleTimeoutMs(),
        parentSignal,
      )
      if (next.done) return
      yield next.value
    }
  } catch (error) {
    if (!providerAbort.signal.aborted) providerAbort.abort(error)
    throw error
  } finally {
    parentSignal?.removeEventListener("abort", abortActiveProvider)
    abortActiveProvider()
    closeProviderIterator(providerIterator)
  }
}

/**
 * IC03 §21: finish 一致性 fail-closed gate —— 结构化 finish 与已收集的
 * tool calls 必须一致；不一致 → malformed，绝不执行 Tool。
 */
function enforceFinishConsistency(result: ProviderRoundResult): void {
  let consistent = true
  switch (result.finishReason) {
    case "truncated_after_action":
    case "tool_action":
      consistent = !result.partialToolCall && result.toolCalls.length === result.completedToolCallCount
      break
    case "truncated_partial_tool":
      consistent = result.partialToolCall && result.toolCalls.length === 0
      break
    default:
      break
  }
  if (!consistent) {
    // fail-closed：不执行任何 Tool。
    result.finishReason = "malformed"
    result.toolCalls = []
    result.partialToolCall = true
  }
}

/**
 * IC03 §22: 结构事件级 fallback —— legacy/custom provider 不 emit finish 时，
 * 仅基于事件结构归类（禁止从 error 字符串猜 max_tokens/length 主语义）。
 */
function legacyFinishFallback(result: ProviderRoundResult, parentSignal?: AbortSignal): void {
  if (parentSignal?.aborted) {
    result.finishReason = "cancelled"
    return
  }
  if (result.failure) {
    result.finishReason = "malformed"
    return
  }
  if (result.stopReason === "truncated") {
    // legacy truncated 事件：toolCalls 已 emit 的是完整 action。
    result.finishReason = result.toolCalls.length > 0 ? "truncated_after_action" : "truncated_before_action"
    result.completedToolCallCount = result.toolCalls.length
    return
  }
  if (result.toolCalls.length > 0) {
    result.finishReason = "tool_action"
    result.completedToolCallCount = result.toolCalls.length
    return
  }
  // done/text 正常结束 / 空轮。
  result.finishReason = "complete"
  result.completedToolCallCount = 0
}

/**
 * Execute and parse one main Agent Provider round. Outward events preserve the
 * historical streaming policy: status/tool/error always stream, text streams
 * immediately only when buffering is disabled, and usage/thinking stay local
 * to the returned round result.
 */
export async function* runProviderRound(
  input: ProviderRoundRunnerInput,
): AsyncGenerator<StreamEvent, ProviderRoundResult> {
  const result = createProviderRoundResult()
  const parentSignal = input.abortSignal ?? input.request.abortSignal
  // RC-19 Phase 1: per-round retry state — the runner is the observer of what
  // this round emitted; the provider enforces its own unsafeToRetry.
  const retryState: ProviderRoundRetryState = createProviderRoundRetryState()
  let finishSeen = false

  try {
    for await (const event of streamProviderRoundEvents(input)) {
      if (event.type === "text" && event.data) {
        retryState.emittedText = true
        result.textChunks.push(String(event.data))
        if (!input.bufferText) yield event
      } else if (event.type === "thinking_blocks" && event.data) {
        retryState.emittedThinking = true
        result.thinkingBlocks = event.data as ThinkingBlock[]
      } else if (event.type === "token_usage" && event.data) {
        result.usage = mergeProviderTokenUsage(
          result.usage,
          event.data as ProviderTokenUsage,
        )
      } else if (event.type === "status") {
        yield event
      } else if (event.type === "tool_call" && event.data) {
        if (
          input.bufferText
          && !result.bufferedTextEmitted
          && result.textChunks.length > 0
        ) {
          yield { type: "text", data: result.textChunks.join("") }
          result.bufferedTextEmitted = true
        }
        // A complete tool call handed to the executor is the side-effect
        // boundary: this round must never be blindly replayed.
        retryState.toolCallStarted = true
        retryState.completedToolCallIds.add(String((event.data as RoundToolCall).id))
        retryState.sideEffectBoundaryCrossed = true
        result.toolCalls.push(event.data as RoundToolCall)
        yield event
      } else if (event.type === "finish" && event.data) {
        // IC03: 结构化 finish —— 上层 control-flow 的唯一事实来源。
        // finish 事件不向外透传（结果由 result 承载，避免破坏既有事件流契约）。
        const info = event.data as ProviderFinishInfo
        finishSeen = true
        result.finishReason = info.finishReason
        result.rawStopReason = info.rawStopReason
        result.completedToolCallCount = info.completedToolCallCount
        result.partialToolCall = info.partialToolCall
        if (
          info.finishReason === "truncated_before_action"
          || info.finishReason === "truncated_after_action"
          || info.finishReason === "truncated_partial_tool"
        ) {
          // GATE-02 legacy compatibility（deprecated —— kernel 不再消费）。
          result.stopReason = "truncated"
        }
      } else if (event.type === "error") {
        const message = String(event.data ?? "")
        result.failure = failureFromProviderEvent(message)
        yield event
      } else if (event.type === "truncated") {
        // GATE-02 (GS-03) + IC03 §22: max_tokens is TRUNCATED, not a failure —
        // tool calls from the truncated response were already emitted and must
        // execute; the round continues as a fresh round, never a blind retry.
        // (legacy path: custom/scripted providers without structured finish)
        result.stopReason = "truncated"
        yield event
      }
    }
  } catch (error) {
    if (!parentSignal?.aborted) {
      result.failure = failureFromProviderException(error)
      yield { type: "error", data: result.failure.message }
    }
  }

  // IC03: exactly-one structured finish —— 无 finish 事件时结构事件级 fallback。
  if (!finishSeen) {
    legacyFinishFallback(result, parentSignal)
  }
  enforceFinishConsistency(result)

  result.finalText = result.textChunks.join("")
  result.aborted = parentSignal?.aborted ?? false
  retryState.aborted = result.aborted
  result.requestId = retryState.requestId
  result.sideEffectBoundaryCrossed = retryState.sideEffectBoundaryCrossed
  return result
}
