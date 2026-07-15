import { inferToolCategory, type PermissionLevel, type ToolCategory } from "../agent/permission"
import { getToolRisk, isToolRiskInvocationSensitive, type RiskLevel } from "../agent/tool-risk"
import type { ToolDef } from "./registry"

export type ToolAccess = "readonly" | "write"

export type ToolSideEffect =
  | "none"
  | "workspace_write"
  | "shell"
  | "network"
  | "external_process"
  | "runtime_state"

export type ToolPathPolicy = "none" | "handler_defined" | "workspace_only"

export type ToolStateRequirement =
  | "none"
  | "fresh_full_baseline"
  | "fresh_full_baseline_if_existing"

export type ToolStateUpdate = "file_state" | "evidence" | "checkpoint" | "runtime_state"

export type ToolResultOverflow = "handler_defined" | "clip" | "artifact_ref" | "summary"

export type ToolProvenance = "local" | "mcp"

export interface ToolResultBudget {
  /** Handler payload cutoff; diagnostic decoration may add to the returned character count. */
  maxChars: number | null
  maxLines: number | null
  overflow: ToolResultOverflow
}

/**
 * Declarative metadata that cannot be inferred safely from ToolDef's existing
 * execution fields. It lives on ToolDef so the runtime keeps one tool source
 * of truth instead of introducing a second mutable registry.
 */
export interface ToolContractMetadata {
  provenance?: ToolProvenance
  sideEffects?: ToolSideEffect[]
  pathParameters?: string[]
  pathPolicy?: ToolPathPolicy
  stateRequirement?: ToolStateRequirement
  stateUpdates?: ToolStateUpdate[]
  resultBudget?: Partial<ToolResultBudget>
  cooperativeCancellation?: boolean
}

/**
 * Immutable descriptive projection only. Existing permission, hook, freshness,
 * and handler code remains authoritative until a later slice adopts a field.
 */
export interface ToolContract {
  readonly name: string
  readonly description: string
  /** Author-declared schema. Interactive confirmation may extend the effective provider schema. */
  readonly declaredArgsSchema: Readonly<Record<string, unknown>>
  readonly provenance: ToolProvenance
  readonly category: ToolCategory
  readonly access: ToolAccess
  readonly concurrencySafe: boolean
  readonly permission: PermissionLevel | "category_default"
  readonly confirmation: Readonly<{
    declared: boolean
    requiredByBaseRisk: boolean
  }>
  readonly risk: Readonly<{
    /** Static risk before invocation parameters are available. Never an authorization decision. */
    baseLevel: RiskLevel
    maxLevel: RiskLevel
    invocationSensitive: boolean
    sessionAllowableAtBase: boolean
    evaluation: "per_invocation"
  }>
  readonly sideEffects: readonly ToolSideEffect[]
  readonly path: Readonly<{
    parameters: readonly string[]
    policy: ToolPathPolicy
  }>
  readonly state: Readonly<{
    requirement: ToolStateRequirement
    updates: readonly ToolStateUpdate[]
  }>
  readonly resultBudget: Readonly<ToolResultBudget>
  readonly execution: Readonly<{
    streaming: boolean
    cooperativeCancellation: boolean
  }>
}

const PATH_PARAMETER_NAMES = new Set(["path", "file_path", "file", "cwd"])
const MAX_SCHEMA_DEPTH = 64
const MAX_SCHEMA_NODES = 10_000

function schemaPathParameters(
  schema: unknown,
  prefix = "",
  depth = 0,
  state: { nodes: number; seen: WeakSet<object> } = { nodes: 0, seen: new WeakSet<object>() },
): string[] {
  if (!schema || typeof schema !== "object") return []
  if (depth > MAX_SCHEMA_DEPTH || state.nodes >= MAX_SCHEMA_NODES || state.seen.has(schema)) return []
  state.nodes++
  state.seen.add(schema)
  const node = schema as Record<string, unknown>
  const found: string[] = []
  const properties = node.properties

  if (properties && typeof properties === "object") {
    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      const qualified = prefix ? `${prefix}.${name}` : name
      if (PATH_PARAMETER_NAMES.has(name)) found.push(qualified)
      found.push(...schemaPathParameters(child, qualified, depth + 1, state))
    }
  }

  if (node.items) {
    const arrayPrefix = prefix ? `${prefix}[]` : "[]"
    found.push(...schemaPathParameters(node.items, arrayPrefix, depth + 1, state))
  }

  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const variants = node[key]
    if (Array.isArray(variants)) {
      for (const variant of variants) found.push(...schemaPathParameters(variant, prefix, depth + 1, state))
    }
  }

  return found
}

function defaultSideEffects(category: ToolCategory, access: ToolAccess, provenance: ToolProvenance): ToolSideEffect[] {
  if (provenance === "mcp") return ["network", "external_process"]
  if (category === "network") return ["network"]
  if (category === "shell") return ["shell", "external_process"]
  if (category === "file" || access === "write") return ["workspace_write"]
  return ["none"]
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object") return value
  const pending: object[] = [value]
  const seen = new WeakSet<object>()
  while (pending.length > 0) {
    const current = pending.pop()!
    if (seen.has(current)) continue
    seen.add(current)
    for (const nested of Object.values(current as Record<string, unknown>)) {
      if (nested && typeof nested === "object") pending.push(nested)
    }
    Object.freeze(current)
  }
  return value
}

function cloneDeclaredSchema(schema: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(schema) as Record<string, unknown>
  } catch {
    return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>
  }
}

/** Build an immutable, handler-free contract projection from one ToolDef. */
export function projectToolContract(defn: ToolDef): ToolContract {
  const definition = { defn }
  const category = inferToolCategory(defn.name, definition)
  const runtimeRisk = getToolRisk(defn.name, {}, definition)
  const metadata = defn.contract ?? {}
  const provenance = metadata.provenance ?? "local"
  const unverifiedExternal = provenance === "mcp"
  const baseLevel: RiskLevel = unverifiedExternal ? 4 : runtimeRisk.level
  const invocationSensitive = unverifiedExternal || isToolRiskInvocationSensitive(defn.name)
  const pathParameters = [...new Set(metadata.pathParameters ?? schemaPathParameters(defn.inputSchema))]
  const access: ToolAccess = defn.isReadonly ? "readonly" : "write"

  return deepFreeze({
    name: defn.name,
    description: defn.description,
    declaredArgsSchema: cloneDeclaredSchema(defn.inputSchema),
    provenance,
    category,
    access,
    concurrencySafe: defn.isConcurrencySafe ?? true,
    permission: defn.permission ?? "category_default",
    confirmation: {
      declared: defn.requiresConfirmation ?? false,
      requiredByBaseRisk: unverifiedExternal ? true : runtimeRisk.requiresConfirmation,
    },
    risk: {
      baseLevel,
      maxLevel: invocationSensitive ? 5 : baseLevel,
      invocationSensitive,
      sessionAllowableAtBase: unverifiedExternal ? false : runtimeRisk.sessionAllowable,
      evaluation: "per_invocation",
    },
    sideEffects: [...(metadata.sideEffects ?? defaultSideEffects(category, access, provenance))],
    path: {
      parameters: pathParameters,
      policy: metadata.pathPolicy ?? (pathParameters.length > 0 ? "handler_defined" : "none"),
    },
    state: {
      requirement: metadata.stateRequirement ?? "none",
      updates: [...(metadata.stateUpdates ?? [])],
    },
    resultBudget: {
      maxChars: metadata.resultBudget?.maxChars ?? null,
      maxLines: metadata.resultBudget?.maxLines ?? null,
      overflow: metadata.resultBudget?.overflow ?? "handler_defined",
    },
    execution: {
      streaming: Boolean(defn.executeStream),
      cooperativeCancellation: metadata.cooperativeCancellation ?? false,
    },
  })
}
