export const AUTHORITY_DOMAINS = [
  "policy_ceiling",
  "task_definition",
  "task_completion",
  "world_state",
  "execution_facts",
  "evidence_sufficiency",
] as const

export type AuthorityDomain = (typeof AUTHORITY_DOMAINS)[number]

export const AUTHORITY_NODES = [
  "user_policy",
  "graph",
  "agent_kernel",
  "agent_world",
  "execution_fabric",
  "evidence_kernel",
  "driver",
  "tool_adapter",
  "llm_tool",
  "host_secret",
] as const

export type AuthorityNode = (typeof AUTHORITY_NODES)[number]

export const AUTHORITY_OPERATIONS = [
  "bound_authority",
  "command_task",
  "request_capability",
  "submit_execution",
  "commit_world",
  "report_execution",
  "report_driver_result",
  "emit_receipt",
  "bind_completion_evidence",
  "complete_graph",
  "mutate_world",
  "hold_host_secret",
] as const

export type AuthorityOperation = (typeof AUTHORITY_OPERATIONS)[number]

export interface AuthorityAssignment {
  readonly domain: AuthorityDomain
  readonly owner: AuthorityNode
}

export interface AuthorityEdge {
  readonly source: AuthorityNode
  readonly target: AuthorityNode
  readonly operation: AuthorityOperation
}

export interface ForbiddenAuthorityRelation {
  readonly id:
    | "EXECUTION_FABRIC_COMPLETES_GRAPH"
    | "DRIVER_DIRECT_WORLD_MUTATION"
    | "LLM_TOOL_HOLDS_HOST_SECRET"
  readonly source: AuthorityNode
  readonly target: AuthorityNode
  readonly operations: readonly AuthorityOperation[]
}

export const AUTHORITY_ASSIGNMENTS = [
  { domain: "policy_ceiling", owner: "user_policy" },
  { domain: "task_definition", owner: "graph" },
  { domain: "task_completion", owner: "graph" },
  { domain: "world_state", owner: "agent_world" },
  { domain: "execution_facts", owner: "execution_fabric" },
  { domain: "evidence_sufficiency", owner: "evidence_kernel" },
] as const satisfies readonly AuthorityAssignment[]

export const AUTHORITY_EDGES = [
  { source: "user_policy", target: "agent_kernel", operation: "bound_authority" },
  { source: "graph", target: "agent_kernel", operation: "command_task" },
  { source: "llm_tool", target: "tool_adapter", operation: "request_capability" },
  { source: "tool_adapter", target: "agent_kernel", operation: "request_capability" },
  { source: "agent_kernel", target: "execution_fabric", operation: "submit_execution" },
  { source: "agent_kernel", target: "agent_world", operation: "commit_world" },
  { source: "execution_fabric", target: "agent_kernel", operation: "report_execution" },
  { source: "driver", target: "agent_kernel", operation: "report_driver_result" },
  { source: "agent_world", target: "evidence_kernel", operation: "emit_receipt" },
  { source: "execution_fabric", target: "evidence_kernel", operation: "emit_receipt" },
  { source: "evidence_kernel", target: "graph", operation: "bind_completion_evidence" },
] as const satisfies readonly AuthorityEdge[]

export const FORBIDDEN_AUTHORITY_RELATIONS = [
  {
    id: "EXECUTION_FABRIC_COMPLETES_GRAPH",
    source: "execution_fabric",
    target: "graph",
    operations: ["complete_graph"],
  },
  {
    id: "DRIVER_DIRECT_WORLD_MUTATION",
    source: "driver",
    target: "agent_world",
    operations: ["commit_world", "mutate_world"],
  },
  {
    id: "LLM_TOOL_HOLDS_HOST_SECRET",
    source: "llm_tool",
    target: "host_secret",
    operations: ["hold_host_secret"],
  },
] as const satisfies readonly ForbiddenAuthorityRelation[]

export const AK0_GATE_NAMES = [
  "SECOND_TASK_AUTHORITY",
  "SECOND_WORLD_AUTHORITY",
  "TOOL_AS_AUTHORITY",
  "EXECUTION_COMPLETES_GRAPH_DIRECT",
] as const

export type Ak0GateName = (typeof AK0_GATE_NAMES)[number]

export interface AuthorityConformanceReport {
  readonly gates: Readonly<Record<Ak0GateName, number>>
  readonly forbiddenRelations: readonly ForbiddenAuthorityRelation["id"][]
}

const AUTHORITY_OPERATIONS_RESERVED_FOR_KERNEL = new Set<AuthorityOperation>([
  "bound_authority",
  "command_task",
  "submit_execution",
  "commit_world",
  "complete_graph",
  "hold_host_secret",
])

function countUnexpectedAuthorityOwners(
  assignments: readonly AuthorityAssignment[],
  domain: AuthorityDomain,
  expectedOwner: AuthorityNode,
): number {
  const owners = assignments.filter(assignment => assignment.domain === domain)
  if (owners.length === 1 && owners[0]?.owner === expectedOwner) return 0

  const expectedOwnerCount = owners.filter(assignment => assignment.owner === expectedOwner).length
  const unexpectedOwnerCount = owners.length - Math.min(expectedOwnerCount, 1)
  return Math.max(1, unexpectedOwnerCount)
}

export function evaluateAuthorityConformance(
  assignments: readonly AuthorityAssignment[] = AUTHORITY_ASSIGNMENTS,
  edges: readonly AuthorityEdge[] = AUTHORITY_EDGES,
): AuthorityConformanceReport {
  const toolAuthorityAssignments = assignments.filter(
    assignment => assignment.owner === "llm_tool" || assignment.owner === "tool_adapter",
  ).length
  const toolAuthorityEdges = edges.filter(
    edge =>
      (edge.source === "llm_tool" || edge.source === "tool_adapter") &&
      AUTHORITY_OPERATIONS_RESERVED_FOR_KERNEL.has(edge.operation),
  ).length

  const forbiddenRelations = FORBIDDEN_AUTHORITY_RELATIONS.filter(rule =>
    edges.some(
      edge =>
        edge.source === rule.source &&
        edge.target === rule.target &&
        (rule.operations as readonly AuthorityOperation[]).includes(edge.operation),
    ),
  ).map(rule => rule.id)

  return {
    gates: {
      SECOND_TASK_AUTHORITY: countUnexpectedAuthorityOwners(
        assignments,
        "task_completion",
        "graph",
      ),
      SECOND_WORLD_AUTHORITY: countUnexpectedAuthorityOwners(
        assignments,
        "world_state",
        "agent_world",
      ),
      TOOL_AS_AUTHORITY: toolAuthorityAssignments + toolAuthorityEdges,
      EXECUTION_COMPLETES_GRAPH_DIRECT: edges.filter(
        edge =>
          edge.source === "execution_fabric" &&
          edge.target === "graph" &&
          edge.operation === "complete_graph",
      ).length,
    },
    forbiddenRelations,
  }
}
