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
import { evaluateToolPolicy } from "../../agent/tool-execution/policy"
import { executeSingleTool, type ParallelToolResult } from "../../agent/tool-execution/single-executor"
import { appendHookWarnings, runToolAfterHook, runToolBeforeHook } from "../../agent/round/pre-loop"
import { validateJsonSchema } from "../interrupts/response-validator"
import { budgetKindsFor } from "./descriptor"
import { projectCapabilityDescriptor, toolCapabilityHandler } from "./tool-adapter"
import { buildNodePolicyInput, type NodePolicyContext } from "./policy-adapter"

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
  /** When policyDecision is absent, policy is evaluated via this context. */
  policyContext?: NodePolicyContext
  emit?: (type: HarnessEventType, payload: unknown) => void

  // ── shared ──
  artifactTracker?: CapabilityArtifactTracker
  abortSignal?: AbortSignal
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
  const policyDecision = input.policyDecision
    ?? (input.policyContext
      ? evaluateToolPolicy(buildNodePolicyInput(input.policyContext))
      : undefined)
  if (policyDecision && !policyDecision.allowed) {
    releaseReservations()
    input.emit?.("tool.policy.blocked", {
      toolName: descriptor.id,
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
      })
      result = output.result
    } else {
      // Node mode: the registered capability handler.
      input.emit?.("tool.call.started", { toolName: descriptor.id })
      const response = await handler.execute(effectiveParams, {
        abortSignal: input.abortSignal,
        metadata: { capabilityId: descriptor.id },
      })
      if (!response.ok) {
        const message = response.error ?? "capability execution failed"
        result = { success: false, content: message, error: message }
        input.emit?.("tool.call.failed", { toolName: descriptor.id, error: message })
      } else {
        const output = response.output
        const content = typeof output === "string" ? output : JSON.stringify(output)
        result = { success: true, content, metadata: output && typeof output === "object" ? output as Record<string, unknown> : undefined }
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
  const schemaErrors = validateJsonSchema(result, descriptor.outputSchema)
  if (schemaErrors.length > 0) {
    const message = `result failed schema validation: ${schemaErrors.join("; ")}`
    result = { success: false, content: message, error: message }
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
