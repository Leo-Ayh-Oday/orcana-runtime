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
/** MACP-M1: conditional dependency — a node only unblocks when its
 *  dependency's result satisfies `when`. schemaVersion "0.1" specs treat
 *  every dependency as `terminal` (existing behavior). */
export type WorkflowDependencyWhen = "terminal" | "succeeded" | "failed" | "accepted" | "rejected" | "blocked"

export interface WorkflowDependency {
  nodeId: string
  when: WorkflowDependencyWhen
}

export interface WorkflowNodeSpec {
  /** Stable id within the spec: "tool:read_file:1" / "reduce:dedupe:1". */
  id: string
  /** Handler id registered in the handler registry ("tool.read_file"). */
  handler: string
  /** Static inputs for this node. */
  input: Record<string, unknown>
  /** Node ids this node depends on (their results feed the edge store).
   *  M1: schemaVersion "0.2" specs may use conditional dependencies;
   *  "0.1" specs keep plain strings (interpreted as `terminal`). */
  dependsOn: Array<string | WorkflowDependency>
  /** MACP-M2: optional H11 execution declaration. When present the node
   *  executes through the Unified Node Runtime (LlmAgentNode / ToolNode /
   *  VerificationNode / HumanNode) instead of the handler registry.
   *  Absent (or `function`) = legacy handler/reducer path — the only
   *  permitted deterministic reducers. */
  execution?: WorkflowNodeExecution
  /** MACP-M3: explicit participant assignment (agentId). Absent → the
   *  node id prefix ("a1:w:patch" → agent "a1") selects the agent when a
   *  pool is present; without a pool, writes behave exactly as before. */
  assignment?: string
}

/** MACP-M2: which HarnessNode executes this node. Inputs are declared
 *  statically here (or, for verification, via `node.input` which carries
 *  the upstream-produced results). The harness environment (budget, scope,
 *  capabilities, artifacts, trace) is supplied by SchedulerOptions.harness —
 *  the workflow never constructs its own budget or model path (single source
 *  of truth, plan §23). */
export type WorkflowNodeExecution =
  | { kind: "function" }
  | { kind: "tool"; capabilityId: string; params?: Record<string, unknown> }
  | {
      kind: "llm_agent"
      prompt: string
      maxRounds?: number
      tools?: Array<{ name: string; description?: string }>
      /** LEGACY_* keys pass through to AgentOptions (H1 transition). */
      metadata?: Record<string, unknown>
    }
  /** `node.input` must carry `results` (VerificationResult[]); the node
   *  ingests them as bound artifacts + evidence (H8 adapter). */
  | { kind: "verification"; modifiedFiles?: string[]; workspaceHash?: string }
  | { kind: "human"; prompt: string; responseSchema?: import("../harness/contracts/schema").JsonSchema }

/** An executable, validated read-only DAG. */
export interface WorkflowSpec {
  /** "0.1" = terminal dependencies (legacy). "0.2" = conditional
   *  dependencies (MACP-M1). */
  schemaVersion: "0.1" | "0.2"
  specId: string
  nodes: WorkflowNodeSpec[]
  /** Optional budget caps. */
  maxParallel?: number
  /** G3: "readonly" (default) rejects write handlers; "read-write" allows
   *  the whitelisted write handlers under single-writer semantics. */
  mode?: "readonly" | "read-write"
}

export type WorkflowNodeResultStatus = "done" | "failed" | "blocked"

/** MACP-M1: execution vs acceptance separation. A node may execute
 *  successfully while its output is not accepted (planner plan rejected,
 *  coder evidence insufficient, reviewer hard veto). */
export type WorkflowAcceptanceStatus =
  | "not_required"
  | "accepted"
  | "rejected"
  | "needs_repair"
  | "needs_replan"
  | "needs_human"

/** Result of a single node execution (edge payload + terminal state). */
export interface WorkflowNodeResult {
  nodeId: string
  status: WorkflowNodeResultStatus
  /** Handler output (JSON-serializable); error message on failure. */
  output: unknown
  error?: string
  /** MACP-M2: structured error kind from the harness node (budget/kind/etc). */
  errorKind?: string
  /** M1: acceptance of the produced output (separate from execution). */
  acceptance?: WorkflowAcceptanceStatus
  startedAt: number
  finishedAt: number
  durationMs: number
  /** MACP-M2: preserved from the H11 NodeResult when executed via the
   *  Unified Node Runtime. */
  usage?: import("../harness/contracts/nodes").NodeUsage
  diagnostics?: import("../harness/contracts/nodes").NodeDiagnostic[]
  evidence?: import("../agent/evidence-ledger").EvidenceEntry[]
}

/** M6: "failed"/"blocked" aggregate any node-level failure/block — a run
 *  with a failed or blocked node never reports done (FAILED_WORKFLOW_NODE_NEVER_DONE). */
export type WorkflowRunResultStatus =
  | "done"
  | "failed"
  | "blocked"
  | "blocked_no_evidence"
  | "write_rejected"
  | "waiting_interrupt"
  | "blocked_conflict"

/** MACP-M4: a run paused at a human node — persisted, resumable. */
export interface WorkflowWaitingInterrupt {
  interruptId: string
  resumeToken: string
  nodeId: string
  kind: string
  prompt: string
  expiresAt?: number
}

export interface WorkflowRunResult {
  specId: string
  finishedAt: number
  status: WorkflowRunResultStatus
  results: WorkflowNodeResult[]
  /** G3: verification evidence bound to write nodes (aggregate-evidence). */
  evidence?: Array<{ nodeId: string; writeNodeIds: string[]; passed: boolean; summary?: string }>
  /** MACP-M4: set when status === "waiting_interrupt". */
  interrupt?: WorkflowWaitingInterrupt
}
