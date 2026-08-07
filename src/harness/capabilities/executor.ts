/** CapabilityExecutor (H9, plan §15.3) — the 8-step execution chain.
 *
 *  Budget Reserve → Permission/Mode/Risk Policy → Before Hook → Handler →
 *  After Hook → Result Schema Validation → Artifact/Evidence → Budget Commit.
 *  This is the single entry the normal loop and the future Node Runtime
 *  share; the two modes differ only in parameters:
 *
 *    - loop mode: batch-executor passes the already-evaluated 8-layer
 *      policyDecision (identity passthrough), hooks, and the tool descriptor;
 *      budget stays with the harness-side BudgetGuard (no double counting).
 *    - node mode: executor evaluates policy via the same evaluateToolPolicy
 *      pure function (policy-adapter), holds its own BudgetLedger, and emits
 *      HarnessEvents for the run event stream.
 */

import { HarnessError } from "../contracts/errors"
import type { BudgetLedger, BudgetUsage } from "../contracts/budget"
import type { CapabilityDescriptor, CapabilityHandler, CapabilityRegistry } from "../contracts/capability"
import type { HarnessEventType } from "../contracts/events"
import type { ToolDescriptor, ToolResult } from "../../tools/registry"
import type { HookSystem } from "../../hooks"
import type { ToolPolicyResult } from "../../agent/tool-execution/policy"
import type { ToolExecutionContext } from "./execution-context"
import { evaluateToolPolicy } from "../../agent/tool-execution/policy"
import { executeSingleTool, type ParallelToolResult } from "../../agent/tool-execution/single-executor"
import { appendHookWarnings, runToolAfterHook, runToolBeforeHook } from "../../agent/round/pre-loop"
import { validateJsonSchema } from "./schema-validator"
import { getCapabilityMode } from "./flags"
import { budgetKindsFor } from "./descriptor"
import { DEFAULT_MAX_OUTPUT_BYTES, limitOutput } from "./output-limiter"
import { projectCapabilityDescriptor, toolCapabilityHandler } from "./tool-adapter"
import { buildNodePolicyInput, type NodePolicyContext } from "./policy-adapter"
import { createDefaultNodePolicyContext } from "../nodes/context"

/** Optional artifact hook (plan §15.3 "Artifact / Evidence" step). */
export interface CapabilityArtifactTracker {
  /** Snapshot state before a write-style execution (diff baseline). */
  beforeExecute(descriptor: CapabilityDescriptor, input: unknown): Promise<unknown>
  /** Record artifacts/evidence after a successful execution. */
  afterExecute(
    descriptor: CapabilityDescriptor,
    input: unknown,
    snapshot: unknown,
    result: ToolResult,
  ): Promise<void>
}

export interface CapabilityExecuteInput {
  capabilityId: string
  params: Record<string, unknown>

  // ── loop mode (batch-executor passthrough) ──
  tool?: ToolDescriptor
  hooks?: HookSystem
  /** Parallel readonly results are reused as-is, skipping Before/After Hooks (L4 semantics). */
  parallelResult?: ParallelToolResult
  /** Loop: the 8-layer policy was already evaluated by batch-executor. */
  policyDecision?: ToolPolicyResult

  // ── node mode (H11 Node Runtime) ──
  /** When set, steps 1/8 reserve/commit budget kinds. Loop leaves it unset (BudgetGuard governs). */
  budget?: BudgetLedger
  /** When policyDecision is absent, policy is ALWAYS evaluated (R1: no silent
   *  skip path) — via this context when provided, else conservative defaults. */
  policyContext?: NodePolicyContext
  /** Caller-side tool call id, carried into policy + emitted events (R1). */
  toolCallId?: string
  emit?: (type: HarnessEventType, payload: unknown) => void

  // ── shared ──
  artifactTracker?: CapabilityArtifactTracker
  abortSignal?: AbortSignal
  /** RT-3: explicit run-scoped execution context (node mode wires it from
   *  the run scope; loop mode keeps the legacy loose parameters). */
  context?: ToolExecutionContext
  /** RC-19 Phase 2 (D7): authoritative project root for this execution.
   *  Threaded into the tool context — relative paths resolve against it,
   *  never process.cwd(). Fail-closed: absent root yields an empty authority
   *  (tools then reject path work rather than guess a cwd). */
  projectRoot?: string
}

export interface CapabilityExecutionResult {
  /** Precise ToolResult shape the loop consumes; node mode synthesizes it from {ok, output}. */
  result: ToolResult
  startedAt: number
}

function zeroBudgetUsage(): BudgetUsage {
  return {
    wallTimeMs: 0, modelCalls: 0, toolCalls: 0,
    inputTokens: 0, outputTokens: 0, cacheMissTokens: 0,
    writes: 0, externalActions: 0, repairCycles: 0,
  }
}

function blockedResult(message: string): ToolResult {
  return { success: false, content: `[blocked] ${message}`, error: message, metadata: { blocked: true } }
}

/** Resolve a capability, with a loop-mode fallback for un-migrated tools.
 *
 *  The registry only holds the first migration batch (§15.4); the loop may
 *  execute any tool. When a tool descriptor is provided (loop mode) and the
 *  id is unknown, the capability is projected from the canonical
 *  ToolContract on the fly so the same 8-step chain covers every tool. Node
 *  mode (no tool) keeps strict registry semantics: unknown ids are rejected.
 */
function resolveCapability(
  registry: CapabilityRegistry,
  input: CapabilityExecuteInput,
): { descriptor: CapabilityDescriptor; handler: CapabilityHandler } {
  try {
    return registry.resolve(input.capabilityId)
  } catch (error) {
    if (input.tool && error instanceof HarnessError && error.kind === "capability_not_found") {
      return {
        descriptor: projectCapabilityDescriptor(input.tool),
        handler: toolCapabilityHandler(input.tool),
      }
    }
    throw error
  }
}

/** Run the 8-step chain for one capability invocation. */
export async function executeCapability(
  registry: CapabilityRegistry,
  input: CapabilityExecuteInput,
): Promise<CapabilityExecutionResult> {
  const { descriptor, handler } = resolveCapability(registry, input)
  const startedAt = Date.now()
  const reservations: string[] = []

  const releaseReservations = () => {
    if (!input.budget) return
    for (const id of reservations) input.budget.release(id)
    reservations.length = 0
  }

  // Step 1: Budget Reserve
  if (input.budget) {
    for (const kind of budgetKindsFor(descriptor)) {
      try {
        reservations.push(input.budget.reserve({ kind }).id)
      } catch (error) {
        releaseReservations()
        const message = error instanceof Error ? error.message : String(error)
        return { result: blockedResult(message), startedAt }
      }
    }
  }

  // Step 2: Permission / Mode / Risk Policy
  // R1 (Harness Closure): policy is MANDATORY — there is no path that skips
  // evaluation. Loop mode passes the already-evaluated policyDecision
  // (identity passthrough); node mode evaluates unconditionally, falling back
  // to the conservative default context (strict gate, no rules) when the
  // caller did not supply one. "No policy context" is a policy context.
  const policyDecision = input.policyDecision
    ?? evaluateToolPolicy(buildNodePolicyInput(
      input.policyContext ?? createDefaultNodePolicyContext(input.params, input.tool, input.toolCallId, input.capabilityId),
    ))
  if (!policyDecision.allowed) {
    releaseReservations()
    input.emit?.("tool.policy.blocked", {
      toolName: descriptor.id,
      toolCallId: input.toolCallId,
      reason: policyDecision.reason,
      source: policyDecision.source,
      priority: policyDecision.priority,
    })
    return { result: blockedResult(policyDecision.blockMessage), startedAt }
  }

  // Step 3: Before Hook (blocked short-circuits without an After Hook, L4
  // semantics). A parallel readonly result was already executed this round —
  // L4 runs no hooks for it, so neither do we.
  const before = input.parallelResult
    ? { warnings: [] as string[] }
    : await runToolBeforeHook(input.hooks, descriptor.id, input.params)
  if (before.blocked) {
    releaseReservations()
    return { result: appendHookWarnings(before.blocked, before.warnings), startedAt }
  }
  const effectiveParams = before.replaceParams ?? input.params

  let snapshot: unknown
  if (input.artifactTracker && descriptor.sideEffect === "write") {
    snapshot = await input.artifactTracker.beforeExecute(descriptor, input.params)
  }

  // Step 4: Handler
  let result: ToolResult
  try {
    if (input.tool) {
      // Loop mode: canonical L4 path. Hooks are owned by steps 3/5 — passing
      // none here prevents double execution (incl. streaming tools).
      const output = await executeSingleTool({
        tool: input.tool,
        params: effectiveParams,
        abortSignal: input.abortSignal,
        parallelResult: input.parallelResult,
        // RC-19 Phase 2 (D7): projectRoot from the batch/run scope; node-mode
        // callers may carry it on the execution context. Absent → empty
        // (fail-closed — never process.cwd()).
        projectRoot: input.projectRoot ?? input.context?.projectRoot ?? "",
      })
      result = output.result
    } else {
      // Node mode: the registered capability handler.
      input.emit?.("tool.call.started", { toolName: descriptor.id, toolCallId: input.toolCallId })
      const response = await handler.execute(effectiveParams, {
        abortSignal: input.abortSignal ?? input.context?.signal,
        metadata: { capabilityId: descriptor.id, ...(input.context ? { runContext: input.context } : {}) },
      })
      if (!response.ok) {
        const message = response.error ?? "capability execution failed"
        result = { success: false, content: message, error: message }
        input.emit?.("tool.call.failed", { toolName: descriptor.id, toolCallId: input.toolCallId, error: message })
      } else {
        const output = response.output
        const content = typeof output === "string" ? output : JSON.stringify(output)
        // Tool-shaped outputs carry { success, content, metadata } — the
        // metadata field is what downstream consumers (artifact tracker,
        // completion gates) read; anything else is a custom output value.
        const shaped = output !== null && typeof output === "object" && !Array.isArray(output)
          ? output as Record<string, unknown>
          : undefined
        result = {
          success: true,
          content,
          metadata: shaped && typeof shaped.metadata === "object" && shaped.metadata !== null
            ? shaped.metadata as Record<string, unknown>
            : undefined,
        }
        // RT-13 (TL-018): successful handler runs must close the trace pair —
        // the started event was emitted before the handler executed.
        input.emit?.("tool.call.completed", {
          toolName: descriptor.id,
          toolCallId: input.toolCallId,
          ok: true,
        })
      }
    }
  } catch (error) {
    releaseReservations()
    const message = error instanceof Error ? error.message : String(error)
    return { result: { success: false, content: message, error: message }, startedAt }
  }

  // Step 5: After Hook (replaceParams from step 3 carries through, L4 semantics)
  if (!input.parallelResult) {
    const after = await runToolAfterHook(input.hooks, descriptor.id, effectiveParams, result)
    result = appendHookWarnings(after.result, [...before.warnings, ...after.warnings])
  }

  // Step 6: Result Schema Validation
  // RT-2: shadow mode observes the new contract in the dark — a divergence
  // from the old (schema-less) path is recorded on the event stream
  // (capability.shadow_mismatch) and the result is left as produced, so the
  // shadow never disturbs the user's task. legacy (default) and enabled both
  // make the validation authoritative: failures block (existing behavior).
  const schemaErrors = validateJsonSchema(result, descriptor.outputSchema)
  if (schemaErrors.length > 0) {
    if (getCapabilityMode() === "shadow") {
      input.emit?.("capability.shadow_mismatch", {
        capabilityId: descriptor.id,
        check: "output_schema",
        errors: schemaErrors,
      })
    } else {
      const message = `result failed schema validation: ${schemaErrors.join("; ")}`
      result = { success: false, content: message, error: message }
    }
  }

  // RT-4: output limiting — oversized results go to the artifact store; the
  // caller receives a preview + artifact ref (never raw megabytes).
  const outputStore = input.context?.artifactStore
  if (result.success && outputStore && input.context && typeof result.content === "string" && result.content.length > (descriptor.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)) {
    const limited = await limitOutput({
      content: result.content,
      maxBytes: descriptor.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      runId: input.context.runId,
      nodeRunId: input.context.nodeRunId,
      producedBy: descriptor.id,
      store: outputStore,
    })
    if (limited.artifactId) {
      result = {
        ...result,
        content: `${limited.preview}\n\n… [output truncated: full content in artifact ${limited.artifactId}]`,
      }
    }
  }

  // Step 7: Artifact / Evidence
  if (input.artifactTracker && result.success) {
    await input.artifactTracker.afterExecute(descriptor, input.params, snapshot, result)
  }

  // Step 8: Budget Commit (failure paths already released above)
  if (input.budget) {
    for (const id of reservations) input.budget.commit(id, zeroBudgetUsage())
    reservations.length = 0
  }

  return { result, startedAt }
}
