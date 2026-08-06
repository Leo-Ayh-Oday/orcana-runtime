import { describe, expect, test } from "bun:test"
import { FlashTriage } from "../src/agent/flash-triage"
import type { LLMProvider } from "../src/provider/types"

function textProvider(text: string): LLMProvider {
  return {
    streamChat: async function* () {
      yield { type: "text", data: text }
    },
  }
}

describe("flash triage", () => {
  test("text fallback preserves high risk level instead of downgrading it", async () => {
    const triage = new FlashTriage(textProvider("这个任务风险很高，涉及生产数据库，需要非常谨慎。"))
    const result = await triage.triage("高风险任务")
    expect(result).not.toBeNull()
    expect(result!.riskLevel).toBe("high")
  })

  test("text fallback keeps medium risk for ambiguous content", async () => {
    const triage = new FlashTriage(textProvider("任务中等复杂，涉及多个模块。"))
    const result = await triage.triage("中等任务")
    expect(result).not.toBeNull()
    expect(result!.riskLevel).toBe("medium")
  })
})
