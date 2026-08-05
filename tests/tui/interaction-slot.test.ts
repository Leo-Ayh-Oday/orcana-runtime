/** Tests for InteractionSlot（Depthline P2）。
 *
 *  覆盖：
 *    - 同时只显示一个交互面（clarification 优先于 question）
 *    - activeInteractionKind 纯函数
 */

import { describe, expect, test } from "bun:test"
import { activeInteractionKind } from "../../src/tui/components/InteractionSlot"
import type { ClarificationQuestion } from "../../src/agent/clarification"
import type { TuiPendingQuestion } from "../../src/tui/state/types"

function makeClarification(): NonNullable<Parameters<typeof activeInteractionKind>[0]> {
  const question: ClarificationQuestion = {
    id: "q1",
    title: "Which approach?",
    options: [
      { key: "A", label: "Option A", recommended: true },
      { key: "B", label: "Option B" },
    ],
  }
  return {
    originalPrompt: "test",
    questions: [question],
    index: 0,
    selected: 0,
    answers: [],
    rawText: "test",
  }
}

function makeQuestion(): TuiPendingQuestion {
  return { question: "Is this ok?" }
}

describe("activeInteractionKind", () => {
  test("both clarification and question: clarification wins (slot 只允许一个)", () => {
    expect(activeInteractionKind(makeClarification(), makeQuestion())).toBe("clarification")
  })

  test("only clarification → clarification", () => {
    expect(activeInteractionKind(makeClarification(), undefined)).toBe("clarification")
  })

  test("only question → question", () => {
    expect(activeInteractionKind(null, makeQuestion())).toBe("question")
  })

  test("neither → none", () => {
    expect(activeInteractionKind(null, undefined)).toBe("none")
  })
})
