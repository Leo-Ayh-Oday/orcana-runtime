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

// ── G1: executable DAG (read-only scheduler) ──

/** One executable node in a read-only WorkflowSpec. */
export interface WorkflowNodeSpec {
  /** Stable id within the spec: "tool:read_file:1" / "reduce:dedupe:1". */
  id: string
  /** Handler id registered in the handler registry ("tool.read_file"). */
  handler: string
  /** Static inputs for this node. */
  input: Record<string, unknown>
  /** Node ids this node depends on (their results feed the edge store). */
  dependsOn: string[]
}

/** An executable, validated read-only DAG. */
export interface WorkflowSpec {
  schemaVersion: "0.1"
  specId: string
  nodes: WorkflowNodeSpec[]
  /** Optional budget caps. */
  maxParallel?: number
  /** G3: "readonly" (default) rejects write handlers; "read-write" allows
   *  the whitelisted write handlers under single-writer semantics. */
  mode?: "readonly" | "read-write"
}

export type WorkflowNodeResultStatus = "done" | "failed"

/** Result of a single node execution (edge payload + terminal state). */
export interface WorkflowNodeResult {
  nodeId: string
  status: WorkflowNodeResultStatus
  /** Handler output (JSON-serializable); error message on failure. */
  output: unknown
  error?: string
  startedAt: number
  finishedAt: number
  durationMs: number
}

export type WorkflowRunResultStatus = "done" | "blocked_no_evidence" | "write_rejected"

export interface WorkflowRunResult {
  specId: string
  finishedAt: number
  status: WorkflowRunResultStatus
  results: WorkflowNodeResult[]
  /** G3: verification evidence bound to write nodes (aggregate-evidence). */
  evidence?: Array<{ nodeId: string; writeNodeIds: string[]; passed: boolean; summary?: string }>
}
