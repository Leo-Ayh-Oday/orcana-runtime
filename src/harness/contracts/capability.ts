/**
 * H0: Capability contract.
 *
 * Tools, models, skills, verifiers and future workers are all described by a
 * CapabilityDescriptor and executed through one registry / executor so the
 * normal loop and the future Node Runtime share a single entry point.
 */

import type { JsonSchema } from "./schema"

export type CapabilityKind =
  | "tool"
  | "model"
  | "skill"
  | "worker"
  | "verifier"
  | "human"
  | "external_service"

export type SideEffect = "none" | "read" | "write" | "external"

export interface CapabilityDescriptor {
  id: string
  kind: CapabilityKind

  inputSchema: JsonSchema
  outputSchema: JsonSchema

  sideEffect: SideEffect
  concurrencyGroup: string

  permissions: string[]
  riskLevel: number

  retryable: boolean
  idempotent: boolean
  cancellable: boolean
  producesEvidence: boolean
}

export interface CapabilityHandler {
  execute(
    input: unknown,
    context: { abortSignal?: AbortSignal; metadata?: Record<string, unknown> },
  ): Promise<{ ok: boolean; output?: unknown; error?: string }>
}

export interface RegisteredCapability {
  descriptor: CapabilityDescriptor
  handler: CapabilityHandler
}

export interface CapabilityFilter {
  kind?: CapabilityKind
  sideEffect?: SideEffect
  concurrencyGroup?: string
}

export interface CapabilityRegistry {
  register(descriptor: CapabilityDescriptor, handler: CapabilityHandler): void
  resolve(id: string): RegisteredCapability
  list(filter?: CapabilityFilter): RegisteredCapability[]
}
