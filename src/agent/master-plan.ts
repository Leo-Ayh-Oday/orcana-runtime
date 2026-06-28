/** [Phase 2] Master Plan system — hierarchical task tree with review gates.
 *
 *  Status: IMPLEMENTED AND WIRED. loop.ts directly imports and calls:
 *    - activateMasterPlan (3 call sites: 2 activate + 1 tryNodeTransition)
 *    - tryNodeTransition (2 node-transition points)
 *    - planRef.current / planProgress (consumed by TASK_TOOL)
 *  MasterPlan nodes drive TaskPacket creation via buildPacketFromLine /
 *  createTaskTrackerFromPacket. setActivePatchContext is called at each
 *  node activation point. Plan state is serialized into cold memory for
 *  prefix cache stability.
 *
 *  Remaining gaps for v1.0:
 *    - Node→ModeContract auto-transition (shouldTransitionMode still stub)
 *    - Node→PatchTransaction→EvidenceLedger→Completion single path (partially wired)
 *
 *  Inspired by MiMo Code's task registry + checkpoint §4 integration:
 *    - Task IDs: "1", "2", "3"... (simple, no dots needed for main agent)
 *    - Each node wraps a TaskTracker for its own sub-steps
 *    - Node completion injects "Review Master Plan" as the last step
 *    - Review gate: model re-reads master plan status before moving to next node
 *
 *  Flow:
 *    主计划 → 激活节点1 → [子追踪: build steps → verify → "回顾主计划"]
 *                                                           ↓
 *                                                    审查状态 → 调整依赖 → 激活节点2
 */

import type { TaskTracker } from "./task-tracker"
import { taskTrackerComplete, formatTaskTrackerStatus, formatTaskTrackerPrompt, updateTaskTrackerAfterTools, missingTaskRequirements, markPlanAccepted, type TaskIntent } from "./task-tracker"
import { buildPacketFromLine, createTaskTrackerFromPacket, type TaskPacket } from "./task-packet"
import { validatePlan } from "./plan-validator"

// ── Plan status (MiMo-compatible icons) ──

export type PlanNodeStatus = "pending" | "active" | "blocked" | "done" | "skipped"

const STATUS_ICONS: Record<PlanNodeStatus, string> = {
  pending:  "🔵",
  active:   "🔄",
  blocked:  "🟡",
  done:     "✅",
  skipped:  "❌",
}

// ── Plan node ──

export interface PlanNode {
  id: string               // "1", "2", "3"
  title: string            // "认证模块"
  status: PlanNodeStatus
  tracker: TaskTracker     // each node has its own sub-tracker
  dependsOn: string[]      // node IDs this depends on
  blockedBy: string[]      // node IDs that block this one (reverse edge)
  evidence?: string        // completion evidence
  reactCount: number       // how many times we've nudged this node back
  /** PR 2: TaskPacket attached to this node (set by createMasterPlanFromPacket / addNode). */
  _packet?: TaskPacket
}

// ── Master plan ──

export interface MasterPlan {
  goal: string
  intent: TaskIntent
  nodes: PlanNode[]
  current: string          // currently active node ID
  createdAt: number
  updatedAt: number
  /** PR 8: last plan-validation result (set by plan-validator). */
  _lastValidation?: import("./plan-validator").ValidationReport
}

export interface PlanContextAttachment {
  contextMapId?: string
  requiredContextEvidence?: string[]
}

const MAX_NODE_REACT = 3     // MiMo: MAX_TASK_GATE_MAIN_REACT = 3
const MAX_REVIEW_REACT = 5   // Master plan review nudges before forcing continuation

// ── Factory ──

function createPlanNodeFromTitle(opts: {
  id: string
  title: string
  goal: string
  intent: TaskIntent
  status: PlanNodeStatus
  dependsOn?: string[]
  context?: PlanContextAttachment
}): PlanNode {
  const packet = buildPacketFromLine({
    title: opts.title,
    goal: opts.goal,
    nodeId: opts.id,
    contextMapId: opts.context?.contextMapId,
    requiredContextEvidence: opts.context?.requiredContextEvidence,
  })
  return {
    id: opts.id,
    title: opts.title,
    status: opts.status,
    tracker: createTaskTrackerFromPacket(packet, opts.intent),
    dependsOn: opts.dependsOn ?? [],
    blockedBy: [],
    reactCount: 0,
    _packet: packet,
  }
}

function refreshPlanValidation(plan: MasterPlan): void {
  plan._lastValidation = validatePlan(plan)
}

function contextAttachmentFromPlan(plan: MasterPlan): PlanContextAttachment | undefined {
  const packet = plan.nodes.find(n => n._packet?.contextMapId || n._packet?.requiredContextEvidence?.length)?._packet
  if (!packet) return undefined
  return {
    contextMapId: packet.contextMapId,
    requiredContextEvidence: packet.requiredContextEvidence,
  }
}

export function createMasterPlan(goal: string, intent: TaskIntent, nodeTitles: string[], context?: PlanContextAttachment): MasterPlan {
  const nodes: PlanNode[] = nodeTitles.map((title, i) => createPlanNodeFromTitle({
    id: String(i + 1),
    title,
    goal,
    intent,
    status: i === 0 ? "active" : "pending",
    context,
  }))
  const plan: MasterPlan = {
    goal,
    intent,
    nodes,
    current: "1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  refreshPlanValidation(plan)
  return plan
}

/** Create a single-node MasterPlan from a TaskPacket (used by force-pass / long_task autoplan). */
export function createMasterPlanFromPacket(packet: TaskPacket, intentLabel: string = "coding"): MasterPlan {
  const intent: TaskIntent = intentLabel as TaskIntent
  const tracker = createTaskTrackerFromPacket(packet, intent)
  const node: PlanNode = {
    id: packet.nodeId || "1",
    title: packet.title,
    status: "active" as PlanNodeStatus,
    tracker,
    dependsOn: [],
    blockedBy: [],
    reactCount: 0,
    _packet: packet,
  }
  const plan: MasterPlan = {
    goal: packet.goal || packet.title,
    intent,
    nodes: [node],
    current: node.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  refreshPlanValidation(plan)
  return plan
}

/** Extract nodes from a markdown plan. Returns empty array if parsing fails. */
export function nodesFromPlanText(planText: string): Array<{ title: string; dependsOn: number[] }> {
  const lines = planText.split("\n")
  const nodes: Array<{ title: string; dependsOn: number[] }> = []
  const idPat = /^(?:\d+[\.\)\-、]|[-*]\s+)\s*/
  let idx = 0

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const match = line.match(idPat)
    if (!match) continue
    const title = line.slice(match[0].length).trim().slice(0, 120)
    if (!title) continue
    idx++
    // Crude dep detection: "联调" or "集成" → depends on all prior
    const dependsOn: number[] = []
    if (/联调|集成|接入|连接|组合|合并|end.to.end/i.test(title)) {
      for (let j = 1; j < idx; j++) dependsOn.push(j)
    }
    nodes.push({ title: `${idx}. ${title}`, dependsOn })
  }

  return nodes
}

/** Flash-driven plan parsing — extracts structured nodes from model-written plans. */
export async function parsePlanWithFlash(
  goal: string,
  planText: string,
  streamChat: (system: string, prompt: string) => AsyncGenerator<{ type: string; data?: unknown }>,
): Promise<Array<{ title: string; dependsOn: number[] }>> {
  if (planText.length < 100) return nodesFromPlanText(planText)

  const prompt = [
    "将下面的项目计划解析为结构化任务节点。返回严格 JSON。",
    "",
    `项目目标: ${goal.slice(0, 200)}`,
    "",
    "规则:",
    '- "nodes": 节点数组，每个节点 { "title": "...", "dependsOn": [1,2] }',
    "- title: 节点名称和简短描述（≤60字），保留原文关键词",
    "- dependsOn: 依赖的节点编号数组（从1开始），无依赖为空数组",
    "- 只提取真正需要执行的任务，跳过「总结」「收尾」等虚节点",
    "- 联调/集成/接入类节点 → dependsOn 应包含所有被集成的节点",
    "- 保持顺序，但可以跳过不重要的编号",
    "- 用中文",
    "",
    "输出纯 JSON，不要其他文字。",
    "",
    "## 计划文本",
    planText.slice(0, 4000),
  ].join("\n")

  try {
    const chunks: string[] = []
    for await (const event of streamChat(
      "你是计划解析器。输出纯 JSON。",
      prompt,
    )) {
      if (event.type === "text" && typeof event.data === "string") chunks.push(event.data)
    }
    const text = chunks.join("").trim()
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return nodesFromPlanText(planText)
    const parsed = JSON.parse(jsonMatch[0]) as { nodes?: Array<{ title?: string; dependsOn?: number[] }> }
    if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) return nodesFromPlanText(planText)
    return parsed.nodes
      .filter(n => n.title && n.title.trim().length >= 3)
      .slice(0, 8)
      .map(n => ({
        title: n.title!.trim().slice(0, 120),
        dependsOn: (n.dependsOn ?? []).filter(d => typeof d === "number" && d >= 1).slice(0, 5),
      }))
  } catch {
    return nodesFromPlanText(planText)
  }
}

// ── Dynamic mutation (model can adjust plan at runtime) ──

/** Find the next available node ID. */
function nextNodeId(plan: MasterPlan): string {
  const used = plan.nodes.map(n => parseInt(n.id, 10)).filter(n => !isNaN(n))
  return String(used.length > 0 ? Math.max(...used) + 1 : 1)
}

/** Add a new node to the plan. Model triggers this when discovering new requirements. */
export function addNode(plan: MasterPlan, title: string, dependsOn: string[] = [], afterId?: string): PlanNode {
  const id = nextNodeId(plan)
  const node = createPlanNodeFromTitle({
    id,
    title,
    status: "pending",
    goal: plan.goal,
    intent: plan.intent,
    dependsOn,
    context: contextAttachmentFromPlan(plan),
  })
  // Insert after the specified node
  const idx = afterId ? plan.nodes.findIndex(n => n.id === afterId) : -1
  if (idx >= 0 && idx < plan.nodes.length - 1) {
    plan.nodes.splice(idx + 1, 0, node)
  } else {
    plan.nodes.push(node)
  }
  plan.updatedAt = Date.now()
  refreshPlanValidation(plan)
  return node
}

/** Remove a node that turned out to be unnecessary. */
export function removeNode(plan: MasterPlan, nodeId: string, reason: string): boolean {
  const idx = plan.nodes.findIndex(n => n.id === nodeId)
  if (idx < 0) return false
  const node = plan.nodes[idx]!
  if (node.status === "done") return false // can't remove completed nodes
  plan.nodes.splice(idx, 1)
  // If we removed the current node, activate the next one
  if (plan.current === nodeId) {
    const next = plan.nodes.find(n => n.status === "pending")
    if (next) activateNode(plan, next.id)
    else plan.current = ""
  }
  plan.updatedAt = Date.now()
  refreshPlanValidation(plan)
  return true
}

/** Skip a node (not needed, but keep it visible in the plan). */
export function skipNode(plan: MasterPlan, nodeId: string, reason: string): boolean {
  const node = plan.nodes.find(n => n.id === nodeId)
  if (!node || node.status === "done") return false
  node.status = "skipped"
  node.evidence = reason
  if (plan.current === nodeId) {
    const next = plan.nodes.find(n => n.status === "pending")
    if (next) activateNode(plan, next.id)
    else plan.current = ""
  }
  plan.updatedAt = Date.now()
  refreshPlanValidation(plan)
  return true
}

// ── Node lifecycle ──

export function activateNode(plan: MasterPlan, nodeId: string): PlanNode | null {
  const node = plan.nodes.find(n => n.id === nodeId)
  if (!node || node.status === "done" || node.status === "skipped") return null

  // Check dependencies
  for (const depId of node.dependsOn) {
    const dep = plan.nodes.find(n => n.id === depId)
    if (dep && dep.status !== "done" && dep.status !== "skipped") {
      return null // dependency not satisfied
    }
  }

  // Deactivate current, activate new
  const prev = plan.nodes.find(n => n.id === plan.current)
  if (prev && prev.id !== nodeId) {
    prev.status = prev.status === "active" ? "pending" : prev.status
  }

  node.status = "active"
  plan.current = nodeId
  plan.updatedAt = Date.now()
  return node
}

export function markNodeDone(plan: MasterPlan, nodeId: string, evidence?: string): void {
  const node = plan.nodes.find(n => n.id === nodeId)
  if (!node) return
  node.status = "done"
  node.evidence = evidence
  plan.updatedAt = Date.now()
}

export function markNodeBlocked(plan: MasterPlan, nodeId: string, reason: string): void {
  const node = plan.nodes.find(n => n.id === nodeId)
  if (!node) return
  node.status = "blocked"
  node.evidence = reason
  plan.updatedAt = Date.now()
}

export function currentNode(plan: MasterPlan): PlanNode | undefined {
  return plan.nodes.find(n => n.id === plan.current)
}

export function planComplete(plan: MasterPlan): boolean {
  return plan.nodes.every(n => n.status === "done" || n.status === "skipped")
}

export function planProgress(plan: MasterPlan): string {
  const done = plan.nodes.filter(n => n.status === "done" || n.status === "skipped").length
  return `${done}/${plan.nodes.length} 节点完成`
}

// ── Review gate — MiMo's TaskGate.decide() pattern ──

export interface PlanReview {
  /** OK to proceed to next node */
  resume: boolean
  /** Text to inject for the model: either review prompt or next-node prompt */
  promptText: string
  /** How many unfinished nodes remain */
  remaining: number
}

/**
 * Called when a node's sub-tracker signals completion.
 * Forces the model to review the master plan before moving on.
 */
export function buildNodeReviewGate(plan: MasterPlan, justCompletedNodeId: string): PlanReview {
  const justDone = plan.nodes.find(n => n.id === justCompletedNodeId)
  const remaining = plan.nodes.filter(n => n.status === "pending" || n.status === "blocked")
  const next = remaining.find(n => n.status === "pending")

  if (planComplete(plan)) {
    return {
      resume: true,
      promptText: formatPlanComplete(),
      remaining: 0,
    }
  }

  if (next) {
    // Auto-activate next pending node
    activateNode(plan, next.id)
    return {
      resume: true,
      promptText: formatNextNodePrompt(plan, justDone, next),
      remaining: remaining.length,
    }
  }

  // All remaining are blocked — review and decide
  return {
    resume: false,
    promptText: formatBlockedReview(plan),
    remaining: remaining.length,
  }
}

// ── Format functions (injectable as user messages in loop.ts) ──

function formatPlanComplete(): string {
  return [
    "## 🎉 主计划全部完成",
    "所有节点状态：",
    "## External Completion Gate",
    "主计划节点全部标记为 done 或 skipped。",
    "现在请运行最终验证，然后提供完整的交付报告。",
  ].join("\n")
}

function formatNextNodePrompt(plan: MasterPlan, justDone: PlanNode | undefined, next: PlanNode): string {
  const lines = [
    "## ✅ 节点完成 → 回顾主计划",
    "",
    `刚完成: **${justDone?.title ?? "?"}**${justDone?.evidence ? ` — ${justDone.evidence}` : ""}`,
    `下一个: **${next.id}. ${next.title}** (已自动激活)`,
    "",
    "### 主计划状态",
    ...plan.nodes.map(n => {
      const icon = STATUS_ICONS[n.status]
      const marker = n.id === plan.current ? " ← 当前" : ""
      return `${icon} **${n.id}. ${n.title}**${marker}${n.evidence ? ` — ${n.evidence}` : ""}`
    }),
    "",
    `进度: ${planProgress(plan)}`,
    "",
    next.dependsOn.length > 0
      ? `**注意**: 节点 ${next.id} 依赖节点 [${next.dependsOn.join(", ")}] — 已全部完成 ✅`
      : "",
    "",
    "继续执行当前节点 ${next.id}. ${next.title}。先读取相关文件，然后按子追踪步骤逐一完成。",
  ].filter(Boolean).join("\n")

  // Replace the template literal in the actual text
  return lines.replace("${next.id}", next.id).replace("${next.title}", next.title)
}

function formatBlockedReview(plan: MasterPlan): string {
  const blocked = plan.nodes.filter(n => n.status === "blocked")
  const pending = plan.nodes.filter(n => n.status === "pending")

  return [
    "## ⚠️ 主计划审查 — 阻塞节点",
    "",
    "### 被阻塞",
    ...blocked.map(n => `🟡 **${n.id}. ${n.title}**: ${n.evidence ?? "原因未知"}`),
    "",
    "### 待执行",
    ...pending.map(n => `🔵 **${n.id}. ${n.title}**`),
    "",
    "所有待执行节点无法激活（依赖未满足或被阻塞）。",
    "请判断: 1) 阻塞原因是否已消除？2) 是否需要跳过阻塞节点？3) 主计划是否需要调整？",
    "做出判断后，调用 task 工具标记节点状态，然后继续。",
  ].join("\n")
}

// ── Dependency management (Claude Code-style bidirectional edges) ──

/** Set a bidirectional dependency edge: fromId blocks toId. */
export function blockTask(plan: MasterPlan, fromId: string, toId: string): void {
  const from = plan.nodes.find(n => n.id === fromId)
  const to = plan.nodes.find(n => n.id === toId)
  if (!from || !to) return
  if (!from.blockedBy.includes(toId)) from.blockedBy.push(toId)
  if (!to.dependsOn.includes(fromId)) to.dependsOn.push(fromId)
  plan.updatedAt = Date.now()
  refreshPlanValidation(plan)
}

/** Find blocked nodes whose dependencies are now satisfied. Lazy evaluation at claim time. */
export function findUnblockedNodes(plan: MasterPlan): PlanNode[] {
  const doneIds = new Set(plan.nodes.filter(n => n.status === "done" || n.status === "skipped").map(n => n.id))
  return plan.nodes.filter(n => {
    if (n.status !== "blocked") return false
    return n.dependsOn.every(depId => doneIds.has(depId))
  })
}

/** Auto-unblock nodes when their dependencies complete. Returns count of unlocked nodes. */
export function autoUnblockByRipple(plan: MasterPlan): number {
  const unblocked = findUnblockedNodes(plan)
  for (const node of unblocked) {
    node.status = "pending"
    node.evidence = "Upllstream dependency completed"
    node.reactCount = 0
  }
  if (unblocked.length > 0) plan.updatedAt = Date.now()
  return unblocked.length
}

// ── Revise plan: full replanning (P0-2) ──

export const MAX_PLAN_REVISIONS = 3

export interface RevisePlanInput {
  plan: MasterPlan
  trigger: "judge_rejected" | "nodes_exhausted" | "user_changed" | "plan_stale"
  context?: string
  judgeCritique?: string
  newRequirements?: string
  streamChat: (system: string, prompt: string) => AsyncGenerator<{ type: string; data?: unknown }>
}

export interface RevisePlanResult {
  plan: MasterPlan
  frozenNodes: number
  newNodes: number
  changed: boolean
  log: string
}

/**
 * Full plan revision.
 * Triggered when: PlanJudge rejects, >=2 nodes exhaust retries, user changes direction, or plan is stale.
 */
export async function revisePlan(input: RevisePlanInput): Promise<RevisePlanResult> {
  const { plan, trigger, context, judgeCritique, newRequirements, streamChat } = input
  const packetContext = contextAttachmentFromPlan(plan)
  const frozenNodes = plan.nodes.filter(n => n.status === "done" || n.status === "skipped")
  const remainingNodes = plan.nodes.filter(n => n.status !== "done" && n.status !== "skipped")

  if (remainingNodes.length === 0) {
    return { plan, frozenNodes: frozenNodes.length, newNodes: 0, changed: false, log: "No remaining nodes to revise." }
  }

  const lines = [
    "## Regenerate task plan",
    `Reason: ${trigger}`,
    "",
    "### Completed nodes (frozen)",
    ...frozenNodes.map(n => "- [OK] [" + n.id + "] " + n.title),
    "",
    "### Remaining work",
    ...remainingNodes.map(n => "- [" + (n.status === "blocked" ? "BLOCKED" : "PENDING") + "] [" + n.id + "] " + n.title + " (retries: " + n.reactCount + ")" + (n.evidence ? " - " + n.evidence : "")),
    "",
  ]

  if (judgeCritique) { lines.push("### Judge critique", judgeCritique, "") }
  if (newRequirements) { lines.push("### New requirements", newRequirements, "") }
  if (context) { lines.push("### Project context", context, "") }

  lines.push(
    "Generate new task nodes to replace the remaining work above.",
    "Preserve completed nodes unchanged. New nodes continue from where completed nodes left off.",
    "",
    "Output strict JSON:",
    '{"nodes": [{"title": "...", "dependsOn": [1,2]}, ...]}',
    "- dependsOn may reference completed node IDs",
    "- Use Chinese, node titles <=60 chars",
  )

  const prompt = lines.join("\n")

  try {
    const chunks: string[] = []
    for await (const event of streamChat("You are a task re-planner. Output pure JSON.", prompt)) {
      if (event.type === "text" && typeof event.data === "string") chunks.push(event.data)
    }
    const text = chunks.join("").trim()
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return failRevision(plan, frozenNodes, "Flash parse failed")

    const parsed = JSON.parse(jsonMatch[0]) as { nodes?: Array<{ title?: string; dependsOn?: number[] }> }
    if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) return failRevision(plan, frozenNodes, "Empty node list")

    const newPlan: MasterPlan = {
      goal: plan.goal,
      intent: plan.intent,
      nodes: frozenNodes.map(n => ({ ...n })),
      current: "",
      createdAt: plan.createdAt,
      updatedAt: Date.now(),
    }

    const maxFrozenId = frozenNodes.length > 0
      ? Math.max(...frozenNodes.map(n => parseInt(n.id, 10)).filter(n => !isNaN(n)))
      : 0

    const newNodes = parsed.nodes
      .filter(n => n.title && n.title.trim().length >= 3)
      .slice(0, 8)
      .map((n, i) => {
        const id = String(maxFrozenId + i + 1)
        const dependsOn = (n.dependsOn ?? [])
          .filter(d => typeof d === "number" && d >= 1)
          .map(d => String(d))
          .slice(0, 5)
        return createPlanNodeFromTitle({
          id,
          title: n.title!.trim().slice(0, 120),
          status: "pending" as PlanNodeStatus,
          goal: plan.goal,
          intent: plan.intent,
          dependsOn,
          context: packetContext,
        })
      })

    newPlan.nodes.push(...newNodes)
    const firstPending = newPlan.nodes.find(n => n.status === "pending")
    if (firstPending) { firstPending.status = "active"; newPlan.current = firstPending.id }
    refreshPlanValidation(newPlan)

    return {
      plan: newPlan,
      frozenNodes: frozenNodes.length,
      newNodes: newNodes.length,
      changed: true,
      log: "Plan revised: " + trigger + ". " + frozenNodes.length + " frozen, " + newNodes.length + " new.",
    }
  } catch (e) {
    return failRevision(plan, frozenNodes, "Revision failed: " + (e instanceof Error ? e.message : String(e)))
  }
}

function failRevision(plan: MasterPlan, frozenNodes: PlanNode[], reason: string): RevisePlanResult {
  return { plan, frozenNodes: frozenNodes.length, newNodes: 0, changed: false, log: reason }
}

// ── Plan context for L1 cold memory ──

export function formatPlanContext(plan: MasterPlan): string {
  return [
    "### 主计划",
    `**目标**: ${plan.goal}`,
    `**进度**: ${planProgress(plan)}`,
    "",
    ...plan.nodes.map(n => {
      const icon = STATUS_ICONS[n.status]
      const subStatus = n.tracker ? ` [子任务: ${formatTaskTrackerStatus(n.tracker)}]` : ""
      return `${icon} **${n.id}. ${n.title}**${subStatus}`
    }),
  ].join("\n")
}

// ── Global plan reference (shared between tool execution in cli.ts and loop.ts) ──

export const planRef: { current: MasterPlan | null } = { current: null }

// ── Serialization for session persistence ──

export function serializePlan(plan: MasterPlan): Record<string, unknown> {
  return {
    goal: plan.goal,
    intent: plan.intent,
    current: plan.current,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    nodes: plan.nodes.map(n => ({
      id: n.id,
      title: n.title,
      status: n.status,
      dependsOn: n.dependsOn,
      evidence: n.evidence,
      reactCount: n.reactCount,
      packet: n._packet ? {
        taskId: n._packet.taskId,
        nodeId: n._packet.nodeId,
        contextMapId: n._packet.contextMapId,
        requiredContextEvidence: n._packet.requiredContextEvidence,
        scope: n._packet.scope,
        doneCriteria: n._packet.doneCriteria,
        verification: n._packet.verification,
        ripplePolicy: n._packet.ripplePolicy,
        contextBudget: n._packet.contextBudget,
      } : null,
    })),
    validation: plan._lastValidation,
  }
}
