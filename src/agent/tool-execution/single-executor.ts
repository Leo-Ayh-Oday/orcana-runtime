/**
 * L4: single tool execution — the canonical execution path for one tool call.
 * before-hook → handler (streaming or plain) → after-hook → timeout/abort.
 * Extracted from loop.ts so both the batch executor and any future Harness
 * CapabilityExecutor share one entry point.
 */

import type { ToolDescriptor, ToolExecutionContext, ToolResult } from "../../tools/registry"
import type { HookSystem } from "../../hooks"
import {
  appendHookWarnings,
  executeToolWithHooks,
  runToolAfterHook,
  runToolBeforeHook,
  withToolTimeout,
} from "../round/pre-loop"

/** Build a ToolResult from loose (success, content) facts, satisfying the union's error field. */
function toToolResult(success: boolean, content: string, metadata?: Record<string, unknown>): ToolResult {
  if (success) return { success: true, content, metadata }
  return { success: false, content, error: content, metadata }
}

export interface ParallelToolResult {
  content: string
  success: boolean
  metadata?: Record<string, unknown>
  startedAt: number
}

export interface SingleToolInput {
  tool: ToolDescriptor
  params: Record<string, unknown>
  hooks?: HookSystem
  abortSignal?: AbortSignal
  /** When a parallel readonly execution already produced a result, reuse it. */
  parallelResult?: ParallelToolResult
  /** RC-19 Phase 2 (D7): authoritative project root threaded into the tool
   *  execution context — relative tool paths never resolve against cwd. */
  projectRoot?: string
  readableRoots?: string[]
  writableRoots?: string[]
}

export interface SingleToolOutput {
  result: ToolResult
  startedAt: number
}

/**
 * Execute one tool through the canonical path.
 *
 * - A parallel readonly result is returned as-is (already ran this round).
 * - Streaming tools drain their iterator, closing it in a `finally` so a
 *   mid-stream abort / timeout never leaks the generator.
 * - Handler errors (timeout, abort, tool throw) propagate to the caller so the
 *   batch executor can record a failed ledger entry and surface the message.
 */
export async function executeSingleTool(input: SingleToolInput): Promise<SingleToolOutput> {
  const { tool, params, hooks, abortSignal, parallelResult } = input
  const startedAt = Date.now()
  // RC-19 Phase 2 (D7): tools receive the project-root authority —
  // resolveToolPath() binds relative paths to projectRoot, never cwd.
  const toolContext: ToolExecutionContext = {
    abortSignal,
    // Fail-closed: absent authority → "" (tools reject path work rather than
    // guess a cwd). RC-19 Phase 2 (D7).
    projectRoot: input.projectRoot ?? "",
    ...(input.readableRoots ? { readableRoots: input.readableRoots } : {}),
    ...(input.writableRoots ? { writableRoots: input.writableRoots } : {}),
  }

  if (parallelResult) {
    return {
      result: toToolResult(parallelResult.success, parallelResult.content, parallelResult.metadata),
      startedAt: parallelResult.startedAt,
    }
  }

  if (tool.executeStream) {
    const before = await runToolBeforeHook(hooks, tool.defn.name, params)
    if (before.blocked) {
      return { result: appendHookWarnings(before.blocked, before.warnings), startedAt }
    }
    const effectiveParams = before.replaceParams ?? params
    const toolIterator = tool.executeStream(effectiveParams, toolContext)[Symbol.asyncIterator]()
    try {
      let finalResult: ToolResult = toToolResult(false, "")
      while (true) {
        const next = await withToolTimeout(tool.defn.name, toolIterator.next(), undefined, abortSignal)
        if (next.done) break
        const ev = next.value
        if (ev.type === "progress") {
          // Raw shell stdout/stderr is often noisy progress output.
          // Keep it out of the spinner/status line; the final result
          // still carries command output for diagnostics.
          continue
        } else if (ev.type === "done") {
          const rawResult = ev.data
          const after = await runToolAfterHook(hooks, tool.defn.name, effectiveParams, rawResult)
          finalResult = appendHookWarnings(after.result, [...before.warnings, ...after.warnings])
        }
      }
      return { result: finalResult, startedAt }
    } finally {
      try {
        const closing = toolIterator.return?.(undefined)
        if (closing) void closing.catch(() => {})
      } catch {
        // best-effort close for legacy streaming tools
      }
    }
  }

  const result = await executeToolWithHooks({
    hooks,
    tool,
    params,
    execute: (effectiveParams) => withToolTimeout(
      tool.defn.name,
      tool.execute(effectiveParams, toolContext),
      undefined,
      abortSignal,
    ),
  })
  return { result, startedAt }
}
