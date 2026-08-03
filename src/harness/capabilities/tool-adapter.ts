/** Tool → Capability adapter (H9, plan §15.4 + §23 risk control).
 *
 *  Deliberately reuses the existing ToolDescriptor/ToolContract instead of
 *  introducing a second tool system: descriptors are a pure projection of
 *  the canonical contract, and handlers delegate to executeSingleTool (the
 *  L4 canonical path). Only the first migration batch (plan §15.4) is
 *  registered; the rest are classified on the fly for event bridging.
 */

import type { CapabilityDescriptor, CapabilityHandler, CapabilityRegistry, SideEffect } from "../contracts/capability"
import type { JsonSchema } from "../contracts/schema"
import type { ToolDescriptor } from "../../tools/registry"
import { projectToolContract, type ToolContract } from "../../tools/tool-contract"
import { inferToolCategory } from "../../agent/permission"
import { executeSingleTool } from "../../agent/tool-execution/single-executor"
import { createCapabilityDescriptor, TOOL_OUTPUT_SCHEMA } from "./descriptor"

/** First migration batch (plan §15.4). */
export const FIRST_BATCH_TOOL_NAMES = [
  "read_file",
  "find_symbol",
  "find_references",
  "write_file",
  "edit_file",
  "shell",
  "typecheck",
] as const

/** Reduce ToolContract side effects to the capability SideEffect vocabulary.
 *
 *  External actions take priority over workspace writes: a shell command is
 *  an external action first (its write capability is incidental), which keeps
 *  the budget classification aligned with the H4 kind design
 *  (external_action = shell/network, write = file-write tools).
 */
export function sideEffectFromContract(contract: ToolContract): SideEffect {
  for (const effect of contract.sideEffects) {
    if (effect === "shell" || effect === "external_process" || effect === "network") return "external"
  }
  for (const effect of contract.sideEffects) {
    if (effect === "workspace_write") return "write"
  }
  return "none"
}

/** Fallback classification for tools without a contract (or before registration). */
export function classifyToolSideEffect(name: string, tools: ToolDescriptor[]): SideEffect {
  const tool = tools.find((t) => t.defn.name === name)
  if (tool?.contract) return sideEffectFromContract(tool.contract)
  const category = tool?.defn.category ?? inferToolCategory(name, tool)
  if (category === "file") return "write"
  if (category === "shell" || category === "network") return "external"
  return "none"
}

/** Project one tool into a CapabilityDescriptor (pure function of the contract). */
export function projectCapabilityDescriptor(tool: ToolDescriptor): CapabilityDescriptor {
  const contract = tool.contract ?? projectToolContract(tool.defn)
  const baseLevel = contract.risk.baseLevel
  return createCapabilityDescriptor({
    id: contract.name,
    kind: "tool",
    inputSchema: contract.declaredArgsSchema as unknown as JsonSchema,
    outputSchema: TOOL_OUTPUT_SCHEMA,
    sideEffect: sideEffectFromContract(contract),
    concurrencyGroup: contract.concurrencySafe ? `tool:${contract.category}` : `tool:${contract.name}`,
    permissions: [`category:${contract.category}`, `permission:${contract.permission}`],
    riskLevel: baseLevel,
    retryable: baseLevel <= 2 && !contract.execution.streaming,
    idempotent: contract.access === "readonly",
    cancellable: !contract.execution.cooperativeCancellation,
    producesEvidence: contract.state.updates.includes("evidence"),
  })
}

/** Wrap one tool's canonical execution as a CapabilityHandler.
 *
 *  Hooks are intentionally NOT passed here: the CapabilityExecutor owns the
 *  Before/After Hook steps (§15.3), and executeSingleTool would otherwise run
 *  them a second time. Timeout/abort/streaming close stay inside
 *  executeSingleTool unchanged (L4 behavior frozen).
 */
export function toolCapabilityHandler(tool: ToolDescriptor): CapabilityHandler {
  return {
    async execute(input, context) {
      try {
        const { result, startedAt } = await executeSingleTool({
          tool,
          params: (input ?? {}) as Record<string, unknown>,
          abortSignal: context?.abortSignal,
        })
        return { ok: result.success, output: { ...result, startedAt } }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, error: message }
      }
    },
  }
}

/** Register the first migration batch (by name) into a registry. */
export function registerToolCapabilities(registry: CapabilityRegistry, tools: ToolDescriptor[]): void {
  const wanted = new Set<string>(FIRST_BATCH_TOOL_NAMES)
  for (const tool of tools) {
    if (!wanted.has(tool.defn.name)) continue
    registry.register(projectCapabilityDescriptor(tool), toolCapabilityHandler(tool))
  }
}
