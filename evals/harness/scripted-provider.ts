/**
 * H12 ScriptedProvider (plan §18.3) — a script-driven LLMProvider.
 *
 * Events are consumed per streamChat call, routed by purpose (untagged
 * events serve agent_main). The round ends at round_end (consumed, not
 * yielded). Usage events carry NO round — the kernel cumulates them into
 * the final provider usage snapshot (delta accounting in the BudgetGuard).
 * Unknown purposes get a trivial fallback response so bypass calls never
 * consume the main script.
 */

import type { LLMProvider, ProviderCallOptions, ProviderFinishInfo, StreamEvent } from "../../src/provider/types"
import type { ProviderScriptEvent, ProviderCallPurpose } from "./contracts"

export class ScriptedProvider implements LLMProvider {
  private readonly scripts: Map<string, ProviderScriptEvent[]>
  private readonly cursors = new Map<string, number>()
  private toolCallCounter = 0

  constructor(script: ProviderScriptEvent[]) {
    // Partition by purpose: untagged → agent_main.
    this.scripts = new Map()
    for (const event of script) {
      const purpose = event.type === "round_end" ? "agent_main" : (event.purpose ?? "agent_main")
      const list = this.scripts.get(purpose)
      if (list) list.push(event)
      else this.scripts.set(purpose, [event])
    }
  }

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    const purpose = options.purpose ?? "agent_main"
    const script = this.scripts.get(purpose)

    if (!script) {
      yield* this.fallbackResponse(purpose)
      return
    }

    // One round per call: consume from the cursor until the next round_end
    // (the boundary itself is consumed, not yielded). Exhausted scripts
    // yield nothing — the kernel sees an empty round and terminates.
    let cursor = this.cursors.get(purpose) ?? 0
    for (; cursor < script.length; cursor++) {
      const event = script[cursor]!
      if (event.type === "round_end") {
        cursor += 1
        break
      }
      const shouldContinue = yield* this.yieldEvent(event, options)
      if (!shouldContinue) {
        cursor += 1
        break
      }
    }
    this.cursors.set(purpose, cursor)
  }

  /** Yields one scripted event; returns whether the round should continue consuming. */
  private async *yieldEvent(event: ProviderScriptEvent, options: ProviderCallOptions): AsyncGenerator<StreamEvent, boolean> {
    switch (event.type) {
      case "text":
        yield { type: "text", data: event.data }
        return true
      case "tool_call":
        yield {
          type: "tool_call",
          data: { id: `script-call-${++this.toolCallCounter}`, name: event.name, input: event.input },
        }
        return true
      case "usage":
        yield {
          type: "token_usage",
          data: {
            inputTokens: event.input,
            outputTokens: event.output,
            cacheMissInputTokens: event.cacheMiss ?? 0,
            cacheSource: "provider",
          },
        }
        return true
      case "error":
        // non_retryable → auth-style message (hits isNonRetryableProviderStreamError);
        // the failure surfaces to the kernel which fail-closes.
        if (event.errorType === "non_retryable") {
          yield { type: "error", data: event.message ?? "auth: invalid api key" }
          return true
        }
        // IC04 §34/§37: retryable errors follow the production provider retry
        // contract — the same streamChat call retries internally:
        //   coordinator authorize → reissue (consume the next script event as
        //   the retry response) and keep going;
        //   coordinator deny → structured transport_failure termination (the
        //   kernel fail-closes, never a whole-round continuation).
        if (options.retryCoordinator) {
          const permit = options.retryCoordinator.authorizeProviderAttempt({})
          if (!permit.allowed) {
            yield { type: "error", data: event.message ?? "provider stream interrupted" }
            yield {
              type: "finish",
              data: {
                finishReason: "transport_failure",
                rawStopReason: undefined,
                completedToolCallCount: 0,
                partialToolCall: false,
              } satisfies ProviderFinishInfo,
            }
            return false
          }
        }
        yield { type: "status", data: `provider retry: ${event.message ?? "stream interrupted"}` }
        return true
      case "idle_timeout":
        // Hangs until the harness aborts/returns the iterator (wall-time
        // watchdog or idle timeout). The hanging await is abandoned when the
        // caller closes the generator. Caller must set maxWallTimeMs.
        yield { type: "status", data: "scripted-provider: idle hang" }
        await new Promise<void>(() => {})
        return true
      case "plan_ready":
        yield { type: "plan_ready", data: { planText: event.planText } }
        return true
      case "clarification_ready":
        yield { type: "clarification_ready", data: event.questions }
        return true
      case "status":
        yield { type: "status", data: event.data }
        return true
      case "thinking_blocks":
        yield { type: "thinking_blocks", data: event.data }
        return true
      case "round_end":
        return true
    }
  }

  private *fallbackResponse(purpose: ProviderCallPurpose): Generator<StreamEvent> {
    if (purpose === "flash_triage") {
      yield { type: "text", data: JSON.stringify({ mode: "simple", reasoning: "scripted fallback" }) }
      return
    }
    yield { type: "text", data: "ok" }
  }
}
