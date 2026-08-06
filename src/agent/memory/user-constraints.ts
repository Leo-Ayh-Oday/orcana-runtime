/** RC-02.5 X1: 用户约束滚动蒸馏。
 *
 *  问题：入口窗口（60 条/~150k token）与 epoch rollover 淘汰的轮次中，
 *  用户硬约束（禁止事项/必须事项/验收标准/负面反馈）会永久丢失——
 *  正则抽取（DECISION_RE）只认 12 个信号词，漏率高。
 *
 *  方案：在淘汰发生时用 flash 一次性蒸馏 user 消息为结构化约束清单，
 *  产物进入 planStateContext/stableMemoryContext，随每轮 system 层注入。
 *  成本：1 次 flash 调用/淘汰事件，只发生在超长会话。
 */

import type { ProviderMessage } from "../../provider/types"
import type { LLMProvider } from "../../provider/types"

export interface DistilledConstraint {
  rule: string
  source: "explicit" | "negative_feedback" | "acceptance_criteria"
  verbatim: string
}

export interface DistillConstraintsResult {
  constraints: DistilledConstraint[]
  success: boolean
  error?: string
}

const SYSTEM = "你是用户约束蒸馏器。输出纯 JSON，不做其他解释。"

/** 从被淘汰的 user 消息中提取硬约束（最多 40 条）。 */
export function buildDistillPrompt(userMessages: string[]): string {
  return [
    "从以下用户消息中提取所有硬性约束（禁止、必须、偏好、验收标准、负面反馈）。",
    "规则:",
    '- 只提取对后续工作仍有约束力的内容，忽略寒暄和一次性请求细节',
    '- "rule": 简洁约束表述（≤60字）',
    '- "source": explicit=明确要求；negative_feedback=用户纠正/不满；acceptance_criteria=验收标准',
    '- "verbatim": 原文引用（≤120字），用于防漂移',
    "- 最多 15 条；无约束时返回空数组",
    "- 用中文输出",
    "",
    "输出纯 JSON: {\"constraints\":[{\"rule\":\"...\",\"source\":\"explicit\",\"verbatim\":\"...\"}]}",
    "",
    "## 用户消息（按时间顺序）",
    "",
    userMessages.slice(-40).join("\n---\n"),
  ].join("\n")
}

/** 调用 flash 蒸馏。失败时返回 success:false，调用方应保留原文级降级而非静默。 */
export async function distillUserConstraints(
  provider: LLMProvider,
  model: string,
  userMessages: string[],
  abortSignal?: AbortSignal,
): Promise<DistillConstraintsResult> {
  if (userMessages.length === 0) {
    return { constraints: [], success: true }
  }
  const prompt = buildDistillPrompt(userMessages.slice(-40))
  try {
    const chunks: string[] = []
    for await (const event of provider.streamChat({
      model,
      purpose: "thinking_compaction",
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 1024,
      abortSignal,
    })) {
      if (event.type === "text" && typeof event.data === "string") {
        chunks.push(event.data)
      }
    }
    const text = chunks.join("").trim()
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { constraints: [], success: false, error: `no JSON in response: ${text.slice(0, 120)}` }
    }
    const parsed = JSON.parse(jsonMatch[0]) as { constraints?: Array<Partial<DistilledConstraint>> }
    const constraints = (parsed.constraints ?? [])
      .filter((c): c is DistilledConstraint =>
        Boolean(c?.rule && typeof c.rule === "string") &&
        (c.source === "explicit" || c.source === "negative_feedback" || c.source === "acceptance_criteria"))
      .map(c => ({
        rule: String(c.rule).slice(0, 60),
        source: c.source as DistilledConstraint["source"],
        verbatim: String(c.verbatim ?? "").slice(0, 120),
      }))
      .slice(0, 15)
    return { constraints, success: true }
  } catch (e) {
    return { constraints: [], success: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 将约束清单格式化为注入 planStateContext 的段落。 */
export function formatConstraintContext(constraints: DistilledConstraint[]): string {
  if (constraints.length === 0) return ""
  const lines: string[] = ["### 用户约束（蒸馏，防淘汰丢失）", ""]
  for (const c of constraints) {
    const tag = c.source === "negative_feedback" ? "纠正" : c.source === "acceptance_criteria" ? "验收" : "要求"
    lines.push(`- [${tag}] ${c.rule}`)
  }
  return lines.join("\n")
}

/** 从消息列表提取 user 文本（无工具结果的纯文本）。 */
export function extractUserTexts(messages: ProviderMessage[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (m.role !== "user") continue
    const text = typeof m.content === "string"
      ? m.content
      : (m.content as Array<Record<string, unknown>>)
          .filter(b => b?.type === "text" && typeof b.text === "string")
          .map(b => String(b.text))
          .join("\n")
    const clean = text.trim()
    if (clean && !clean.startsWith("[Microcompact") && !clean.includes("<system-reminder>")) {
      out.push(clean.slice(0, 800))
    }
  }
  return out
}
