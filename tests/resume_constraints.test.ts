import { describe, expect, test } from "bun:test"
import { buildResumeMessages } from "../src/session/summarizer"
import type { Session } from "../src/session"

// RC-11 K6 (RESUME_PRESERVES_CONSTRAINTS): resume 从权威状态重建约束——
// ≥3 条用户输入且蒸馏可用时注入 system 约束帧（替换 2+4 正则摘要对早期约束的依赖），
// 蒸馏失败/不足降级确定性摘要，两种路径都保留 2+4 连续性尾部。

function makeSession(messages: Array<{ role: "user" | "assistant"; content: string }>): Session {
  return {
    id: "sess-k6",
    createdAt: 1_700_000_000_000,
    messages: messages.map((m, i) => ({ ...m, timestamp: 1_700_000_000_000 + i, metadata: {} })),
    metadata: {},
  }
}

/** 早期约束分散在会话前段（旧实现 2+4 截取 + 正则摘要会丢失）。 */
function constraintHeavySession(): Session {
  return makeSession([
    { role: "user", content: "必须使用 TypeScript 严格模式，禁止 any" },
    { role: "assistant", content: "好的，类型严格化处理" },
    { role: "user", content: "不要在 test/ 目录外添加测试" },
    { role: "assistant", content: "明白，测试只放 test/" },
    { role: "user", content: "接口文档保持与实现同步更新" },
    { role: "assistant", content: "收到，同步维护文档" },
    { role: "user", content: "继续完成模块 B 的剩余函数" },
    { role: "assistant", content: "已开始处理模块 B" },
    { role: "user", content: "完成后运行完整测试套件" },
    { role: "assistant", content: "测试套件将作为验收依据" },
  ])
}

describe("RC-11 K6 RESUME_PRESERVES_CONSTRAINTS", () => {
  test("≥3 用户输入 + 蒸馏成功 → system 约束帧 + 2+4 尾部（无正则摘要）", async () => {
    const distilled = "### 用户约束（蒸馏，防淘汰丢失）\n- [要求] 必须使用 TypeScript 严格模式\n- [要求] 测试只放 test/"
    const messages = await buildResumeMessages(constraintHeavySession(), async () => distilled)

    expect(messages.length).toBeGreaterThan(0)
    const frame = messages[0]!
    expect(frame.role).toBe("system")
    expect(frame.content).toContain("<system-reminder>")
    expect(frame.content).toContain(distilled)
    // 蒸馏成功时不使用正则摘要降级
    expect(messages.some(m => m.content.includes("## Resume Context"))).toBe(false)
    // 2+4 尾部保留：会话首条用户消息 + 末尾 4 条
    expect(messages[1]!.content).toBe("必须使用 TypeScript 严格模式，禁止 any")
    const tail = messages.slice(-4).map(m => m.content)
    expect(tail).toContain("继续完成模块 B 的剩余函数")
    expect(tail).toContain("测试套件将作为验收依据")
  })

  test("蒸馏失败 → 降级确定性摘要 + 2+4 尾部", async () => {
    const messages = await buildResumeMessages(constraintHeavySession(), async () => null)

    expect(messages[0]!.role).toBe("assistant")
    expect(messages[0]!.content).toContain("## Resume Context")
    expect(messages.some(m => m.role === "system")).toBe(false)
    expect(messages.length).toBe(7) // 摘要帧 + 2+4（10 条消息 → [0,1,6,7,8,9]）
  })

  test("蒸馏抛异常 → 不阻断 resume（静默降级摘要）", async () => {
    const messages = await buildResumeMessages(constraintHeavySession(), async () => { throw new Error("provider down") })
    expect(messages[0]!.role).toBe("assistant")
    expect(messages[0]!.content).toContain("## Resume Context")
  })

  test("<3 用户输入 → 不调用蒸馏，直接摘要 + 尾部", async () => {
    let called = false
    const session = makeSession([
      { role: "user", content: "简单任务" },
      { role: "assistant", content: "处理中" },
      { role: "user", content: "完成" },
    ])
    const messages = await buildResumeMessages(session, async texts => {
      called = true
      return `distilled ${texts.length}`
    })
    expect(called).toBe(false)
    expect(messages[0]!.content).toContain("## Resume Context")
    expect(messages.length).toBe(4) // 摘要帧 + 全部 3 条（≤6 不走 2+4）
  })
})
