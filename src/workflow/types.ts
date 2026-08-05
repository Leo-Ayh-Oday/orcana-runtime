/** Typed Execution Graph — core types (G0).
 *
 *  G0 projection semantics (plan PR-G0):
 *    - shadow-only: the projector is a pure observer over the existing
 *      trace event stream; it never changes execution behavior;
 *    - node kinds mirror the real runtime surface: rounds (virtual nodes),
 *      tool calls, gate decisions, verifications and plan transitions;
 *    - edges are containment/ordering links (contains/produces), ready for
 *      the G1 scheduler to reinterpret as data dependencies.
 */

export type WorkflowMode = "off" | "shadow"

export type WorkflowNodeKind =
  | "root" // the run itself (virtual)
  | "round" // one agent round (virtual node)
  | "tool" // one tool call
  | "gate" // one gate decision (policy / completion / planning / ripple …)
  | "verification" // one verification result
  | "plan" // master plan / task tracker transition

export type WorkflowNodeStatus =
  | "pending" // declared but not started
  | "active" // in flight (round running, tool executing)
  | "done" // completed successfully
  | "failed" // completed with error (tool error, gate block …)
  | "blocked" // explicitly blocked (gate block, ripple block, aborted)

export interface WorkflowNode {
  /** Stable id across the run: "<kind>:<name>[:<ordinal>]". */
  id: string
  kind: WorkflowNodeKind
  name: string
  status: WorkflowNodeStatus
  startedAt: number
  finishedAt?: number
  durationMs?: number
  /** The agent round this node belongs to (root: -1). */
  round: number
  /** Summary payload — never raw tool input/output (sanitized by design). */
  data?: Record<string, unknown>
}

export type WorkflowEdgeKind = "contains" | "produces" | "gates"

export interface WorkflowEdge {
  from: string
  to: string
  kind: WorkflowEdgeKind
}

export interface WorkflowMetrics {
  rounds: number
  toolCalls: number
  toolFailures: number
  gateDecisions: number
  gateBlocks: number
  verifications: number
  planNodes: number
}

export interface WorkflowSnapshot {
  schemaVersion: "0.1"
  mode: WorkflowMode
  runId: string
  prompt: string
  startedAt: number
  finishedAt?: number
  decision?: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  metrics: WorkflowMetrics
}

/** Trace event shape observed by the projector (subset of RunTraceEvent). */
export interface WorkflowTraceEvent {
  type: string
  data?: Record<string, unknown>
}
