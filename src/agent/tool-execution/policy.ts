import type { ToolDescriptor } from "../../tools/registry"
import { evaluatePlanningArtifact, formatPlanningBlockedToolResult } from "../planning-gate"
import { PermissionGate } from "../permission"
import { inferToolCategory, type ToolCategory } from "../permission"
import type { TaskTracker } from "../task-tracker"
import type { RippleObligation } from "../../ripple/obligations"
import { enforceModeTools, type ModeContract } from "../mode-contract"
import { getToolRisk } from "../tool-risk"
// RT-5: the gate chain is factored into policy modules (single execution
// order, shared by loop and node runtime — no per-path safety bypasses).
import { formatRiskBlockMessage, highRiskConfirmationGate, isHighRisk } from "../../harness/capabilities/policy/risk-policy"
import { approvalDecision } from "../../harness/capabilities/policy/approval-policy"
import { networkToolBlocked } from "../../harness/capabilities/policy/network-policy"
import { checkWritePaths } from "../../harness/capabilities/policy/writable-root-policy"

// ── Types ──

export interface ToolPolicyInput {
  toolCall: { id: string; name: string; input: Record<string, unknown> }
  tool: ToolDescriptor | undefined
  intentPolicy: { mode: string; reason: string }
  taskTracker: ReturnType<typeof import("../task-tracker").createTaskTracker> | null
  rippleBlockActive: boolean
  pendingRippleObligations: RippleObligation[]
  permissionGate: PermissionGate
  permissionMode: "full" | "strict"
  rateLimits: Record<ToolCategory, number>
  webSearchFailedThisTurn: boolean
  webSearchFailReason: string
  finalText: string
  /** ContextReadiness gate: block writes until enough context has been acquired. */
  contextReadinessBlocked?: boolean
  contextReadinessBlockers?: string[]
  /** PR 8: active mode contract for tool enforcement. */
  modeContract?: ModeContract
  /** RT-5: writable roots for path-boundary enforcement (node mode passes
   *  the run scope's [projectRoot]; loop mode omits it → gate skipped). */
  projectRoot?: string
  writableRoots?: string[]
}

export interface ToolPolicyBlocked {
  allowed: false
  reason: string
  blockMessage: string
  category: ToolCategory
  incrementRateLimit: ToolCategory
  /** PR-5.2: which gate blocked the call (e.g. "rate_limit", "tool_risk:4") */
  source: string
  /** PR-5.2: gate priority within the chain (1-8) */
  priority: number
}

export interface ToolPolicyAllowed {
  allowed: true
  category: ToolCategory
  incrementRateLimit: ToolCategory
}

export type ToolPolicyResult = ToolPolicyBlocked | ToolPolicyAllowed

// ── Constants ──

const RATE_CAPS: Record<ToolCategory, number> = {
  safe: Infinity,
  shell: 5,
  file: 10,
  network: 3,
  git: Infinity,
}

// ── Policy evaluation ──

/**
 * Evaluate whether a tool call should be allowed to execute.
 * Pure function — does not mutate state or execute tools.
 * All policy decisions are centralized here so no gate can be bypassed by ordering.
 */
export function evaluateToolPolicy(input: ToolPolicyInput): ToolPolicyResult {
  const { toolCall, tool, intentPolicy, taskTracker, rippleBlockActive, pendingRippleObligations, permissionGate, permissionMode, rateLimits, webSearchFailedThisTurn, webSearchFailReason, finalText } = input
  const cat = inferToolCategory(toolCall.name, tool)

  // Gate 1: Rate limit
  const cap = RATE_CAPS[cat]
  const currentCount = rateLimits[cat]
  if (currentCount >= cap) {
    return {
      allowed: false,
      reason: "rate_limit",
      blockMessage: `频率限制：本回合 ${cat} 工具已达上限 (${currentCount}/${cap})。请在下一回合继续。`,
      category: cat,
      incrementRateLimit: cat,
      source: "policy:rate_limit",
      priority: 1,
    }
  }

  // Gate 2: PermissionGate — deny always hard-blocks; ask may be auto-allowed in full mode.
  // PR-5.1: riskLevel passed to block session allow() overrides for Risk 4-5 tools.
  // Harness Closure R1: node mode evaluates with a real name even when no tool
  // descriptor is resolved — the gate then falls back to category inference so
  // unknown write-class capabilities fail closed (strict ask) instead of
  // passing through unexamined. The loop always passes a tool, so this branch
  // is byte-identical there.
  // RT-5: the ask→allow promotion rule lives in approval-policy.
  const risk = tool ? getToolRisk(toolCall.name, toolCall.input, tool) : null
  if (tool || toolCall.name !== "unknown") {
    const perm = permissionGate.check(toolCall.name, toolCall.input, tool, { riskLevel: risk?.level })
    if (!perm.allowed) {
      const decision = approvalDecision({
        gateLevel: perm.level,
        permissionMode,
        riskLevel: risk?.level ?? 0,
      })
      if (!decision.allowed) {
        // Hard block (deny, or ask in strict mode) — high-risk denials carry
        // the enriched risk message (existing behavior).
        const blockMsg = risk && isHighRisk(risk.level)
          ? formatRiskBlockMessage(toolCall.name, risk, toolCall.input)
          : PermissionGate.formatBlockedMessage(toolCall.name, perm, toolCall.input)
        return {
          allowed: false,
          reason: decision.reason ?? `permission:${perm.level}`,
          blockMessage: blockMsg,
          category: cat,
          incrementRateLimit: cat,
          source: `policy:permission:${perm.level}`,
          priority: 2,
        }
      }
      // full mode: ask is promoted to allow for Risk 0-3.
      // Risk 4-5 promotion is rejected by a later gate (Gate 8).
    }
  }

  // Gate 2.5 (RT-5): writable-root boundary — write-style calls whose paths
  // escape the declared writable roots are rejected here, BEFORE any handler
  // runs. Single shared boundary for file/patch/git writers (node mode passes
  // writableRoots; loop mode omits them → this gate is skipped, unchanged).
  if (input.projectRoot && tool && !tool.defn.isReadonly) {
    const rootCheck = checkWritePaths(toolCall.input, {
      projectRoot: input.projectRoot,
      writableRoots: input.writableRoots,
    })
    if (rootCheck && !rootCheck.allowed) {
      return {
        allowed: false,
        reason: "writable_root",
        blockMessage: `写路径边界已阻止：${rootCheck.reason ?? "path outside writable roots"}`,
        category: cat,
        incrementRateLimit: cat,
        source: "policy:writable_root",
        priority: 2,
      }
    }
  }

  // Gate 3: Readonly intent — block write tools
  if (tool && intentPolicy.mode === "readonly" && !tool.defn.isReadonly) {
    return {
      allowed: false,
      reason: "readonly_intent",
      blockMessage: `意图门已阻止：当前请求是只读模式（${intentPolicy.reason}），不允许调用 ${toolCall.name}。请让用户明确要求执行后再写入或运行命令。`,
      category: cat,
      incrementRateLimit: cat,
      source: "policy:readonly_intent",
      priority: 3,
    }
  }

  // Gate 4: Ripple block — pending obligations block writes
  if (tool && rippleBlockActive && !tool.defn.isReadonly) {
    return {
      allowed: false,
      reason: "ripple_block",
      blockMessage: `涟漪阻止：存在 ${pendingRippleObligations.length} 个未解决的调用方需要级联更新。请先用 multi_edit 完成所有受影响的调用方修改，然后再写新文件。`,
      category: cat,
      incrementRateLimit: cat,
      source: "policy:ripple_block",
      priority: 4,
    }
  }

  // IC05 P3: planning phase 与 ContextReadiness 不再拥有写拒绝权。
  //  - planning_phase：planning 是 artifact/advisory，不是 execution
  //    authorization（PLANNING_PHASE_WRITE_DENY=0）。planning 状态只影响
  //    status/prompt/advisory。
  //  - context_readiness：advisory gate，blockers 已降级为 ContextDebt
  //    (obligation)（CONTEXT_READINESS_TOOL_POLICY_DENY=0）。
  //  input.contextReadinessBlocked 字段保留兼容（恒 false），不再产生
  //  allowed=false / reason="context_readiness"。

  // Gate 7: Web search failure (RT-5: network-policy owns the boundary)
  const networkGate = networkToolBlocked(toolCall.name, webSearchFailedThisTurn, webSearchFailReason)
  if (networkGate) {
    return {
      allowed: false,
      reason: networkGate.reason,
      blockMessage: networkGate.blockMessage,
      category: cat,
      incrementRateLimit: cat,
      source: "policy:web_search_failed",
      priority: networkGate.priority,
    }
  }

  // Gate 7: ModeContract — enforce allowedTools/forbiddenTools (PR 8)
  if (input.modeContract) {
    const modeCheck = enforceModeTools(input.modeContract, toolCall.name)
    if (!modeCheck.allowed) {
      return {
        allowed: false,
        reason: "mode_contract",
        blockMessage: modeCheck.reason,
        category: cat,
        incrementRateLimit: cat,
        source: "policy:mode_contract",
        priority: 7,
      }
    }
  }

  // Gate 8: ToolRisk — Risk 4-5 tools require per-invocation confirmation.
  // This gate fires LAST so more specific gates (readonly, ripple, planning,
  // context_readiness, mode_contract) take priority in their blocking reasons.
  // Only applies in "full" permission mode where ask→allow promotion happens.
  // RT-5: the gate logic lives in risk-policy.
  const riskGate = highRiskConfirmationGate(tool, toolCall.input, permissionMode)
  if (riskGate) {
    return {
      allowed: false,
      reason: riskGate.reason,
      blockMessage: riskGate.blockMessage,
      category: cat,
      incrementRateLimit: cat,
      source: `policy:tool_risk:${riskGate.riskLevel}`,
      priority: riskGate.priority,
    }
  }

  // All gates passed
  return {
    allowed: true,
    category: cat,
    incrementRateLimit: cat,
  }
}
