/** Permission gate (G6): dynamic graphs never reach the scheduler
 *  without a decision.
 *
 *  Decisions:
 *   - approved       — pure read-only graph (or explicitly approved below);
 *   - needs_approval — contains write nodes: a human/approver must call
 *                      approve() before the spec is handed out;
 *   - rejected       — parse/validation failure: no spec is ever produced.
 *
 *  The model cannot bypass the gate: the only way to obtain a WorkflowSpec
 *  from dynamic JSON is compileDynamicSpec → gate → (approve) → spec.
 */

import type { HandlerRegistry } from "../execution/handler-registry"
import { compileDynamicSpec, DEFAULT_NODE_TYPES, type DynamicCompileResult } from "./dynamic-compiler"
import type { WorkflowSpec } from "../types"

export type GateDecision = "approved" | "needs_approval" | "rejected"

export interface GateResult {
  decision: GateDecision
  spec: WorkflowSpec | null
  /** Non-empty when needs_approval — the reason a human must look at it. */
  rationale?: string
  issues: string[]
}

export class PermissionGate {
  private readonly registry: HandlerRegistry
  private approved = false
  private pending: WorkflowSpec | null = null

  constructor(registry: HandlerRegistry) {
    this.registry = registry
  }

  /** Evaluate untrusted dynamic JSON; produces a spec only when approved. */
  evaluate(raw: unknown): GateResult {
    this.pending = null
    this.approved = false
    const result = this.compile(raw)
    if (!result.ok) {
      return { decision: "rejected", spec: null, issues: result.issues.map(i => i.message) }
    }
    const spec = result.spec
    const hasWrites = spec.nodes.some(n => this.registry.isWriteHandler(n.handler))
    if (!hasWrites) {
      return { decision: "approved", spec, issues: [] }
    }
    this.pending = spec
    const writeNodes = spec.nodes.filter(n => this.registry.isWriteHandler(n.handler)).map(n => n.id).join(", ")
    return {
      decision: "needs_approval",
      spec: null,
      rationale: `graph contains write nodes: ${writeNodes}`,
      issues: [],
    }
  }

  /** Approve the pending write graph. Returns null when nothing pending. */
  approve(): WorkflowSpec | null {
    if (!this.pending) return null
    const spec = this.pending
    this.pending = null
    this.approved = true
    return spec
  }

  wasApproved(): boolean {
    return this.approved
  }

  private compile(raw: unknown): DynamicCompileResult {
    return compileDynamicSpec(raw, { registry: this.registry, knownNodeTypes: DEFAULT_NODE_TYPES })
  }
}
