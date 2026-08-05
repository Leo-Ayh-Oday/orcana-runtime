/** Capability descriptor helpers (H9, plan §15.1).
 *
 *  createCapabilityDescriptor fills H0-contract defaults so registered
 *  capabilities declare only what differs from the conservative baseline.
 *  TOOL_OUTPUT_SCHEMA is the shared placeholder for tool outputs — the tool
 *  system has no per-tool output schema source, so every tool capability
 *  declares the canonical `{ success, content, metadata }` shape and the
 *  Result Schema Validation step is a structural sanity check (plan §15.3).
 */

import type { BudgetRequest } from "../contracts/budget"
import type { CapabilityDescriptor, SideEffect } from "../contracts/capability"
import type { JsonSchema } from "../contracts/schema"

/** Canonical tool result shape shared by every tool capability.
 *
 *  Only success/content are structurally validated: metadata is a free-form
 *  extension field (tool results may carry it or not — the result validator
 *  checks declared properties by key-presence, and ToolResult shims always
 *  include the key).
 */
export const TOOL_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    success: { type: "boolean", description: "Whether the tool call succeeded" },
    content: { type: "string", description: "Human-readable result content" },
  },
  required: ["success", "content"],
}

export interface CapabilityDescriptorPartial {
  id: string
  kind: CapabilityDescriptor["kind"]
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  sideEffect?: SideEffect
  concurrencyGroup?: string
  permissions?: string[]
  riskLevel?: number
  retryable?: boolean
  idempotent?: boolean
  cancellable?: boolean
  producesEvidence?: boolean
  /** RT-2: migration source marker. */
  source?: "legacy" | "native"
  /** RT-4: output budget in bytes (default DEFAULT_MAX_OUTPUT_BYTES). */
  maxOutputBytes?: number
}

/** Build a full descriptor from a partial, applying conservative defaults. */
export function createCapabilityDescriptor(partial: CapabilityDescriptorPartial): CapabilityDescriptor {
  return {
    id: partial.id,
    kind: partial.kind,
    inputSchema: partial.inputSchema,
    outputSchema: partial.outputSchema ?? TOOL_OUTPUT_SCHEMA,
    sideEffect: partial.sideEffect ?? "none",
    concurrencyGroup: partial.concurrencyGroup ?? `capability:${partial.kind}`,
    permissions: partial.permissions ?? [],
    riskLevel: partial.riskLevel ?? 0,
    retryable: partial.retryable ?? false,
    idempotent: partial.idempotent ?? false,
    cancellable: partial.cancellable ?? true,
    producesEvidence: partial.producesEvidence ?? false,
    source: partial.source,
    maxOutputBytes: partial.maxOutputBytes,
  }
}

/**
 * Which budget kinds one execution of this capability consumes.
 * A tool_call unit is always consumed; write/external_action add their own
 * unit so per-class limits (RunBudget.maxWrites / maxExternalActions) apply.
 */
export function budgetKindsFor(descriptor: Pick<CapabilityDescriptor, "sideEffect">): BudgetRequest["kind"][] {
  const kinds: BudgetRequest["kind"][] = ["tool_call"]
  if (descriptor.sideEffect === "write") kinds.push("write")
  else if (descriptor.sideEffect === "external") kinds.push("external_action")
  return kinds
}
