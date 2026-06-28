/** Hook system — lifecycle event interception with priority-based output semantics.
 *
 *  PR-7.2: 5 lifecycle events aligned with Claude Code's hook model:
 *    SessionStart     — inject context before agent loop begins
 *    UserPromptSubmit — intercept/transform user prompts
 *    PreToolUse       — intercept + optionally block/replace tool calls
 *    PostToolUse      — post-process tool results
 *    Stop             — cleanup on agent exit (fire-and-forget)
 *
 *  Hook output priority: blocked > replace > warn > allow
 *    - blocked: immediate stop, no further handlers run (unless after-block handlers opted in)
 *    - replace: modify tool params (PreToolUse) or result (PostToolUse). Last replace wins.
 *    - warn: accumulate warnings from all handlers, appended to tool output.
 *    - allow: explicit pass-through (handler has no opinion).
 *
 *  Every HookOutput carries a `source` for audit trail — who decided what.
 *
 *  Backward compatibility:
 *    - `onToolBefore()` / `onToolAfter()` kept as convenience aliases
 *    - `runBefore()` / `runAfter()` delegate to dispatch("PreToolUse") / dispatch("PostToolUse")
 */

// ── Lifecycle events ──

export enum HookEvent {
  /** Fires once at session start, before the agent loop. Can inject context. */
  SessionStart = "SessionStart",
  /** Fires when the user submits a prompt. Can block, replace, or inject context. */
  UserPromptSubmit = "UserPromptSubmit",
  /** Fires before each tool execution. Can block, replace params, or warn. */
  PreToolUse = "PreToolUse",
  /** Fires after each tool execution. Can block, replace result, or warn. */
  PostToolUse = "PostToolUse",
  /** Fires when the agent loop exits. Fire-and-forget — no blocking, no return value used. */
  Stop = "Stop",
}

// ── Per-event input types ──

export interface SessionStartInput {
  projectRoot: string
  mode: string
  toolNames: string[]
  sessionId?: string
}

export interface UserPromptSubmitInput {
  prompt: string
  round: number
  sessionId?: string
}

export interface PreToolUseInput {
  tool: string
  params: Record<string, unknown>
}

export interface PostToolUseInput {
  tool: string
  params: Record<string, unknown>
  result: { success: boolean; content: string }
  error?: string
}

export interface StopInput {
  reason: "completed" | "aborted" | "error" | "blocked"
  totalRounds: number
  sessionDurationMs: number
  exitCode?: number
}

/** Union of all event inputs (used for generic dispatch). */
export type HookEventInput =
  | { event: HookEvent.SessionStart; input: SessionStartInput }
  | { event: HookEvent.UserPromptSubmit; input: UserPromptSubmitInput }
  | { event: HookEvent.PreToolUse; input: PreToolUseInput }
  | { event: HookEvent.PostToolUse; input: PostToolUseInput }
  | { event: HookEvent.Stop; input: StopInput }

// ── Hook output ──

export interface HookOutput {
  /** Block execution immediately. Highest priority. */
  blocked?: boolean
  /** Replace tool input params (PreToolUse only). */
  replace?: Record<string, unknown>
  /** Replace tool result (PostToolUse only). */
  result?: { success: boolean; content: string }
  /** Warning to append to tool output. */
  warn?: string
  /** Identifier for audit trail — which hook produced this decision. */
  source?: string
  /** SessionStart / UserPromptSubmit: context to inject into the conversation. */
  context?: string
  /** UserPromptSubmit: replace the user's prompt entirely. */
  replacePrompt?: string
}

// ── Handler types ──

/** Generic hook handler — receives typed input and returns HookOutput.
 *  For Stop events, the return value is ignored (fire-and-forget). */
export type HookHandler<T = unknown> = (input: T) => HookOutput | Promise<HookOutput>

/** Legacy handler type — kept for backward compat with existing builtin hooks. */
export type LegacyHookHandler = (input: HookInput) => HookOutput | Promise<HookOutput>

/** Legacy input type — kept for backward compat. */
export interface HookInput {
  tool?: string
  params?: Record<string, unknown>
  result?: { success: boolean; content: string }
  error?: string
}

// ── Collected results ──

export interface BeforeHookResult {
  blocked: boolean
  replaceParams?: Record<string, unknown>
  warnings: string[]
  trace: string[]
}

export interface AfterHookResult {
  blocked: boolean
  replaceResult?: { success: boolean; content: string }
  warnings: string[]
  trace: string[]
}

/** Result from dispatching UserPromptSubmit. */
export interface PromptSubmitResult {
  blocked: boolean
  blockReason?: string
  replacePrompt?: string
  context?: string
  warnings: string[]
  trace: string[]
}

/** Result from dispatching SessionStart. */
export interface SessionStartResult {
  blocked: boolean
  blockReason?: string
  context: string[]
  warnings: string[]
  trace: string[]
}

// ── Per-event handler type aliases ──

export type SessionStartHandler = HookHandler<SessionStartInput>
export type UserPromptSubmitHandler = HookHandler<UserPromptSubmitInput>
export type PreToolUseHandler = HookHandler<PreToolUseInput>
export type PostToolUseHandler = HookHandler<PostToolUseInput>
export type StopHandler = HookHandler<StopInput>

// ── HookSystem ──

export class HookSystem {
  private handlers = new Map<HookEvent, HookHandler<any>[]>()

  constructor() {
    // Initialize handler arrays for all events
    for (const ev of Object.values(HookEvent)) {
      this.handlers.set(ev as HookEvent, [])
    }
  }

  // ── Registration ──

  /** Register a handler for a lifecycle event. */
  on(event: HookEvent.SessionStart, handler: SessionStartHandler): void
  on(event: HookEvent.UserPromptSubmit, handler: UserPromptSubmitHandler): void
  on(event: HookEvent.PreToolUse, handler: PreToolUseHandler): void
  on(event: HookEvent.PostToolUse, handler: PostToolUseHandler): void
  on(event: HookEvent.Stop, handler: StopHandler): void
  on(event: HookEvent, handler: HookHandler<any>): void {
    this.handlers.get(event)!.push(handler)
  }

  // ── Legacy registration (backward compat) ──

  /** @deprecated Use `on(HookEvent.PreToolUse, handler)` instead. */
  onToolBefore(handler: LegacyHookHandler): void {
    this.handlers.get(HookEvent.PreToolUse)!.push(
      (input: PreToolUseInput) => handler({ tool: input.tool, params: input.params })
    )
  }

  /** @deprecated Use `on(HookEvent.PostToolUse, handler)` instead. */
  onToolAfter(handler: LegacyHookHandler): void {
    this.handlers.get(HookEvent.PostToolUse)!.push(
      (input: PostToolUseInput) => handler({ tool: input.tool, params: input.params, result: input.result, error: input.error })
    )
  }

  // ── Diagnostics ──

  get beforeCount(): number { return this.handlers.get(HookEvent.PreToolUse)!.length }
  get afterCount(): number { return this.handlers.get(HookEvent.PostToolUse)!.length }

  /** Return handler counts for all events. */
  handlerCounts(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const [ev, hs] of this.handlers) {
      counts[ev] = hs.length
    }
    return counts
  }

  // ── Dispatch ──

  /** Dispatch a SessionStart event. Returns accumulated context and any block decision. */
  async dispatchSessionStart(input: SessionStartInput): Promise<SessionStartResult> {
    const warnings: string[] = []
    const trace: string[] = []
    const context: string[] = []

    for (const h of this.handlers.get(HookEvent.SessionStart)!) {
      const out = await h(input)
      const source = out.source ?? "anonymous"
      if (out.blocked) {
        trace.push(`blocked by ${source}`)
        return { blocked: true, blockReason: out.warn ?? `Blocked by ${source}`, context, warnings, trace }
      }
      if (out.context) {
        context.push(out.context)
        trace.push(`context by ${source}`)
      }
      if (out.warn) {
        warnings.push(out.warn)
        trace.push(`warn by ${source}`)
      }
    }

    return { blocked: false, context, warnings, trace }
  }

  /** Dispatch a UserPromptSubmit event. Returns replace/context/block results. */
  async dispatchPromptSubmit(input: UserPromptSubmitInput): Promise<PromptSubmitResult> {
    const warnings: string[] = []
    const trace: string[] = []
    let replacePrompt: string | undefined
    let context: string | undefined

    for (const h of this.handlers.get(HookEvent.UserPromptSubmit)!) {
      const out = await h(input)
      const source = out.source ?? "anonymous"
      if (out.blocked) {
        trace.push(`blocked by ${source}`)
        return { blocked: true, blockReason: out.warn ?? `Blocked by ${source}`, warnings, trace }
      }
      if (out.replacePrompt) {
        replacePrompt = out.replacePrompt
        trace.push(`replace_prompt by ${source}`)
      }
      if (out.context) {
        context = out.context // last context wins (can inject project rules, etc.)
        trace.push(`context by ${source}`)
      }
      if (out.warn) {
        warnings.push(out.warn)
        trace.push(`warn by ${source}`)
      }
    }

    return { blocked: false, replacePrompt, context, warnings, trace }
  }

  // ── Legacy run methods (backward compat — delegate to dispatch) ──

  /** @deprecated Use dispatch methods for PreToolUse instead. */
  async runBefore(tool: string, params: Record<string, unknown>): Promise<BeforeHookResult> {
    const warnings: string[] = []
    const trace: string[] = []
    let replaceParams: Record<string, unknown> | undefined

    for (const h of this.handlers.get(HookEvent.PreToolUse)!) {
      const out = await h({ tool, params } as PreToolUseInput)
      const source = out.source ?? "anonymous"
      if (out.blocked) {
        if (out.warn) warnings.push(out.warn)
        trace.push(`blocked by ${source}`)
        return { blocked: true, warnings, trace }
      }
      if (out.replace) {
        replaceParams = out.replace
        trace.push(`replace by ${source}`)
      }
      if (out.warn) {
        warnings.push(out.warn)
        trace.push(`warn by ${source}`)
      }
    }

    return { blocked: false, replaceParams, warnings, trace }
  }

  /** @deprecated Use dispatch methods for PostToolUse instead. */
  async runAfter(
    tool: string,
    params: Record<string, unknown>,
    result: { success: boolean; content: string },
  ): Promise<AfterHookResult> {
    const warnings: string[] = []
    const trace: string[] = []
    let replaceResult: { success: boolean; content: string } | undefined

    for (const h of this.handlers.get(HookEvent.PostToolUse)!) {
      const out = await h({ tool, params, result } as PostToolUseInput)
      const source = out.source ?? "anonymous"
      if (out.blocked) {
        if (out.warn) warnings.push(out.warn)
        trace.push(`blocked by ${source}`)
        return { blocked: true, warnings, trace }
      }
      if (out.result) {
        replaceResult = out.result
        trace.push(`replace_result by ${source}`)
      }
      if (out.warn) {
        warnings.push(out.warn)
        trace.push(`warn by ${source}`)
      }
    }

    return { blocked: false, replaceResult, warnings, trace }
  }

  /** Fire-and-forget dispatch for Stop event. Errors are silently caught. */
  async dispatchStop(input: StopInput): Promise<void> {
    for (const h of this.handlers.get(HookEvent.Stop)!) {
      try {
        await h(input)
      } catch {
        // Stop handlers must not throw into the exit path
      }
    }
  }
}
