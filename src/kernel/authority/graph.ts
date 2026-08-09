export const AUTHORITY_DOMAINS = Object.freeze([
  "policy_ceiling",
  "task_definition",
  "task_dependencies",
  "task_completion",
  "world_state",
  "execution_facts",
  "evidence_sufficiency",
] as const)

export type AuthorityDomain = (typeof AUTHORITY_DOMAINS)[number]

export const AUTHORITY_NODES = Object.freeze([
  "user_policy",
  "graph",
  "agent_kernel",
  "agent_world",
  "execution_fabric",
  "evidence_kernel",
  "driver",
  "tool_adapter",
  "llm_tool",
  "remote_worker",
  "host_secret",
] as const)

export type AuthorityNode = (typeof AUTHORITY_NODES)[number]

export const AUTHORITY_OPERATIONS = Object.freeze([
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
] as const)

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

function freezeRecords<const T extends object>(records: readonly T[]): readonly Readonly<T>[] {
  return Object.freeze(records.map(record => Object.freeze(record)))
}

export const AUTHORITY_ASSIGNMENTS = freezeRecords([
  { domain: "policy_ceiling", owner: "user_policy" },
  { domain: "task_definition", owner: "graph" },
  { domain: "task_dependencies", owner: "graph" },
  { domain: "task_completion", owner: "graph" },
  { domain: "world_state", owner: "agent_world" },
  { domain: "execution_facts", owner: "execution_fabric" },
  { domain: "evidence_sufficiency", owner: "evidence_kernel" },
]) satisfies readonly AuthorityAssignment[]

export const AUTHORITY_EDGES = freezeRecords([
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
]) satisfies readonly AuthorityEdge[]

export const FORBIDDEN_AUTHORITY_RELATIONS = freezeRecords([
  {
    id: "EXECUTION_FABRIC_COMPLETES_GRAPH",
    source: "execution_fabric",
    target: "graph",
    operations: Object.freeze(["complete_graph"]),
  },
  {
    id: "DRIVER_DIRECT_WORLD_MUTATION",
    source: "driver",
    target: "agent_world",
    operations: Object.freeze(["commit_world", "mutate_world"]),
  },
  {
    id: "LLM_TOOL_HOLDS_HOST_SECRET",
    source: "llm_tool",
    target: "host_secret",
    operations: Object.freeze(["hold_host_secret"]),
  },
]) satisfies readonly ForbiddenAuthorityRelation[]

export const AK0_GATE_NAMES = Object.freeze([
  "SECOND_TASK_AUTHORITY",
  "SECOND_WORLD_AUTHORITY",
  "TOOL_AS_AUTHORITY",
  "EXECUTION_COMPLETES_GRAPH_DIRECT",
] as const)

export type Ak0GateName = (typeof AK0_GATE_NAMES)[number]

export interface AuthorityConformanceReport {
  readonly gates: Readonly<Record<Ak0GateName, number>>
  readonly authorityAssignmentViolations: readonly AuthorityDomain[]
  readonly unexpectedEdges: readonly AuthorityEdge[]
  readonly missingRequiredEdges: readonly AuthorityEdge[]
  readonly forbiddenRelations: readonly ForbiddenAuthorityRelation["id"][]
}

const TASK_AUTHORITY_OPERATIONS = new Set<AuthorityOperation>([
  "command_task",
  "complete_graph",
])

const WORLD_MUTATION_OPERATIONS = new Set<AuthorityOperation>([
  "commit_world",
  "mutate_world",
])

const EXPECTED_AUTHORITY_OWNERS: Readonly<Record<AuthorityDomain, AuthorityNode>> = Object.freeze({
  policy_ceiling: "user_policy",
  task_definition: "graph",
  task_dependencies: "graph",
  task_completion: "graph",
  world_state: "agent_world",
  execution_facts: "execution_fabric",
  evidence_sufficiency: "evidence_kernel",
})

function edgeKey(edge: AuthorityEdge): string {
  return `${edge.source}:${edge.operation}:${edge.target}`
}

const ALLOWED_TOOL_EDGE_KEYS = new Set<string>([
  edgeKey({ source: "llm_tool", target: "tool_adapter", operation: "request_capability" }),
  edgeKey({ source: "tool_adapter", target: "agent_kernel", operation: "request_capability" }),
])

const ALLOWED_TASK_AUTHORITY_EDGE_KEYS = new Set<string>([
  edgeKey({ source: "graph", target: "agent_kernel", operation: "command_task" }),
])

const ALLOWED_WORLD_MUTATION_EDGE_KEYS = new Set<string>([
  edgeKey({ source: "agent_kernel", target: "agent_world", operation: "commit_world" }),
])

const CANONICAL_EDGE_KEYS = new Set(AUTHORITY_EDGES.map(edgeKey))

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

function countAllowlistViolations(
  edges: readonly AuthorityEdge[],
  relevant: (edge: AuthorityEdge) => boolean,
  allowedKeys: ReadonlySet<string>,
): number {
  const relevantEdges = edges.filter(relevant)
  const providedCounts = new Map<string, number>()
  let violations = 0

  for (const edge of relevantEdges) {
    const key = edgeKey(edge)
    if (!allowedKeys.has(key)) {
      violations += 1
      continue
    }
    providedCounts.set(key, (providedCounts.get(key) ?? 0) + 1)
  }

  for (const allowedKey of allowedKeys) {
    const count = providedCounts.get(allowedKey) ?? 0
    if (count === 0) violations += 1
    if (count > 1) violations += count - 1
  }

  return violations
}

export function evaluateAuthorityConformance(
  assignments: readonly AuthorityAssignment[] = AUTHORITY_ASSIGNMENTS,
  edges: readonly AuthorityEdge[] = AUTHORITY_EDGES,
): AuthorityConformanceReport {
  const toolAuthorityAssignments = assignments.filter(
    assignment => assignment.owner === "llm_tool" || assignment.owner === "tool_adapter",
  ).length
  const toolAuthorityEdges = countAllowlistViolations(
    edges,
    edge => edge.source === "llm_tool" || edge.source === "tool_adapter",
    ALLOWED_TOOL_EDGE_KEYS,
  )

  const unexpectedTaskAuthorityEdges = countAllowlistViolations(
    edges,
    edge => TASK_AUTHORITY_OPERATIONS.has(edge.operation),
    ALLOWED_TASK_AUTHORITY_EDGE_KEYS,
  )

  const unexpectedWorldMutationEdges = countAllowlistViolations(
    edges,
    edge => WORLD_MUTATION_OPERATIONS.has(edge.operation),
    ALLOWED_WORLD_MUTATION_EDGE_KEYS,
  )

  const authorityAssignmentViolations = AUTHORITY_DOMAINS.filter(
    domain => countUnexpectedAuthorityOwners(assignments, domain, EXPECTED_AUTHORITY_OWNERS[domain]) > 0,
  )

  const seenEdgeKeys = new Set<string>()
  const unexpectedEdges = edges.filter(edge => {
    const key = edgeKey(edge)
    const unexpected = !CANONICAL_EDGE_KEYS.has(key) || seenEdgeKeys.has(key)
    seenEdgeKeys.add(key)
    return unexpected
  })
  const missingRequiredEdges = AUTHORITY_EDGES.filter(edge => !seenEdgeKeys.has(edgeKey(edge)))

  const forbiddenRelations = FORBIDDEN_AUTHORITY_RELATIONS.filter(rule =>
    edges.some(
      edge =>
        edge.source === rule.source &&
        edge.target === rule.target &&
        (rule.operations as readonly AuthorityOperation[]).includes(edge.operation),
    ),
  ).map(rule => rule.id)

  return Object.freeze({
    gates: Object.freeze({
      SECOND_TASK_AUTHORITY:
        countUnexpectedAuthorityOwners(assignments, "task_definition", "graph") +
        countUnexpectedAuthorityOwners(assignments, "task_dependencies", "graph") +
        countUnexpectedAuthorityOwners(assignments, "task_completion", "graph") +
        unexpectedTaskAuthorityEdges,
      SECOND_WORLD_AUTHORITY:
        countUnexpectedAuthorityOwners(assignments, "world_state", "agent_world") +
        unexpectedWorldMutationEdges,
      TOOL_AS_AUTHORITY: toolAuthorityAssignments + toolAuthorityEdges,
      EXECUTION_COMPLETES_GRAPH_DIRECT: edges.filter(
        edge =>
          edge.source === "execution_fabric" &&
          edge.target === "graph",
      ).length,
    }),
    authorityAssignmentViolations: Object.freeze(authorityAssignmentViolations),
    unexpectedEdges: Object.freeze(unexpectedEdges),
    missingRequiredEdges: Object.freeze(missingRequiredEdges),
    forbiddenRelations: Object.freeze(forbiddenRelations),
  })
}
