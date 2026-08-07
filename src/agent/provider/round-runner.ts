import type {
  LLMProvider,
  ProviderCallOptions,
  ProviderTokenUsage,
  StreamEvent,
} from "../../provider/types"
import { mergeProviderTokenUsage } from "../../provider/usage"
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
      } else if (event.type === "error") {
        const message = String(event.data ?? "")
        result.failure = failureFromProviderEvent(message)
        yield event
      } else if (event.type === "truncated") {
        // GATE-02 (GS-03): max_tokens is TRUNCATED, not a failure — tool
        // calls from the truncated response were already emitted and must
        // execute; the round continues as a fresh round, never a blind retry.
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

  result.finalText = result.textChunks.join("")
  result.aborted = parentSignal?.aborted ?? false
  retryState.aborted = result.aborted
  result.requestId = retryState.requestId
  result.sideEffectBoundaryCrossed = retryState.sideEffectBoundaryCrossed
  return result
}
