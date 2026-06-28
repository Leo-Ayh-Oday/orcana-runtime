/** Flash Triage — semantic task classification at the entrance gate.
 *
 *  Replaces 4 keyword-based regex classifiers with 1 Flash model call:
 *    classifyIntent + classifyResearchRoute + activateSkills + createTaskTracker
 *
 *  Design:
 *    - Single call per session (circuit breaker)
 *    - 8s timeout
 *    - JSON structured output with text fallback
 *    - On failure → keyword fallback (no worse than current behavior)
 *    - Pattern copied from FlashJudge (circuit breaker + JSON parsing + graceful degradation)
 */

import type { LLMProvider, ProviderMessage } from "../provider/types"
import { shouldSkipProviderPurpose } from "../provider/cost-policy"
import type { IntentMode } from "./intent"
import type { TaskIntent, TaskStep } from "./task-tracker"
import type { VerificationKind } from "../verification/result"

// ── Triage result ──

export interface FlashTriageResult {
  mode: "discussion" | "narrow_edit" | "plan_before_code" | "full_complex"
  needsWeb: boolean
  researchQueries: string[]
  relevantSkillNames: string[]
  planSteps: Array<{ id: string; title: string; deliverables: string[]; verification: string }>
  requiredVerification: string[]
  reasoning: string
  riskLevel: "low" | "medium" | "high"
}

// ── Config ──

const TRIAGE_MODEL = "deepseek-v4-flash"
const TRIAGE_MAX_TOKENS = 512
const TRIAGE_TIMEOUT_MS = 8000

export type FlashTriagePolicy = "off" | "auto" | "always"

export function resolveFlashTriagePolicy(value = process.env.DEEPSEEK_FLASH_TRIAGE): FlashTriagePolicy {
  const normalized = String(value ?? "auto").trim().toLowerCase()
  if (normalized === "1" || normalized === "true" || normalized === "on" || normalized === "always") return "always"
  if (normalized === "0" || normalized === "false" || normalized === "off") return "off"
  if (normalized === "auto") return "auto"
  return "auto"
}

export function shouldUseFlashTriage(policy: FlashTriagePolicy, prompt: string, projectContext = ""): boolean {
  if (policy === "always") return true
  if (policy === "off") return false

  // auto: semantic triage for every prompt with meaningful content.
  // Skip only trivial single-word continuations to avoid wasted API calls.
  const trimmed = prompt.trim()
  if (/^(?:好|好的|嗯|行|可以|是|对|yes|ok|okay|继续|go\s+on|next|确认|明白了|知道了|请继续|继续吧)\s*$/i.test(trimmed)) return false
  if (trimmed.length < 8 && !projectContext) return false

  return true
}

// ── Prompt builder ──

function buildTriagePrompt(prompt: string, projectFiles: string): string {
  const lines = [
    "你是任务分诊器。分析用户的编程请求，判断应该走什么执行路径。",
    "",
    "## 用户请求",
    prompt.slice(0, 1000),
    "",
    "## 项目上下文（文件树前 100 行）",
    projectFiles.slice(0, 2000) || "(空项目或未扫描)",
    "",
    "## 判断标准",
    "",
    "### mode（任务模式）",
    "- discussion — 纯讨论/分析/方案设计，不需要写代码",
    "- narrow_edit — 单文件修改/修复，不需要规划",
    "- plan_before_code — 需要先出方案再动手（跨文件、架构变更、技术选型）",
    "- full_complex — 完整项目/多模块/全栈/需要测试覆盖",
    "",
    "### needsWeb",
    "需要联网搜索最新文档/API 才能完成吗？true/false",
    "",
    "### researchQueries",
    "如果 needsWeb=true，列出 2-3 个搜索词。否则空数组",
    "",
    "### relevantSkillNames",
    "从以下列表中选择最相关的 1-3 个技能（按名匹配）：",
    "- design-quality: 前端设计质量标准，防止「能跑就行」",
    "- architecture-review: 强制对比替代方案+trade-off分析+风险标注",
    "- self-critique: 输出前推演反方观点+重建论证",
    "- edge-case-hunter: 穷举边界/异常/并发/资源约束",
    "- security-deep-dive: OWASP Top 10+供应链+注入检测",
    "- systematic-debugging: 根因追踪+条件断点+假设验证",
    "如果都不匹配，返回空数组",
    "",
    "### planSteps（仅 plan_before_code 或 full_complex 需要）",
    "列出执行步骤。每步：id(kebab), title(≤20字), deliverables(文件列表), verification(验证方式)。2-6 步",
    "其他 mode 返回空数组",
    "",
    "### requiredVerification",
    "需要的验证种类：typecheck/test/build/smoke。narrow_edit 通常只需 typecheck",
    "",
    "### riskLevel",
    "任务风险评级 low/medium/high — 考虑复杂度、安全影响、数据风险",
    "",
    "## 输出格式",
    "严格输出 JSON，不要其他文字：",
    '{',
    '  "mode": "...",',
    '  "needsWeb": false,',
    '  "researchQueries": [],',
    '  "relevantSkillNames": [],',
    '  "planSteps": [],',
    '  "requiredVerification": [],',
    '  "reasoning": "...",',
    '  "riskLevel": "..."',
    '}',
  ]
  return lines.join("\n")
}

// ── Response parser ──

function parseTriageResponse(text: string): FlashTriageResult | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null

  try {
    const obj = JSON.parse(jsonMatch[0])
    const mode = validateMode(String(obj.mode ?? ""))
    return {
      mode,
      needsWeb: obj.needsWeb === true,
      researchQueries: Array.isArray(obj.researchQueries) ? obj.researchQueries.slice(0, 5).filter(Boolean) : [],
      relevantSkillNames: Array.isArray(obj.relevantSkillNames) ? obj.relevantSkillNames.slice(0, 3).filter(Boolean) : [],
      planSteps: (mode === "plan_before_code" || mode === "full_complex") && Array.isArray(obj.planSteps)
        ? obj.planSteps.slice(0, 8).filter((s: unknown) => typeof (s as Record<string, unknown>).title === "string").map((s: Record<string, unknown>, i: number) => ({
            id: String(s.id ?? `step-${i + 1}`),
            title: String(s.title ?? "").slice(0, 30),
            deliverables: Array.isArray(s.deliverables) ? s.deliverables.slice(0, 8).filter(Boolean) : [],
            verification: String(s.verification ?? "typecheck"),
          }))
        : [],
      requiredVerification: Array.isArray(obj.requiredVerification)
        ? obj.requiredVerification.filter((v: unknown) => /^(typecheck|test|build|smoke|lint)$/.test(String(v))).slice(0, 4)
        : [],
      reasoning: String(obj.reasoning ?? "").slice(0, 200),
      riskLevel: validateRisk(String(obj.riskLevel ?? "low")),
    }
  } catch {
    return null
  }
}

function validateMode(raw: string): FlashTriageResult["mode"] {
  if (raw.includes("full_complex") || raw.includes("全栈") || raw.includes("完整项目")) return "full_complex"
  if (raw.includes("plan_before_code") || raw.includes("方案") || raw.includes("规划") || raw.includes("先规划")) return "plan_before_code"
  if (raw.includes("discussion") || raw.includes("讨论") || raw.includes("分析") || raw.includes("评估")) return "discussion"
  return "narrow_edit"
}

function validateRisk(raw: string): FlashTriageResult["riskLevel"] {
  const r = raw.toLowerCase()
  if (r.includes("high") || r.includes("高")) return "high"
  if (r.includes("medium") || r.includes("中")) return "medium"
  return "low"
}

// ── Circuit breaker ──

class TriageCircuitBreaker {
  private fired = false
  get isOpen() { return this.fired }
  trip() { this.fired = true }
  reset() { this.fired = false }
}

// ── Main class ──

/** Known skill names → translations for fallback activation. */
const SKILL_TRIGGER_MAP: Record<string, string[]> = {
  "design-quality": ["前端", "UI", "设计", "界面", "页面", "组件", "CSS", "样式"],
  "architecture-review": ["架构", "重构", "设计模式", "系统设计", "选型"],
  "self-critique": ["审查", "检查", "推翻", "反驳", "漏洞", "审计"],
  "edge-case-hunter": ["边界", "测试", "异常", "空值", "并发", "corner"],
  "security-deep-dive": ["安全", "auth", "token", "密码", "注入", "XSS", "认证"],
  "systematic-debugging": ["bug", "调试", "报错", "error", "崩溃", "不工作"],
}

export class FlashTriage {
  private provider: LLMProvider
  private breaker = new TriageCircuitBreaker()
  private triageModel: string

  constructor(provider: LLMProvider, triageModel = TRIAGE_MODEL) {
    this.provider = provider
    this.triageModel = triageModel
  }

  /** Reset for a new session. */
  reset(): void { this.breaker.reset() }

  /**
   * Classify the user's request.
   * On success: returns FlashTriageResult
   * On failure: returns null (caller falls back to keyword classifiers)
   */
  async triage(prompt: string, projectContext = ""): Promise<FlashTriageResult | null> {
    if (this.breaker.isOpen) return null
    if (shouldSkipProviderPurpose("flash_triage")) return null
    this.breaker.trip()

    const system = "你是任务分诊器。只输出 JSON，不做其他解释。"
    const userPrompt = buildTriagePrompt(prompt, projectContext)
    const messages: ProviderMessage[] = [{ role: "user", content: userPrompt }]

    let responseText = ""

    try {
      const started = Date.now()
      for await (const event of this.provider.streamChat({
        model: this.triageModel,
        purpose: "flash_triage",
        system,
        messages,
        maxTokens: TRIAGE_MAX_TOKENS,
        abortSignal: AbortSignal.timeout(TRIAGE_TIMEOUT_MS),
      })) {
        if (event.type === "text" && typeof event.data === "string") {
          responseText += event.data
        }
        if (Date.now() - started > TRIAGE_TIMEOUT_MS) break
      }

      const parsed = parseTriageResponse(responseText)
      if (parsed) return parsed

      // Text fallback: try basic classification from unstructured response
      const lower = responseText.toLowerCase()
      const rawMode = lower.includes("discussion") || lower.includes("讨论") ? "discussion"
        : lower.includes("full") || lower.includes("全栈") || lower.includes("完整") ? "full_complex"
        : lower.includes("plan") || lower.includes("方案") || lower.includes("规划") ? "plan_before_code"
        : "narrow_edit"

      return {
        mode: rawMode as FlashTriageResult["mode"],
        needsWeb: lower.includes("need_web") || lower.includes("搜索"),
        researchQueries: [],
        relevantSkillNames: [],
        planSteps: [],
        requiredVerification: lower.includes("test") ? ["typecheck", "test"] : ["typecheck"],
        reasoning: responseText.slice(0, 200),
        riskLevel: lower.includes("high") || lower.includes("高") ? "medium" : "low",
      }
    } catch {
      return null
    }
  }
}

// ── Conversion functions — triage result → existing types ──

export function triageModeToIntent(mode: FlashTriageResult["mode"]): IntentMode {
  switch (mode) {
    case "discussion": return "readonly"
    case "narrow_edit": return "narrow_edit"
    case "plan_before_code":
    case "full_complex": return "long_task"
  }
}

export function triageToTaskIntent(mode: FlashTriageResult["mode"]): TaskIntent {
  switch (mode) {
    case "discussion": return "readonly"
    case "narrow_edit": return "narrow_edit"
    case "plan_before_code":
    case "full_complex": return "long_task"
  }
}

/**
 * Build a TaskTracker from triage result.
 * Returns null if the task doesn't warrant tracking.
 */
export function buildTrackerFromTriage(
  triage: FlashTriageResult,
  prompt: string,
): { goal: string; intent: TaskIntent; phase: "planning" | "building"; requiredFiles: string[]; requiredVerificationKinds: VerificationKind[]; steps: TaskStep[] } | null {
  if (triage.mode === "discussion" || triage.mode === "narrow_edit") return null

  const verificationKinds: VerificationKind[] = triage.requiredVerification
    .filter(v => v === "typecheck" || v === "test" || v === "build" || v === "smoke")
    .slice(0, 4) as VerificationKind[]

  if (!verificationKinds.includes("typecheck")) verificationKinds.unshift("typecheck")

  const steps: TaskStep[] = triage.planSteps.length > 0
    ? triage.planSteps.map(s => ({
        id: s.id, title: s.title, status: "pending" as const,
      }))
    : [
        { id: "plan", title: "规划项目结构", status: "pending" },
        { id: "implement", title: "实现核心逻辑", status: "pending" },
        { id: "verify", title: "运行验证命令", status: "pending" },
      ]

  const requiredFiles = triage.planSteps.flatMap(s => s.deliverables).slice(0, 12)

  return {
    goal: prompt.trim().slice(0, 120) || "长任务",
    intent: triageToTaskIntent(triage.mode),
    phase: triage.mode === "full_complex" ? "planning" : "building",
    requiredFiles: requiredFiles.length ? requiredFiles : ["package.json"],
    requiredVerificationKinds: verificationKinds,
    steps,
  }
}

/**
 * Keyword-only fallback skill activation — returns skill names that match
 * the prompt text against each skill's trigger keywords.
 */
export function activateSkillNamesByKeywords(prompt: string, maxSkills = 3): string[] {
  const lower = prompt.toLowerCase()
  const names: string[] = []
  for (const [name, triggers] of Object.entries(SKILL_TRIGGER_MAP)) {
    if (triggers.some(t => lower.includes(t.toLowerCase()))) {
      names.push(name)
      if (names.length >= maxSkills) break
    }
  }
  return names
}
