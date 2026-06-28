import type { ToolDescriptor } from "../../tools/registry"
import { evaluatePlanningArtifact, formatPlanningBlockedToolResult } from "../planning-gate"
import { PermissionGate } from "../permission"
import { inferToolCategory, type ToolCategory } from "../permission"
import type { TaskTracker } from "../task-tracker"
import type { RippleObligation } from "../../ripple/obligations"
import { enforceModeTools, type ModeContract } from "../mode-contract"
import { getToolRisk, isHighRisk, formatRiskBlockMessage } from "../tool-risk"

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
      source: "rate_limit",
      priority: 1,
    }
  }

  // Gate 2: PermissionGate — deny always hard-blocks; ask may be auto-allowed in full mode.
  // PR-5.1: riskLevel passed to block session allow() overrides for Risk 4-5 tools.
  const risk = tool ? getToolRisk(toolCall.name, toolCall.input, tool) : null
  if (tool) {
    const perm = permissionGate.check(toolCall.name, toolCall.input, tool, { riskLevel: risk?.level })
    if (!perm.allowed) {
      const isFullModeAsk = perm.level === "ask" && permissionMode === "full"
      if (!isFullModeAsk) {
        // Hard block (deny or ask in strict mode)
        const blockMsg = risk && isHighRisk(risk.level)
          ? formatRiskBlockMessage(toolCall.name, risk, toolCall.input)
          : PermissionGate.formatBlockedMessage(toolCall.name, perm, toolCall.input)
        return {
          allowed: false,
          reason: `permission:${perm.level}`,
          blockMessage: blockMsg,
          category: cat,
          incrementRateLimit: cat,
          source: `permission:${perm.level}`,
          priority: 2,
        }
      }
      // full mode: ask is promoted to allow for Risk 0-3.
      // Risk 4-5 promotion is rejected by a later gate (Gate 8).
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
      source: "readonly_intent",
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
      source: "ripple_block",
      priority: 4,
    }
  }

  // Gate 5: Planning phase — block writes before plan accepted
  if (tool && taskTracker?.phase === "planning" && !tool.defn.isReadonly) {
    const planningGate = evaluatePlanningArtifact(finalText, taskTracker)
    const blockMessage = planningGate.ok
      ? `任务追踪已阻止：长任务必须先完成规划回合，规划阶段不允许在同一轮调用 ${toolCall.name}。下一轮将进入执行阶段。`
      : formatPlanningBlockedToolResult(planningGate)
    return {
      allowed: false,
      reason: "planning_phase",
      blockMessage,
      category: cat,
      incrementRateLimit: cat,
      source: "planning_phase",
      priority: 5,
    }
  }

  // Gate 6: ContextReadiness blocks writes before enough project context exists.
  if (tool && input.contextReadinessBlocked && !tool.defn.isReadonly) {
    const blockers = input.contextReadinessBlockers?.length
      ? input.contextReadinessBlockers.join("; ")
      : "ContextMap readiness is incomplete."
    return {
      allowed: false,
      reason: "context_readiness",
      blockMessage: `ContextReadiness gate blocked ${toolCall.name}: ${blockers} Continue with readonly locate/read/search work before editing.`,
      category: cat,
      incrementRateLimit: cat,
      source: "context_readiness",
      priority: 6,
    }
  }

  // Gate 7: Web search failure
  if (tool && toolCall.name === "web_search" && webSearchFailedThisTurn) {
    return {
      allowed: false,
      reason: "web_search_failed",
      blockMessage: `⚠️ 网页搜索不可用：${webSearchFailReason || "SearXNG Docker 未运行"}。\n\n解决方案（你来决定）：\n1) 启动 SearXNG Docker 容器修复搜索\n2) 用 web_fetch 直接访问已知 URL\n3) 用本地代码搜索 (findstr / grep) 代替\n4) 向用户报告搜索不可用，继续现有的本地分析`,
      category: cat,
      incrementRateLimit: cat,
      source: "web_search_failed",
      priority: 7,
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
        source: "mode_contract",
        priority: 7,
      }
    }
  }

  // Gate 8: ToolRisk — Risk 4-5 tools require per-invocation confirmation.
  // This gate fires LAST so more specific gates (readonly, ripple, planning,
  // context_readiness, mode_contract) take priority in their blocking reasons.
  // Only applies in "full" permission mode where ask→allow promotion happens.
  if (tool && risk && isHighRisk(risk.level) && permissionMode === "full") {
    return {
      allowed: false,
      reason: `tool_risk:${risk.level}`,
      blockMessage: formatRiskBlockMessage(toolCall.name, risk, toolCall.input),
      category: cat,
      incrementRateLimit: cat,
      source: `tool_risk:${risk.level}`,
      priority: 8,
    }
  }

  // All gates passed
  return {
    allowed: true,
    category: cat,
    incrementRateLimit: cat,
  }
}
