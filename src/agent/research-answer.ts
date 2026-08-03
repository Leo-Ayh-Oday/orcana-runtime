import type { ProviderMessage } from "../provider/types"
import type { ResearchRouteDecision } from "./research-router"

export interface ResearchEvidence {
  query: string
  success: boolean
  content: string
}

export function classifyEvidenceSource(text: string): string {
  const lower = text.toLowerCase()
  if (/arxiv|doi\.org|openreview|icml|iclr|neurips|acm\.org|ieee\.org/.test(lower)) return "论文/学术"
  if (/docs\.|documentation|api-docs|developer\.|官方|official/.test(lower)) return "官方文档"
  if (/github\.com|gitlab\.com/.test(lower)) return "代码/GitHub"
  if (/blog|medium|dev\.to|substack|news|article/.test(lower)) return "博客/报道"
  return "未分级来源"
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 3)}...`
}

export function buildResearchEvidenceContext(decision: ResearchRouteDecision, evidence: ResearchEvidence[]): ProviderMessage {
  const lines: string[] = [
    "## Research Evidence Context",
    "",
    `路由判断: ${decision.mode} / 置信度 ${decision.confidence}`,
    `路由原因: ${decision.reason}`,
    "",
    "请基于以下外部证据回答。你必须区分事实、来源强度和你的推测；如果证据不足，要明确说不足。",
    "",
  ]

  for (const item of evidence) {
    lines.push(`### Query: ${item.query}`)
    if (!item.success) {
      lines.push(`搜索失败: ${clip(item.content, 500)}`)
      lines.push("")
      continue
    }
    lines.push(`来源类型: ${classifyEvidenceSource(item.content)}`)
    lines.push(clip(item.content, 1600))
    lines.push("")
  }

  lines.push("## Research Answer Requirements")
  lines.push("- 先给一个清晰核心论点。")
  lines.push("- 至少列出 2 个证据点；证据不足时要诚实说明。")
  lines.push("- 区分：论文/官方文档/GitHub/博客报道/推测。")
  lines.push("- 给出反方观点或主要风险。")
  lines.push("- 给出能落地到 Orcana 的路线。")
  lines.push("- 不要编造来源，不要把推测写成事实。")

  return { role: "user", content: lines.join("\n") }
}

export function buildResearchInsufficientEvidenceMessage(decision: ResearchRouteDecision, evidence: ResearchEvidence[]): string {
  const failed = evidence.filter(item => !item.success)
  return [
    "## Research Evidence Warning",
    "本轮被路由为研究型回答，但外部搜索证据不足。",
    "",
    `路由原因: ${decision.reason}`,
    "",
    "失败的搜索：",
    ...failed.map(item => `- ${item.query}: ${clip(item.content, 220)}`),
    "",
    "请只基于已知上下文回答，并明确说明：没有足够联网证据，结论可信度有限。",
  ].join("\n")
}
