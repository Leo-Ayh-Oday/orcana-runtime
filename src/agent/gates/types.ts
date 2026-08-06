/** Core gate types for the composable GateChain architecture.
 *
 *  Each gate is an independent unit with its own state, tests, and circuit-breaker logic.
 *  Gates are composed via `GateChain.pipe([...])` — first block wins, remaining gates skip.
 *
 *  Lifecycle phases each have their own context type:
 *    PreRoundContext  — before the provider call each round
 *    ToolContext      — per tool call during tool execution
 *    CompletionContext — when the agent has no more tool calls and produces final text
 *    PostRoundContext  — after each round completes
 */

// ── Result ──

export interface GateResult {
  /** true = gate allows execution to proceed. false = gate blocks. */
  pass: boolean
  /** Machine-readable reason code for telemetry/debugging. */
  reason?: string
  /** Human-readable block message injected into the conversation when blocked. */
  message?: string
  /** RC-02: 预算耗尽而非真实失败——调用方必须按 incomplete 处理，不得继续注入消息。 */
  incomplete?: boolean
}

// ── Gate contract ──

export interface Gate<TContext> {
  /** Unique identifier for logging and overflow tracking. */
  readonly name: string
  /** Evaluate the gate against the current context. Must be idempotent — gates may be re-evaluated. */
  evaluate(ctx: TContext): GateResult | Promise<GateResult>
}

// ── Chain trace (for diagnostics) ──

export interface GateTrace {
  gateName: string
  result: GateResult
}
