/** Hook system — intercept tool execution with priority-based output semantics.
 *
 *  Inspired by OpenCode's plugin/hook architecture:
 *    - onToolBefore: intercept + optionally block/replace tool calls
 *    - onToolAfter: post-process tool results
 *
 *  Hook output priority: blocked > replace > warn > allow
 *    - blocked: immediate stop, no further handlers run (unless after-block hooks opted in)
 *    - replace: modify tool params (before) or result (after). Last replace wins.
 *    - warn: accumulate warnings from all handlers, appended to tool output.
 *    - allow: explicit pass-through (handler has no opinion).
 *
 *  Every HookOutput carries a `source` for audit trail — who decided what.
 */

export interface HookInput {
  tool?: string
  params?: Record<string, unknown>
  result?: { success: boolean; content: string }
  error?: string
}

export interface HookOutput {
  /** Block execution immediately. Highest priority. */
  blocked?: boolean
  /** Replace tool input params (before-hooks only). Lower priority than blocked. */
  replace?: Record<string, unknown>
  /** Replace tool result (after-hooks only). Lower priority than blocked. */
  result?: { success: boolean; content: string }
  /** Warning to append to tool output. Lowest priority — accumulated across handlers. */
  warn?: string
  /** Identifier for audit trail — which hook produced this decision. */
  source?: string
}

export type HookHandler = (input: HookInput) => HookOutput | Promise<HookOutput>

/** Collected result from running all before-handlers. */
export interface BeforeHookResult {
  blocked: boolean
  /** Replacement params from the last handler that provided them. */
  replaceParams?: Record<string, unknown>
  /** Accumulated warnings from all handlers. */
  warnings: string[]
  /** Sources of blocking/replace decisions for trace. */
  trace: string[]
}

/** Collected result from running all after-handlers. */
export interface AfterHookResult {
  blocked: boolean
  /** Replacement result from the last handler that provided one. */
  replaceResult?: { success: boolean; content: string }
  /** Accumulated warnings from all handlers. */
  warnings: string[]
  /** Sources of blocking/replace decisions for trace. */
  trace: string[]
}

export class HookSystem {
  private toolBeforeHandlers: HookHandler[] = []
  private toolAfterHandlers: HookHandler[] = []

  onToolBefore(handler: HookHandler) { this.toolBeforeHandlers.push(handler) }
  onToolAfter(handler: HookHandler) { this.toolAfterHandlers.push(handler) }

  /** Return number of registered before-handlers (for diagnostics). */
  get beforeCount(): number { return this.toolBeforeHandlers.length }
  /** Return number of registered after-handlers (for diagnostics). */
  get afterCount(): number { return this.toolAfterHandlers.length }

  async runBefore(tool: string, params: Record<string, unknown>): Promise<BeforeHookResult> {
    const warnings: string[] = []
    const trace: string[] = []
    let replaceParams: Record<string, unknown> | undefined

    for (const h of this.toolBeforeHandlers) {
      const out = await h({ tool, params })
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

  async runAfter(
    tool: string,
    params: Record<string, unknown>,
    result: { success: boolean; content: string },
  ): Promise<AfterHookResult> {
    const warnings: string[] = []
    const trace: string[] = []
    let replaceResult: { success: boolean; content: string } | undefined

    for (const h of this.toolAfterHandlers) {
      const out = await h({ tool, params, result })
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
}
