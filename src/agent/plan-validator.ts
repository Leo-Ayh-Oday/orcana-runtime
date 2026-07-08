/** [PR 3] Runtime Plan Validator — non-model structural checks.
 *
 *  Validates MasterPlan integrity without calling any LLM. Checked at:
 *    1. createMasterPlan — post-creation structural check
 *    2. tryNodeTransition — before activating next node
 *    3. planning gate force-pass — replaces bare pass-through with minimal fix
 *
 *  Design: pure functions with zero side effects. Severity "error" blocks execution.
 *  Severity "warn" is advisory — the model sees warnings in the review prompt.
 */

import type { TaskPacket } from "./task-packet"
import { DEFAULT_RIPPLE, DEFAULT_BUDGET, FILE_PATH_RE, type VerificationRequirement } from "./task-packet"
import type { PlanNode, MasterPlan } from "./master-plan"

// ── Validation types ──

export type ValidationSeverity = "error" | "warn"

export interface ValidationIssue {
  severity: ValidationSeverity
  nodeId?: string
  message: string
  check: string
}

export interface ValidationReport {
  issues: ValidationIssue[]
  /** All issues at severity "error". */
  errors: ValidationIssue[]
  /** All issues at severity "warn". */
  warnings: ValidationIssue[]
  /** No errors == clean. */
  isClean: boolean
  /** Errors exist and are structural (cycle, missing tracker, etc.). */
  highRisk: boolean
}

// ── Report factory ──

function makeReport(issues: ValidationIssue[]): ValidationReport {
  const errors = issues.filter(i => i.severity === "error")
  const warnings = issues.filter(i => i.severity === "warn")
  return {
    issues,
    errors,
    warnings,
    isClean: errors.length === 0,
    highRisk: errors.length > 0,
  }
}

// ── Individual checks ──

/** Detect directed cycles in the dependency graph. Standard DFS with coloring.
 *  WHITE=unvisited, GRAY=in current path, BLACK=visited and done. */
function checkCycles(plan: MasterPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const nodeIds = plan.nodes.map(n => n.id)
  const color = new Map<string, "white" | "gray" | "black">()
  for (const id of nodeIds) color.set(id, "white")

  function dfs(id: string, path: string[]): boolean {
    const c = color.get(id)
    if (c === "black") return false
    if (c === "gray") {
      // Cycle detected — report the cycle path
      const cycleStart = path.indexOf(id)
      const cycle = [...path.slice(cycleStart), id]
      issues.push({
        severity: "error",
        nodeId: id,
        message: `DAG 循环依赖: ${cycle.join(" → ")}`,
        check: "cycle",
      })
      return true
    }
    color.set(id, "gray")
    path.push(id)
    const node = plan.nodes.find(n => n.id === id)
    if (node) {
      for (const depId of node.dependsOn) {
        if (color.has(depId)) dfs(depId, path)
      }
    }
    path.pop()
    color.set(id, "black")
    return false
  }

  for (const id of nodeIds) {
    if (color.get(id) === "white") dfs(id, [])
  }

  return issues
}

/** Validate node IDs are unique. */
function checkUniqueness(plan: MasterPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const seen = new Set<string>()

  for (const node of plan.nodes) {
    if (seen.has(node.id)) {
      issues.push({
        severity: "error",
        nodeId: node.id,
        message: `节点 ID "${node.id}" 重复 — 同一 plan 内所有节点 ID 必须唯一`,
        check: "uniqueness",
      })
    }
    seen.add(node.id)
  }

  return issues
}

/** Every node must have a non-dummy tracker. */
function checkTrackerExistence(plan: MasterPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  for (const node of plan.nodes) {
    const t = node.tracker
    if (!t || t.steps.length === 0) {
      issues.push({
        severity: "error",
        nodeId: node.id,
        message: `节点 "${node.title}" (${node.id}) 缺少 TaskTracker 或步骤为空`,
        check: "tracker",
      })
    }
  }

  return issues
}

/** Check doneCriteria completeness per node. */
function checkDoneCriteria(plan: MasterPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  for (const node of plan.nodes) {
    const p = node._packet
    if (!p) {
      issues.push({
        severity: "warn",
        nodeId: node.id,
        message: `节点 "${node.title}" (${node.id}) 缺少 TaskPacket (_packet)，无法检查 doneCriteria`,
        check: "doneCriteria",
      })
      continue
    }
    if (p.doneCriteria.length === 0) {
      issues.push({
        severity: "warn",
        nodeId: node.id,
        message: `节点 "${node.title}" (${node.id}) doneCriteria 为空 — 无法判断完成条件`,
        check: "doneCriteria",
      })
    }
  }

  return issues
}

/** Check verification completeness per node. */
function checkVerification(plan: MasterPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  for (const node of plan.nodes) {
    const p = node._packet
    if (!p) {
      // Already reported in checkDoneCriteria — skip
      continue
    }
    if (p.verification.length === 0) {
      issues.push({
        severity: "error",
        nodeId: node.id,
        message: `节点 "${node.title}" (${node.id}) verification 为空 — 必须至少包含 typecheck`,
        check: "verification",
      })
    }
    // Check each verification requirement has a kind
    for (const v of p.verification) {
      if (!v.kind) {
        issues.push({
          severity: "warn",
          nodeId: node.id,
          message: `节点 "${node.title}" (${node.id}) verification 项缺少 kind`,
          check: "verification",
        })
      }
    }
  }

  return issues
}

/** Check scope items are plausible. */
function checkScope(plan: MasterPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  for (const node of plan.nodes) {
    const p = node._packet
    if (!p) continue
    if (p.scope.length === 0) {
      issues.push({
        severity: "warn",
        nodeId: node.id,
        message: `节点 "${node.title}" (${node.id}) scope 为空 — 没有明确交付物`,
        check: "scope",
      })
    }
  }

  return issues
}

// ── PR-2.4: Additional checks ──

/** Check that node titles are descriptive enough (not just single words). */
function checkTitleQuality(plan: MasterPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const node of plan.nodes) {
    if (node.title.length < 5) {
      issues.push({
        severity: "warn",
        nodeId: node.id,
        message: `节点 "${node.title}" 标题过短（${node.title.length} 字符），建议提供更多细节`,
        check: "titleQuality",
      })
    }
  }
  return issues
}

/** Check that dependency IDs actually reference existing nodes. */
function checkDependencyValidity(plan: MasterPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const nodeIds = new Set(plan.nodes.map(n => n.id))

  for (const node of plan.nodes) {
    for (const depId of node.dependsOn) {
      if (!nodeIds.has(depId)) {
        issues.push({
          severity: "error",
          nodeId: node.id,
          message: `节点 "${node.title}" 依赖不存在的节点 "${depId}"`,
          check: "dependency",
        })
      }
    }
  }
  return issues
}

/** Check that plan has at least one node (non-empty). */
function checkNonEmpty(plan: MasterPlan): ValidationIssue[] {
  if (plan.nodes.length === 0) {
    return [{
      severity: "error",
      message: "MasterPlan 没有节点 — 至少需要一个执行步骤",
      check: "nonEmpty",
    }]
  }
  return []
}

// ── Main validation entry ──

/** Run all structural checks against a MasterPlan.
 *  Pure function — no side effects, no model calls. */
export function validatePlan(plan: MasterPlan): ValidationReport {
  const checks: Array<(p: MasterPlan) => ValidationIssue[]> = [
    checkNonEmpty,           // PR-2.4: empty plan
    checkUniqueness,
    checkCycles,
    checkDependencyValidity, // PR-2.4: dangling dependency references
    checkTrackerExistence,
    checkDoneCriteria,
    checkVerification,
    checkScope,
    checkTitleQuality,       // PR-2.4: title quality warnings
  ]

  const issues: ValidationIssue[] = []
  for (const check of checks) {
    issues.push(...check(plan))
  }

  return makeReport(issues)
}

/** Fast single-node check — called before node transition. */
export function validateNode(plan: MasterPlan, nodeId: string): ValidationIssue[] {
  const node = plan.nodes.find(n => n.id === nodeId)
  if (!node) {
    return [{ severity: "error", nodeId, message: `节点 ${nodeId} 不在 plan 中`, check: "existence" }]
  }

  const issues: ValidationIssue[] = []

  // Tracker check
  if (!node.tracker || node.tracker.steps.length === 0) {
    issues.push({
      severity: "error",
      nodeId,
      message: `节点 "${node.title}" 缺少 TaskTracker`,
      check: "tracker",
    })
  }

  // doneCriteria
  const p = node._packet
  if (p && p.doneCriteria.length === 0) {
    issues.push({
      severity: "warn",
      nodeId,
      message: `节点 "${node.title}" doneCriteria 为空`,
      check: "doneCriteria",
    })
  }

  // verification
  if (p && p.verification.length === 0) {
    issues.push({
      severity: "error",
      nodeId,
      message: `节点 "${node.title}" verification 为空`,
      check: "verification",
    })
  }

  return issues
}

// ── Minimal fix factory (replaces forcePlanningPassAfterLimit bare pass-through) ──

/** Build a minimal viable TaskPacket when the planning gate fails to produce a valid plan.
 *
 *  Instead of bare pass-through after 3 rejections, this creates a structurally
 *  valid packet with minimal scope and typecheck verification. The model can then
 *  execute it, and the plan can be revised mid-flight if needed.
 */
export function createMinimumViablePacket(goal: string, planText?: string): TaskPacket {
  // Try to extract any concrete files from the rejected plan text
  const scope: string[] = []
  if (planText && planText.length > 0) {
    let match: RegExpExecArray | null
    FILE_PATH_RE.lastIndex = 0
    const seen = new Set<string>()
    while ((match = FILE_PATH_RE.exec(planText)) !== null) {
      const f = match[1]!
      if (!seen.has(f)) { seen.add(f); scope.push(f) }
    }
  }

  const verification: VerificationRequirement[] = [
    { kind: "typecheck", description: "运行类型检查", command: "tsc --noEmit" },
  ]

  return {
    taskId: `mvp-${Date.now()}`,
    nodeId: "1",
    title: goal.slice(0, 120),
    goal,
    scope: scope.length > 0 ? scope.slice(0, 8) : [goal.slice(0, 80)],
    doneCriteria: scope.length > 0
      ? scope.slice(0, 4).map(f => `文件 ${f} 已通过类型检查`)
      : ["typecheck 通过，核心逻辑可运行"],
    verification,
    ripplePolicy: { ...DEFAULT_RIPPLE },
    contextBudget: { ...DEFAULT_BUDGET },
  }
}

// ── Force-pass replacement ──

export interface ForcePassResult {
  /** Whether to allow execution despite planning gate failure. */
  allow: boolean
  /** If allow=false, this contains the reason to show the model. */
  reason?: string
  /** If allow=true and the plan was fixed, the minimum viable packet. */
  fallbackPacket?: TaskPacket
}

/**
 * Replaces the old forcePlanningPassAfterLimit bare pass-through.
 *
 * After maxRounds consecutive planning gate rejections:
 *  - If the existing plan (or plan text) passes structural validation → allow
 *  - Otherwise → create a minimum viable TaskPacket and allow
 *  - Never bare-pass — always at least a minimal packet
 */
export function evaluatePlanForcePass(opts: {
  rejections: number
  maxRounds?: number
  planText: string
  goal: string
}): ForcePassResult {
  const max = opts.maxRounds ?? 3

  if (opts.rejections < max) {
    return { allow: false, reason: `仍需完善计划 (${opts.rejections + 1}/${max})` }
  }

  // Force-pass threshold reached — build minimal packet
  const packet = createMinimumViablePacket(opts.goal, opts.planText)

  return {
    allow: true,
    fallbackPacket: packet,
  }
}

// ── Report formatting (injectable into review prompts) ──

// ── TaskPacket-level validation (PR-2.1) ──

const VALID_VERIFICATION_KINDS = new Set(["typecheck", "test", "build", "lint", "smoke", "unknown"])

/** Validate a single TaskPacket for structural integrity.
 *  Called at packet creation time — fail closed on invalid packets. */
export function validateTaskPacket(packet: TaskPacket): ValidationReport {
  const issues: ValidationIssue[] = []

  // Required fields
  if (!packet.title || !packet.title.trim()) {
    issues.push({ severity: "error", nodeId: packet.nodeId, message: "TaskPacket title 为空", check: "packet.title" })
  }
  if (!packet.goal || !packet.goal.trim()) {
    issues.push({ severity: "error", nodeId: packet.nodeId, message: "TaskPacket goal 为空", check: "packet.goal" })
  }
  if (!packet.nodeId || !packet.nodeId.trim()) {
    issues.push({ severity: "error", message: "TaskPacket nodeId 为空", check: "packet.nodeId" })
  }

  // Scope
  if (packet.scope.length === 0) {
    issues.push({ severity: "error", nodeId: packet.nodeId, message: `"${packet.title}" scope 为空`, check: "packet.scope" })
  }
  for (const item of packet.scope) {
    if (!item.trim()) {
      issues.push({ severity: "warn", nodeId: packet.nodeId, message: `"${packet.title}" scope 包含空条目`, check: "packet.scope" })
    }
  }

  // Done criteria
  if (packet.doneCriteria.length === 0) {
    issues.push({ severity: "warn", nodeId: packet.nodeId, message: `"${packet.title}" doneCriteria 为空`, check: "packet.doneCriteria" })
  }

  // Verification
  if (packet.verification.length === 0) {
    issues.push({ severity: "error", nodeId: packet.nodeId, message: `"${packet.title}" verification 为空 — 至少需要 typecheck`, check: "packet.verification" })
  }
  for (const v of packet.verification) {
    if (!v.kind) {
      issues.push({ severity: "error", nodeId: packet.nodeId, message: `"${packet.title}" verification 缺少 kind`, check: "packet.verification" })
    } else if (!VALID_VERIFICATION_KINDS.has(v.kind)) {
      issues.push({ severity: "error", nodeId: packet.nodeId, message: `"${packet.title}" verification kind 无效: ${v.kind}`, check: "packet.verification" })
    }
    if (!v.description || !v.description.trim()) {
      issues.push({ severity: "warn", nodeId: packet.nodeId, message: `"${packet.title}" verification "${v.kind}" 缺少 description`, check: "packet.verification" })
    }
  }

  // Ripple policy
  if (typeof packet.ripplePolicy?.autoPropagate !== "boolean") {
    issues.push({ severity: "warn", nodeId: packet.nodeId, message: `"${packet.title}" ripplePolicy.autoPropagate 不是 boolean`, check: "packet.ripplePolicy" })
  }
  if (typeof packet.ripplePolicy?.requireEvidence !== "boolean") {
    issues.push({ severity: "warn", nodeId: packet.nodeId, message: `"${packet.title}" ripplePolicy.requireEvidence 不是 boolean`, check: "packet.ripplePolicy" })
  }
  if (typeof packet.ripplePolicy?.maxRetries !== "number" || packet.ripplePolicy?.maxRetries < 0) {
    issues.push({ severity: "warn", nodeId: packet.nodeId, message: `"${packet.title}" ripplePolicy.maxRetries 无效`, check: "packet.ripplePolicy" })
  }

  // Context budget
  if (packet.contextBudget) {
    if (typeof packet.contextBudget.maxToolsPerNode !== "number" || packet.contextBudget.maxToolsPerNode <= 0) {
      issues.push({ severity: "warn", nodeId: packet.nodeId, message: `"${packet.title}" contextBudget.maxToolsPerNode 无效`, check: "packet.contextBudget" })
    }
    if (typeof packet.contextBudget.maxRoundsPerNode !== "number" || packet.contextBudget.maxRoundsPerNode <= 0) {
      issues.push({ severity: "warn", nodeId: packet.nodeId, message: `"${packet.title}" contextBudget.maxRoundsPerNode 无效`, check: "packet.contextBudget" })
    }
  }

  return makeReport(issues)
}

/** Format validation issues for the model to see in review/transition prompts. */
export function formatValidationReport(report: ValidationReport): string {
  if (report.errors.length === 0 && report.warnings.length === 0) return ""

  const lines: string[] = [
    "## Plan Validator",
    "",
  ]

  if (report.errors.length > 0) {
    lines.push("### 错误 (阻塞执行)")
    for (const e of report.errors) {
      lines.push(`- [${e.nodeId ?? "-"}] ${e.message}`)
    }
    lines.push("")
  }

  if (report.warnings.length > 0) {
    lines.push("### 警告")
    for (const w of report.warnings) {
      lines.push(`- [${w.nodeId ?? "-"}] ${w.message}`)
    }
    lines.push("")
  }

  return lines.join("\n")
}
