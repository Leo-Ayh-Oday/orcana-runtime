/** Tests for PR-6: stable-prefix 锁定算法。
 *
 *  覆盖 advanceStablePrefix 纯函数：
 *    1. 初始空 stable + 无 \n\n 文本 → stable 仍为空
 *    2. 出现 \n\n → 推进 stable 到 \n\n 之后
 *    3. 多次 \n\n → 推进到最后一个 \n\n
 *    4. 文本被替换（非前缀扩展）→ reset 为空
 *    5. 空字符串 / 单行文本边界
 */

import { describe, expect, test } from "bun:test"
import { advanceStablePrefix } from "../../src/tui/hooks/use-stable-prefix"

describe("advanceStablePrefix (PR-6)", () => {
  test("初始 prevStable='' + 无 \\n\\n → stable 仍为空", () => {
    expect(advanceStablePrefix("", "Hello world")).toBe("")
  })

  test("出现 \\n\\n → 推进 stable 到 \\n\\n 之后", () => {
    const text = "Para 1\n\nPara 2"
    const stable = advanceStablePrefix("", text)
    expect(stable).toBe("Para 1\n\n")
  })

  test("多次 \\n\\n → 推进到最后一个 \\n\\n", () => {
    const text = "P1\n\nP2\n\nP3"
    const stable = advanceStablePrefix("", text)
    expect(stable).toBe("P1\n\nP2\n\n")
  })

  test("增量：先无 \\n\\n，再加 \\n\\n → 推进", () => {
    let stable = advanceStablePrefix("", "Hello")
    expect(stable).toBe("")
    stable = advanceStablePrefix(stable, "Hello world")
    expect(stable).toBe("")
    stable = advanceStablePrefix(stable, "Hello world\n\n")
    expect(stable).toBe("Hello world\n\n")
    stable = advanceStablePrefix(stable, "Hello world\n\nFoo")
    expect(stable).toBe("Hello world\n\n")
  })

  test("增量：多个段落逐步推进", () => {
    let stable = ""
    let text = ""
    // 流式追加 "P1\n\nP2\n\nP3"
    const chunks = ["P1", "\n", "\n", "P2", "\n", "\n", "P3"]
    // 步进：
    //   "P1"        → 无 \n\n → ""
    //   "P1\n"      → 无 \n\n → ""
    //   "P1\n\n"    → \n\n at 2 → "P1\n\n"
    //   "P1\n\nP2"  → 新增 "P2" 无 \n\n → "P1\n\n"
    //   "P1\n\nP2\n"→ 新增 "P2\n" 无 \n\n → "P1\n\n"
    //   "P1\n\nP2\n\n" → 新增 "P2\n\n" → stable="P1\n\nP2\n\n"
    //   "P1\n\nP2\n\nP3" → 新增 "P3" 无 \n\n → "P1\n\nP2\n\n"
    const expected = ["", "", "P1\n\n", "P1\n\n", "P1\n\n", "P1\n\nP2\n\n", "P1\n\nP2\n\n"]
    for (let i = 0; i < chunks.length; i++) {
      text += chunks[i]
      stable = advanceStablePrefix(stable, text)
      expect(stable).toBe(expected[i] ?? "")
    }
  })

  test("文本被替换（非前缀扩展）→ reset 为空", () => {
    let stable = advanceStablePrefix("", "Hello\n\n")
    expect(stable).toBe("Hello\n\n")
    // 替换为完全不同的文本（不是前缀扩展）
    stable = advanceStablePrefix(stable, "Completely different text")
    expect(stable).toBe("")
  })

  test("文本被替换为部分前缀 → reset 为空", () => {
    let stable = advanceStablePrefix("", "Hello\n\nWorld")
    expect(stable).toBe("Hello\n\n")
    // 部分前缀替换（前缀不匹配）
    stable = advanceStablePrefix(stable, "Hi there")
    expect(stable).toBe("")
  })

  test("空字符串文本 → stable 保持", () => {
    let stable = advanceStablePrefix("", "Hello\n\n")
    expect(stable).toBe("Hello\n\n")
    stable = advanceStablePrefix(stable, "")
    // 空字符串不 startsWith "Hello\n\n"，触发 reset
    expect(stable).toBe("")
  })

  test("prevStable='' + text='' → stable 为空", () => {
    expect(advanceStablePrefix("", "")).toBe("")
  })

  test("单行无段落分隔 → stable 始终为空", () => {
    let stable = advanceStablePrefix("", "Single line text")
    expect(stable).toBe("")
    stable = advanceStablePrefix(stable, "Single line text grows")
    expect(stable).toBe("")
  })

  test("code fence 内的 \\n\\n 也作为边界（简化策略）", () => {
    // 注意：本实现不区分 code fence，任何 \n\n 都视为边界
    const text = "```ts\nconst x = 1\n\nconst y = 2\n```"
    const stable = advanceStablePrefix("", text)
    expect(stable).toBe("```ts\nconst x = 1\n\n")
  })

  test("unstable 部分由调用方计算（stable 之后到末尾）", () => {
    const text = "P1\n\nP2 streaming"
    const stable = advanceStablePrefix("", text)
    expect(stable).toBe("P1\n\n")
    const unstable = text.substring(stable.length)
    expect(unstable).toBe("P2 streaming")
  })

  test("性能：长文本多次增量推进不丢失内容", () => {
    let text = ""
    let stable = ""
    // 模拟流式追加 100 个段落
    for (let i = 0; i < 100; i++) {
      text += `Para ${i}\n\n`
      stable = advanceStablePrefix(stable, text)
      // stable 应总是等于 text（因为 text 以 \n\n 结尾）
      expect(stable).toBe(text)
    }
    // 再追加一个未完成的段落
    text += "Streaming..."
    stable = advanceStablePrefix(stable, text)
    expect(stable).toBe(text.substring(0, text.length - "Streaming...".length))
  })

  test("边界：text 以 \\n\\n 开头", () => {
    expect(advanceStablePrefix("", "\n\nContent")).toBe("\n\n")
  })

  test("边界：text 仅含 \\n\\n", () => {
    expect(advanceStablePrefix("", "\n\n")).toBe("\n\n")
  })

  test("边界：连续 \\n\\n\\n\\n", () => {
    // lastIndexOf("\n\n") 找到位置 2（第二个 \n\n）
    // advance = 2 + 2 = 4，stable = 前 4 个字符
    expect(advanceStablePrefix("", "\n\n\n\n")).toBe("\n\n\n\n")
  })
})
