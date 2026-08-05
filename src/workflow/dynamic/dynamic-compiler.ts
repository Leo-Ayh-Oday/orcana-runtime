/** Dynamic workflow compiler (G6): model-authored JSON → validated spec.
 *
 *  Everything the model may choose is a registered node type + a
 *  registered handler. The compiled output is a plain WorkflowSpec — the
 *  exact shape static templates produce — so dynamic graphs and static
 *  templates share the scheduler (and G3 write/verify semantics).
 *
 *  Dynamic-only dimensions added on top of the G2 five-validator set:
 *   - node type ↔ handler agreement (type=read with a write handler ⇒ reject)
 *   - write budget (maxWrites)
 *   - verification completeness (write nodes need a verify successor;
 *     default reject, optional auto-append)
 */

import type { HandlerRegistry } from "../execution/handler-registry"
import { parseDynamicSpec, payloadToSpec, type DynamicGraphPayload, type DynamicNodePayload } from "./dynamic-schema"
import { validateSpec, type ValidationIssue, type ValidationContext } from "../validation"
import type { WorkflowSpec } from "../types"

export interface DynamicCompilerOptions {
  registry: HandlerRegistry
  knownNodeTypes?: Record<string, string[]>
  /** Max write nodes a dynamic graph may declare. */
  maxWrites?: number
  /** Auto-append a verification node after write nodes (default: reject). */
  autoAppendVerification?: boolean
}

export type DynamicCompileResult =
  | { ok: true; spec: WorkflowSpec; warnings: string[] }
  | { ok: false; issues: DynamicCompileIssue[]; warnings: string[] }

export type DynamicCompileIssue = ValidationIssue | DynamicIssue

export type DynamicIssue =
  | { code: "type_mismatch"; message: string }
  | { code: "unknown_node_type"; message: string }
  | { code: "too_many_writes"; message: string }
  | { code: "missing_verification"; message: string }
  | { code: "parse_error"; message: string }

/** Default registered node types → handler families. */
export const DEFAULT_NODE_TYPES: Record<string, string[]> = {
  read: ["tool.read_file", "tool.find_symbol", "tool.find_references", "tool.project_structure", "tool.git_diff", "tool.git_status"],
  write: ["tool.apply_patch", "tool.run_process"],
  verify: ["tool.run_targeted_verification"],
  reduce: ["reduce.noop", "reduce.dedupe", "reduce.merge_diagnostics"],
}

export function compileDynamicSpec(
  raw: unknown,
  options: DynamicCompilerOptions,
): DynamicCompileResult {
  const warnings: string[] = []
  const parsed = parseDynamicSpec(raw)
  if (!parsed.ok) {
    return { ok: false, issues: [{ code: "parse_error", message: parsed.reason }], warnings }
  }
  const payload = parsed.payload
  const nodeTypes = options.knownNodeTypes ?? DEFAULT_NODE_TYPES
  const typeMismatches = checkNodeTypes(payload, nodeTypes)
  if (typeMismatches.length > 0) {
    return { ok: false, issues: typeMismatches, warnings }
  }

  const writeCount = payload.nodes.filter(n => isWriteLike(n, nodeTypes)).length
  if (options.maxWrites !== undefined && writeCount > options.maxWrites) {
    return {
      ok: false,
      issues: [{ code: "too_many_writes", message: `workflow: dynamic graph declares ${writeCount} write nodes (limit ${options.maxWrites})` }],
      warnings,
    }
  }

  let spec = payloadToSpec(payload)

  const missingVerify = findUnverifiedWrites(spec, nodeTypes)
  if (missingVerify.length > 0) {
    if (options.autoAppendVerification) {
      spec = appendVerification(spec, missingVerify)
      warnings.push(`appended verification node verifying: ${missingVerify.join(", ")}`)
    } else {
      return {
        ok: false,
        issues: missingVerify.map(id => ({
          code: "missing_verification" as const,
          message: `workflow: write node "${id}" has no verification successor`,
        })),
        warnings,
      }
    }
  }

  const ctx = validationContext(options.registry)
  const report = validateSpec(spec, ctx)
  if (!report.ok) {
    return { ok: false, issues: report.issues, warnings }
  }
  return { ok: true, spec, warnings }
}

function checkNodeTypes(
  payload: DynamicGraphPayload,
  nodeTypes: Record<string, string[]>,
): DynamicIssue[] {
  const issues: DynamicIssue[] = []
  for (const node of payload.nodes) {
    const type = node.type
    if (type === undefined) continue
    const family = nodeTypes[type]
    if (!family) {
      issues.push({ code: "unknown_node_type", message: `workflow: node "${node.id}" uses unknown node type "${type}"` })
      continue
    }
    if (!family.includes(node.handler)) {
      issues.push({
        code: "type_mismatch",
        message: `workflow: node "${node.id}" declares type "${type}" but handler "${node.handler}" is not in that family`,
      })
    }
  }
  return issues
}

function isWriteLike(node: DynamicNodePayload, nodeTypes: Record<string, string[]>): boolean {
  const family = node.type ? nodeTypes[node.type] : undefined
  if (family && family !== nodeTypes["read"]) return true
  return nodeTypes["write"]?.includes(node.handler) ?? false
}

function findUnverifiedWrites(spec: WorkflowSpec, nodeTypes: Record<string, string[]>): string[] {
  const writeIds = new Set(spec.nodes.filter(n => nodeTypes["write"]?.includes(n.handler)).map(n => n.id))
  if (writeIds.size === 0) return []
  const verified = new Set<string>()
  for (const node of spec.nodes) {
    for (const dep of node.dependsOn ?? []) {
      if (writeIds.has(dep) && nodeTypes["verify"]?.includes(node.handler)) {
        verified.add(dep)
      }
    }
  }
  return [...writeIds].filter(id => !verified.has(id))
}

function appendVerification(spec: WorkflowSpec, writeIds: string[]): WorkflowSpec {
  return {
    ...spec,
    nodes: [
      ...spec.nodes,
      {
        id: "v:verify",
        handler: "tool.run_targeted_verification",
        input: { files: [] },
        dependsOn: writeIds,
      },
    ],
  }
}

function validationContext(registry: HandlerRegistry): ValidationContext {
  const known = new Set<string>()
  const readonly = new Set<string>()
  for (const handler of registry.list()) {
    known.add(handler)
    if (!registry.isWriteHandler(handler)) readonly.add(handler)
  }
  return { knownHandlers: known, readonlyHandlers: readonly }
}
