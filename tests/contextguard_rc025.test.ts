/** RC-02.5 ContextGuard：X1 约束蒸馏 / X2 错误行保留。 */

import { describe, expect, test } from "bun:test"
import { microcompactToolResults, extractErrorLines } from "../src/agent/round/post-loop"
import { distillUserConstraints, buildDistillPrompt, extractUserTexts, formatConstraintContext } from "../src/agent/memory/user-constraints"
import type { LLMProvider, StreamEvent } from "../src/provider/types"

function providerReturning(text: string): LLMProvider {
  return {
    async *streamChat(): AsyncGenerator<StreamEvent> {
      yield { type: "text", data: text }
    },
  }
}

describe("X2 microcompact preserves error lines", () => {
  test("error lines beyond head 300 are preserved", () => {
    const content = [
      "line".repeat(800),
      "FAILED test_foo.py::test_bar - AssertionError: expected 2 == 3",
      "line".repeat(800),
      "Traceback (most recent call last):",
      "line".repeat(800),
    ].join("\n")
    const { results } = microcompactToolResults(
      [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content,
          is_error: false,
        },
      ],
      [{ id: "t1", name: "shell", input: { command: "pytest" } }],
    )
    const out = String(results[0]!.content)
    expect(out).toContain("FAILED test_foo.py::test_bar")
    expect(out).toContain("Traceback")
    expect(out).toContain("[错误线索]")
  })

  test("error results carry is_error marker", () => {
    const { results } = microcompactToolResults(
      [{ type: "tool_result", tool_use_id: "t2", content: "x".repeat(4000), is_error: true }],
      [{ id: "t2", name: "shell", input: { command: "make" } }],
    )
    expect(String(results[0]!.content)).toContain("[is_error]")
  })

  test("extractErrorLines dedupes and caps at 3", () => {
    const lines = extractErrorLines("ok\nERROR a\nERROR a\nERROR b\nerror c\nnormal line\nERROR d", 3)
    expect(lines.length).toBe(3)
    expect(lines[0]).toBe("ERROR a")
    expect(new Set(lines).size).toBe(3)
  })
})

describe("X1 user constraint distillation", () => {
  test("parses constraints JSON from flash response", async () => {
    const provider = providerReturning('{"constraints":[{"rule":"不要修改 src/runtime","source":"explicit","verbatim":"不要动 runtime"},{"rule":"必须跑全量测试","source":"acceptance_criteria","verbatim":"全量测试"}]}')
    const result = await distillUserConstraints(provider, "test-model", ["不要动 runtime", "记得跑全量测试"])
    expect(result.success).toBe(true)
    expect(result.constraints.length).toBe(2)
    expect(result.constraints[0]!.rule).toBe("不要修改 src/runtime")
    expect(result.constraints[0]!.source).toBe("explicit")
  })

  test("empty message list short-circuits without provider call", async () => {
    let called = false
    const provider: LLMProvider = {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        called = true
        yield { type: "text", data: "{}" }
      },
    }
    const result = await distillUserConstraints(provider, "m", [])
    expect(result.success).toBe(true)
    expect(called).toBe(false)
  })

  test("non-JSON response fails loudly with success:false", async () => {
    const result = await distillUserConstraints(providerReturning("sorry, no json"), "m", ["a", "b", "c"])
    expect(result.success).toBe(false)
    expect(result.constraints).toEqual([])
  })

  test("extractUserTexts filters tool results and system reminders", () => {
    const texts = extractUserTexts([
      { role: "user", content: "第一条指令" },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "tool_result", content: "big output" }] as never },
      { role: "user", content: "<system-reminder>思考链已压实</system-reminder>" },
      { role: "user", content: "第二条指令" },
    ])
    expect(texts).toEqual(["第一条指令", "第二条指令"])
  })

  test("formatConstraintContext renders tag labels", () => {
    const ctx = formatConstraintContext([
      { rule: "禁止 rm -rf", source: "explicit", verbatim: "" },
      { rule: "改用法 A", source: "negative_feedback", verbatim: "" },
    ])
    expect(ctx).toContain("[要求] 禁止 rm -rf")
    expect(ctx).toContain("[纠正] 改用法 A")
  })

  test("buildDistillPrompt caps at 40 messages", () => {
    const many = Array.from({ length: 60 }, (_, i) => `msg ${i}`)
    const prompt = buildDistillPrompt(many)
    expect(prompt.length).toBeGreaterThan(0)
    expect(prompt).toContain("msg 59")
    expect(prompt).not.toContain("msg 0")
  })
})
