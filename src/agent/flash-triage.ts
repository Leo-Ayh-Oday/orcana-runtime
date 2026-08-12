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
import { SKILLS } from "../skills/registry"
import type { IntentMode } from "./intent"
import type { TaskIntent, TaskStep } from "./task-tracker"
import type { VerificationKind } from "../verification/result"

/** autoTrigger 技能 = 语义分诊可见的技能集（与 registry 单一事实源）。
 *  手动触发技能（motion-review）不参与自动路由。 */
const TRIAGE_VISIBLE = SKILLS.filter((s) => s.autoTrigger)

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
// deepseek-v4-flash 强制 thinking：512 max_tokens 常被思考耗尽 → text 为空
// （ORMB-TR 实测：40 个 mode 用例 12 个 empty-stream 全因此）。
// 2048 仍有 thinking 吃满窗口（ORMB-TR A/B 实测：auto 组 TR-36、enabled1024 组 TR-38
// 均死于 stop_reason=max_tokens 零 text——后者还是 high 风险用例）。4096 留出思考+JSON 余量。
const TRIAGE_MAX_TOKENS = 4096
// 实测延迟 2-19s 波动（连续请求时段 zen/go 变慢）：8s/15s 会把慢请求误杀成
// empty-stream，拉高分诊失败率。30s 覆盖绝大多数请求；代价是 TTFB 上限变长
// （Triage Latency 指标会记录实际分布，见 ORMB-TR）。
const TRIAGE_TIMEOUT_MS = 30000

export type FlashTriagePolicy = "off" | "auto" | "always"

export function resolveFlashTriagePolicy(value = process.env.ORCANA_FLASH_TRIAGE): FlashTriagePolicy {
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
    "直接输出 JSON，不要输出思考过程或解释。",
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
    ...TRIAGE_VISIBLE.map((s) => `- ${s.name}: ${s.description.split(/[—\-]/)[0]!.trim().slice(0, 40)}`),
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

/** Known skill names → triggers for fallback activation.
 *  从 registry 动态生成（单一事实源）：此前硬编码含 phantom "design-quality"、
 *  缺 ui-ux-pro-max/motion-pro-max，导致 fallback 路径结构不可达（ORMB-TR 实测发现）。 */
const SKILL_TRIGGER_MAP: Record<string, string[]> = Object.fromEntries(
  TRIAGE_VISIBLE.map((s) => [s.name, s.triggers]),
)

/** thinking 配置注入：默认 auto（不传，模型自决）；A/B 对比与
 *  Level 2 分层（复杂任务显式 enabled）共用此通道。 */
export type TriageThinking =
  | { type: "enabled"; budget_tokens?: number }
  | { type: "disabled" }
  | undefined

export class FlashTriage {
  private provider: LLMProvider
  private breaker = new TriageCircuitBreaker()
  private triageModel: string
  private thinking: TriageThinking
  /** 最近一次 triage() 的失败原因（供调用方/测试诊断；成功时为 ""）。 */
  lastError = ""

  constructor(provider: LLMProvider, triageModel = TRIAGE_MODEL, thinking: TriageThinking = undefined) {
    this.provider = provider
    this.triageModel = triageModel
    this.thinking = thinking
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
    this.lastError = ""

    try {
      const started = Date.now()
      for await (const event of this.provider.streamChat({
        model: this.triageModel,
        purpose: "flash_triage",
        system,
        messages,
        maxTokens: TRIAGE_MAX_TOKENS,
        // thinking 默认 auto（不传，模型自决）：A/B 实测 disabled 2.4s / auto 4.0s /
        // enabled1024 7.3s，准确率差异待 ORMB-TR A/B 定稿（结论见 observations 结论 10）。
        // maxTokens 2048 已为思考留出空间（512 时实测 thinking 吃满导致空响应）。
        ...(this.thinking ? { thinking: this.thinking } : {}),
        abortSignal: AbortSignal.timeout(TRIAGE_TIMEOUT_MS),
      })) {
        if (event.type === "text" && typeof event.data === "string") {
          responseText += event.data
        } else if (event.type === "error") {
          // provider 重试耗尽后的错误事件——之前被静默忽略，表现为"空响应"，
          // 掩盖了真实失败（ORMB-TR 实测：40 个用例 12 个空响应全是 provider 错误）。
          this.lastError = `provider: ${String(event.data).slice(0, 120)}`
        }
        if (Date.now() - started > TRIAGE_TIMEOUT_MS) break
      }

      // 空响应必须诚实报告失败（→ 关键词 fallback），不能返回"伪成功"兜底值。
      // 伪成功会让调用方把 {mode:narrow_edit, riskLevel:low, skills:[]} 当真实分诊，
      // 30% 的空响应即可把 Mode 指标整体拖到不可信（ORMB-TR 实测发现）。
      if (!responseText.trim()) {
        this.lastError = this.lastError || "empty-stream"
        return null
      }

      const parsed = parseTriageResponse(responseText)
      if (parsed) return parsed
      if (!this.lastError) this.lastError = "parse-failure"

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
        riskLevel: validateRisk(responseText),
      }
    } catch {
      this.lastError = this.lastError || "exception"
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
    // IC05 P4 + Correction P0-C: plan_before_code / full_complex 都是模型
    // heuristic 分类 —— 一律进入 building（执行阶段）。planSteps 作为
    // planning artifact / MasterPlan 输入（P0-G），不构成 execution lock。
    // 真正"只给方案不要执行"由 resolveRuntimeIntent() → readonly 保护。
    phase: "building",
    // IC05 Correction M: Flash heuristic 无 structured deliverables 时
    // Runtime 不得发明 package.json obligation —— requiredFiles 只含真实
    // structured deliverables，允许空数组
    // （FLASH_NO_DELIVERABLE_FALSE_FILE_OBLIGATION=0）。
    requiredFiles: requiredFiles,
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
