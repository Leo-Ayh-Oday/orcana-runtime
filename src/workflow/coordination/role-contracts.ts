/** MACP-M7: role output contracts — Planner / Coder / Reviewer.
 *
 *  Every model output is validated against its role schema BEFORE use
 *  (task 2); invalid outputs become structured failures (task 3). Valid
 *  outputs are wrapped in a RoleOutputEnvelope bound to runId, nodeRunId,
 *  planVersion and workspaceDigest (task 6) and written to the ArtifactStore
 *  (task 5).
 */

export type WorkflowRole = "planner" | "coder" | "reviewer"

export interface PlannerRoleOutput {
  planText: string
  /** Proposed task assignments (agent → tasks). */
  taskAssignments: Array<{ agentId: string; taskIds: string[] }>
  /** Proposed task dependencies. */
  dependencies: Array<{ from: string; to: string }>
  /** Proposed approvals (task ids the planner proposes for auto-approval). */
  approvals: string[]
}

export interface CoderRoleOutput {
  /** Declared changes — files the coder claims to have modified. */
  changes: Array<{ file: string; summary: string }>
  /** Declared deviations from the plan — NEVER silent (task: no silent
   *  deviation; undeclared files outside `changes` are a violation). */
  deviations?: Array<{ from: string; reason: string }>
  /** Evidence ids supporting completion. */
  evidenceIds: string[]
}

export type ReviewerVerdict = "approved" | "rejected" | "needs_repair"

export interface ReviewerRoleOutput {
  verdict: ReviewerVerdict
  comments: string[]
  evidenceIds?: string[]
}

export type RoleOutput = PlannerRoleOutput | CoderRoleOutput | ReviewerRoleOutput

/** Output envelope bound to the run identity (task 6). */
export interface RoleOutputEnvelope<T extends RoleOutput = RoleOutput> {
  role: WorkflowRole
  runId: string
  nodeRunId: string
  planVersion: string
  workspaceDigest: string
  output: T
  /** ArtifactStore id when persisted (task 5). */
  artifactId?: string
}

/** Per-role ArtifactStore kinds (task 5). */
export const ROLE_ARTIFACT_KIND: Record<WorkflowRole, import("../../harness/contracts/artifact").HarnessArtifactKind> = {
  planner: "plan",
  coder: "delivery_report",
  reviewer: "ripple_report",
}

/** JSON Schemas per role (task 1) — shared validator keyword subset. */
export const ROLE_OUTPUT_SCHEMAS: Record<WorkflowRole, import("../../harness/contracts/schema").JsonSchema> = {
  planner: {
    type: "object",
    properties: {
      planText: { type: "string" },
      taskAssignments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            agentId: { type: "string" },
            taskIds: { type: "array", items: { type: "string" } },
          },
          required: ["agentId", "taskIds"],
        },
      },
      dependencies: {
        type: "array",
        items: {
          type: "object",
          properties: { from: { type: "string" }, to: { type: "string" } },
          required: ["from", "to"],
        },
      },
      approvals: { type: "array", items: { type: "string" } },
    },
    required: ["planText", "taskAssignments", "dependencies", "approvals"],
  },
  coder: {
    type: "object",
    properties: {
      changes: {
        type: "array",
        items: {
          type: "object",
          properties: { file: { type: "string" }, summary: { type: "string" } },
          required: ["file", "summary"],
        },
      },
      deviations: {
        type: "array",
        items: {
          type: "object",
          properties: { from: { type: "string" }, reason: { type: "string" } },
          required: ["from", "reason"],
        },
      },
      evidenceIds: { type: "array", items: { type: "string" } },
    },
    required: ["changes", "evidenceIds"],
  },
  reviewer: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["approved", "rejected", "needs_repair"] },
      comments: { type: "array", items: { type: "string" } },
      evidenceIds: { type: "array", items: { type: "string" } },
    },
    required: ["verdict", "comments"],
  },
}
