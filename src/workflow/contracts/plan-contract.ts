/** MACP-M6: typed plan contract — the Planner's machine-checkable output.
 *
 *  Tasks carry scope + criterion references; criteria are defined once with
 *  stable IDs. The contract version is bound to the criterion IDs (task 11);
 *  ANY plan modification MUST bump the version (task 12) — the validator
 *  enforces presence, and consumers reject stale versions.
 */

import type { CompletionCriterion } from "./criteria"

export const TYPED_PLAN_SCHEMA_VERSION = "0.3" as const

export interface TypedPlanTask {
  taskId: string
  title: string
  /** Concrete deliverables — file paths or action descriptions. */
  scope: string[]
  /** Criterion ids this task must satisfy (bound to the contract version). */
  criterionIds: string[]
  /** Whether the task writes the workspace (task 6: writes REQUIRE at
   *  least one verification criterion). */
  writes: boolean
  /** Resource hint for the scheduler. */
  maxNodes?: number
}

export interface TypedPlanContract {
  schemaVersion: typeof TYPED_PLAN_SCHEMA_VERSION
  /** Plan version — must change on ANY modification (task 12). */
  version: string
  /** Completion criteria, unique IDs (task 2). */
  criteria: CompletionCriterion[]
  tasks: TypedPlanTask[]
  /** Contract hash for plan ↔ criterion binding (task 11). */
  planDigest?: string
}

/** JSON Schema for planner output (task 5). Uses only the shared
 *  validator's keyword subset (type/enum/required/properties/items);
 *  structural details beyond that are enforced by the semantic rules in
 *  plan-contract-validator (mode↔check consistency, duplicate ids, …). */
export const TYPED_PLAN_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { type: "string", enum: ["0.3"] },
    version: { type: "string" },
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          hard: { type: "boolean" },
          mode: { type: "string", enum: ["deterministic", "semantic"] },
          check: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["command", "file_exists", "file_content", "evidence", "semantic_review"] },
              command: { type: "string" },
              verificationKind: { type: "string" },
              path: { type: "string" },
              contains: { type: "string" },
              evidenceKind: { type: "string" },
              reviewer: { type: "string" },
              guidance: { type: "string" },
            },
          },
          description: { type: "string" },
        },
        required: ["id", "title", "hard", "mode"],
      },
    },
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          title: { type: "string" },
          scope: { type: "array", items: { type: "string" } },
          criterionIds: { type: "array", items: { type: "string" } },
          writes: { type: "boolean" },
          maxNodes: { type: "number" },
        },
        required: ["taskId", "title", "scope", "criterionIds", "writes"],
      },
    },
    planDigest: { type: "string" },
  },
  required: ["schemaVersion", "version", "criteria", "tasks"],
} as const

export const TYPED_PLAN_CONTRACT = { schemaVersion: TYPED_PLAN_SCHEMA_VERSION } as const
