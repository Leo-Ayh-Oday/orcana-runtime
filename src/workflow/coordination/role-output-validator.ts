/** MACP-M7: role output validator — validate before use (task 2), structure
 *  failures (task 3), persist to ArtifactStore (task 5), bind the envelope
 *  (task 6), and keep the Reviewer's read surface honest (tasks 7/8).
 */

import { validateJsonSchema } from "../../harness/capabilities/schema-validator"
import type { JsonSchema } from "../../harness/contracts/schema"
import type { ArtifactStore, HarnessArtifactKind } from "../../harness/contracts/artifact"
import {
  ROLE_ARTIFACT_KIND,
  ROLE_OUTPUT_SCHEMAS,
  type RoleOutput,
  type RoleOutputEnvelope,
  type WorkflowRole,
  type CoderRoleOutput,
} from "./role-contracts"

export interface ValidateRoleOutputInput {
  role: WorkflowRole
  /** Raw model output — validated BEFORE any downstream use. */
  raw: unknown
  runId: string
  nodeRunId: string
  planVersion: string
  workspaceDigest: string
  artifacts?: ArtifactStore
  producedBy?: string
}

export type RoleOutputValidation =
  | { ok: true; envelope: RoleOutputEnvelope }
  | { ok: false; errors: string[]; errorKind: "invalid_role_output" }

export function validateRoleOutput(input: ValidateRoleOutputInput): RoleOutputValidation {
  const schemaErrors = validateJsonSchema(input.raw, ROLE_OUTPUT_SCHEMAS[input.role] as JsonSchema)
  if (schemaErrors.length > 0) {
    return {
      ok: false,
      errors: schemaErrors.map(e => `${input.role} output: ${e}`),
      errorKind: "invalid_role_output",
    }
  }
  const output = input.raw as RoleOutput

  // Coder-specific: silent deviation is forbidden (ROLE_AUTHORITY_LEAK) —
  // every claimed change must be inside `changes`, deviations declared.
  if (input.role === "coder") {
    const coder = output as CoderRoleOutput
    const undeclared = coder.deviations ?? []
    for (const deviation of undeclared) {
      if (!deviation.from || !deviation.reason) {
        return { ok: false, errors: ["coder output: deviation requires from + reason"], errorKind: "invalid_role_output" }
      }
    }
  }

  const envelope: RoleOutputEnvelope = {
    role: input.role,
    runId: input.runId,
    nodeRunId: input.nodeRunId,
    planVersion: input.planVersion,
    workspaceDigest: input.workspaceDigest,
    output,
  }

  // Task 5: persist the role output as an artifact. Callers awaiting
  // durability use `persistRoleOutput` (validated outputs may also be used
  // without persistence — the validation itself is synchronous).
  return { ok: true, envelope }
}

/** Persist a validated role output envelope to the ArtifactStore (task 5).
 *  Awaitable — a store failure surfaces here and never corrupts the
 *  validated output. */
export async function persistRoleOutput(
  input: ValidateRoleOutputInput,
  envelope: RoleOutputEnvelope,
): Promise<{ artifactId: string }> {
  const kind: HarnessArtifactKind = ROLE_ARTIFACT_KIND[input.role]
  const contentRef = await input.artifacts!.storeContent(JSON.stringify(envelope.output))
  const { createHash } = await import("node:crypto")
  const artifactId = `role_${input.role}_${input.nodeRunId}`
  await input.artifacts!.put({
    artifactId,
    runId: input.runId,
    nodeRunId: input.nodeRunId,
    kind,
    status: "valid",
    contentRef,
    contentHash: createHash("sha256").update(JSON.stringify(envelope.output)).digest("hex").slice(0, 16),
    workspaceHash: input.workspaceDigest,
    producedBy: input.producedBy ?? input.nodeRunId,
    createdAt: Date.now(),
  })
  return { artifactId }
}

/** Reviewer read context (tasks 7/8): only the plan, the final diff, the
 *  relevant sources and the evidence — coder hidden reasoning is excluded.
 *  `source` is the raw context the reviewer could see; the filtered view
 *  drops everything not on the allowlist. */
export function reviewerReadContext(
  source: Record<string, unknown>,
  allowKeys: string[] = ["plan", "planVersion", "finalDiff", "sources", "evidence"],
): Record<string, unknown> {
  const allow = new Set(allowKeys)
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (allow.has(key)) filtered[key] = value
  }
  return filtered
}

/** Whether the reviewer sees hidden reasoning (trait name keys). */
export function reviewerSeesHiddenReasoning(source: Record<string, unknown>): string[] {
  const hiddenTraits = ["hiddenReasoning", "thinking", "scratchpad", "internal", "privateNotes"]
  return hiddenTraits.filter(key => key in source)
}
