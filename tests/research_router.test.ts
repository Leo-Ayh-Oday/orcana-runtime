import { describe, expect, test } from "bun:test"
import { buildResearchEvidenceContext, classifyEvidenceSource } from "../src/agent/research-answer"
import { buildResearchQuestions, classifyResearchRoute, shouldRunResearch } from "../src/agent/research-router"

describe("ResearchRouter", () => {
  test("explicit web evidence requests enter research answer mode", () => {
    const decision = classifyResearchRoute({
      prompt: "深度思考，结合联网搜索证明你的观点：怎么让 agent 学会推翻自己？",
      intentMode: "readonly",
    })

    expect(decision.mode).toBe("research_answer")
    expect(decision.needWeb).toBe(true)
    expect(shouldRunResearch(decision)).toBe(true)
    expect(decision.researchQuestions.length).toBeGreaterThanOrEqual(2)
  })

  test("no-web architecture discussion stays discussion mode", () => {
    const decision = classifyResearchRoute({
      prompt: "先不要联网，只讨论这个 agent 架构的风险",
      intentMode: "readonly",
    })

    expect(decision.mode).toBe("deep_discussion")
    expect(decision.needWeb).toBe(false)
    expect(shouldRunResearch(decision)).toBe(false)
  })

  test("implementation prompts do not become research unless explicitly requested", () => {
    const decision = classifyResearchRoute({
      prompt: "实现这个功能并修改代码",
      intentMode: "narrow_edit",
    })

    expect(decision.mode).toBe("code_task")
    expect(decision.needWeb).toBe(false)
  })

  test("builds bounded research subquestions", () => {
    const questions = buildResearchQuestions("对比 Claude Code 和 Orcana 的架构差距，结合 GitHub 和论文")

    expect(questions.length).toBeLessThanOrEqual(5)
    expect(questions.some(q => /DeepSeek|Claude|coding agent/i.test(q))).toBe(true)
  })
})

describe("ResearchAnswer", () => {
  test("classifies evidence source strength", () => {
    expect(classifyEvidenceSource("https://arxiv.org/abs/2505.22954")).toBe("论文/学术")
    expect(classifyEvidenceSource("https://api-docs.deepseek.com/guides/thinking_mode")).toBe("官方文档")
    expect(classifyEvidenceSource("https://github.com/example/project")).toBe("代码/GitHub")
  })

  test("builds evidence context with answer requirements", () => {
    const decision = classifyResearchRoute({
      prompt: "结合联网搜索证明观点",
      intentMode: "readonly",
    })
    const message = buildResearchEvidenceContext(decision, [{
      query: "test query",
      success: true,
      content: "1. Paper\nhttps://arxiv.org/abs/1234.5678\nsnippet",
    }])

    expect(String(message.content)).toContain("Research Evidence Context")
    expect(String(message.content)).toContain("来源类型: 论文/学术")
    expect(String(message.content)).toContain("不要编造来源")
  })
})
