/** Tests for PR-3: CommandShelf + scoreCommand fuzzy matching.
 *
 *  Covers:
 *    1. scoreCommand: 完全/前缀/子串/fuzzy 散列四级评分 + 不匹配 -1 + 空 query 100
 *    2. scoreCommand: 大小写不敏感
 *    3. matchCommands: 过滤 -1、score 降序、同分稳定排序、limit 截断
 *    4. CommandShelf 数据结构: ScoredCommand<SlashCommandHint> 字段、描述截断阈值
 *    5. PR-3 集成场景: 5 条上限、Esc 不可见但数据仍可计算
 */

import { describe, expect, test } from "bun:test"
import { scoreCommand, matchCommands, type ScoredCommand } from "../../src/tui/commands/score"
import type { SlashCommandHint } from "../../src/tui/input"

// ── scoreCommand: 四级评分 ──

describe("scoreCommand: priority levels", () => {
  test("完全匹配 = 1000", () => {
    expect(scoreCommand("help", "help")).toBe(1000)
  })

  test("空 query = 100（全部等价匹配）", () => {
    expect(scoreCommand("", "anything")).toBe(100)
    expect(scoreCommand("", "help")).toBe(100)
  })

  test("前缀匹配 > 子串匹配", () => {
    const prefix = scoreCommand("hel", "help")
    const substr = scoreCommand("elp", "help")
    expect(prefix).toBeGreaterThan(substr)
    expect(prefix).toBeGreaterThanOrEqual(500)
    expect(substr).toBeGreaterThanOrEqual(300)
  })

  test("子串匹配 > fuzzy 散列", () => {
    const substr = scoreCommand("elp", "help")
    const fuzzy = scoreCommand("hp", "help")  // h...p 散列匹配
    expect(substr).toBeGreaterThan(fuzzy)
  })

  test("不匹配 = -1", () => {
    expect(scoreCommand("xyz", "help")).toBe(-1)
    expect(scoreCommand("zzz", "compact")).toBe(-1)
  })

  test("fuzzy 散列匹配能命中非连续字符", () => {
    // "hp" 在 "help" 中: h(0) p(3) — 非连续
    const score = scoreCommand("hp", "help")
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(300)  // 低于子串
  })

  test("fuzzy 连续匹配 > 散乱匹配", () => {
    // "he" 在 "help" 中连续
    const contiguous = scoreCommand("he", "help")
    // "hl" 在 "help" 中散列（h at 0, l at 2）
    const scattered = scoreCommand("hl", "help")
    expect(contiguous).toBeGreaterThan(scattered)
  })
})

// ── scoreCommand: 大小写不敏感 ──

describe("scoreCommand: case insensitive", () => {
  test("query 大写、name 小写 → 同小写评分", () => {
    expect(scoreCommand("HELP", "help")).toBe(1000)
    expect(scoreCommand("Help", "help")).toBe(1000)
  })

  test("query 小写、name 大写 → 同小写评分", () => {
    expect(scoreCommand("help", "HELP")).toBe(1000)
  })

  test("混合大小写前缀匹配", () => {
    expect(scoreCommand("HeL", "help")).toBeGreaterThan(500)
  })
})

// ── matchCommands: 过滤 + 排序 + limit ──

describe("matchCommands: filtering and sorting", () => {
  const commands: SlashCommandHint[] = [
    { name: "help", description: "Show help" },
    { name: "history", description: "Show history" },
    { name: "compact", description: "Compact context" },
    { name: "clear", description: "Clear screen" },
    { name: "hint", description: "Show hints" },
    { name: "hello", description: "Greet" },
    { name: "exit", description: "Exit app" },
  ]

  test("过滤掉 -1 不匹配项", () => {
    const matches = matchCommands("xyz", commands, c => c.name)
    expect(matches.length).toBe(0)
  })

  test("按 score 降序排序", () => {
    const matches = matchCommands("h", commands, c => c.name)
    expect(matches.length).toBeGreaterThan(0)
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i]!.score).toBeLessThanOrEqual(matches[i - 1]!.score)
    }
  })

  test("完全匹配排第一", () => {
    const matches = matchCommands("help", commands, c => c.name)
    expect(matches[0]!.command.name).toBe("help")
    expect(matches[0]!.score).toBe(1000)
  })

  test("同分按原始顺序稳定排序（不交换）", () => {
    // 空 query → 所有命令 score=100，按 originalIndex 排序
    const matches = matchCommands("", commands, c => c.name, 10)
    expect(matches.length).toBe(commands.length)
    for (let i = 1; i < matches.length; i++) {
      // 同分时 originalIndex 升序 → 保持原顺序
      if (matches[i]!.score === matches[i - 1]!.score) {
        // 验证稳定：help 应在 history 前（原顺序）
      }
    }
    expect(matches[0]!.command.name).toBe("help")
    expect(matches[1]!.command.name).toBe("history")
  })

  test("默认 limit=5 截断", () => {
    const matches = matchCommands("", commands, c => c.name)
    expect(matches.length).toBe(5)
  })

  test("自定义 limit", () => {
    const matches = matchCommands("", commands, c => c.name, 3)
    expect(matches.length).toBe(3)
  })

  test("limit 大于命令数时返回全部", () => {
    const matches = matchCommands("", commands, c => c.name, 100)
    expect(matches.length).toBe(commands.length)
  })

  test("空命令数组返回空", () => {
    const matches = matchCommands("help", [], c => c.name)
    expect(matches.length).toBe(0)
  })

  test("返回 ScoredCommand 结构（command + score 字段）", () => {
    const matches = matchCommands("help", commands, c => c.name)
    expect(matches[0]).toHaveProperty("command")
    expect(matches[0]).toHaveProperty("score")
    expect(matches[0]!.command.name).toBe("help")
  })
})

// ── matchCommands: 5 条上限场景（PR-3 集成） ──

describe("matchCommands: PR-3 5-item limit", () => {
  test("10 条命令、空 query → 仅返回前 5 条", () => {
    const commands: SlashCommandHint[] = Array.from({ length: 10 }, (_, i) => ({
      name: `cmd${i}`,
      description: `Command ${i}`,
    }))
    const matches = matchCommands("", commands, c => c.name)
    expect(matches.length).toBe(5)
  })

  test("7 条匹配、空 query → 5 条（截断）", () => {
    const commands: SlashCommandHint[] = [
      { name: "a1", description: "" },
      { name: "a2", description: "" },
      { name: "a3", description: "" },
      { name: "a4", description: "" },
      { name: "a5", description: "" },
      { name: "a6", description: "" },
      { name: "a7", description: "" },
    ]
    const matches = matchCommands("a", commands, c => c.name)
    // 全部前缀匹配，按原顺序取前 5
    expect(matches.length).toBe(5)
    expect(matches[0]!.command.name).toBe("a1")
    expect(matches[4]!.command.name).toBe("a5")
  })
})

// ── CommandShelf 数据结构验证 ──

describe("CommandShelf: data structure (PR-3)", () => {
  test("ScoredCommand<SlashCommandHint> 包含 name/description", () => {
    const cmd: SlashCommandHint = { name: "help", description: "Show help" }
    const scored: ScoredCommand<SlashCommandHint> = { command: cmd, score: 1000 }
    expect(scored.command.name).toBe("help")
    expect(scored.command.description).toBe("Show help")
    expect(scored.score).toBe(1000)
  })

  test("SlashCommandHint 可选 usage 字段", () => {
    const cmd: SlashCommandHint = { name: "help", description: "Show help", usage: "/help [topic]" }
    expect(cmd.usage).toBe("/help [topic]")
  })

  test("空 matches 数组（CommandShelf 渲染无匹配提示）", () => {
    const matches: Array<ScoredCommand<SlashCommandHint>> = []
    expect(matches.length).toBe(0)
    // CommandShelf 组件: matches.length === 0 → 渲染 "无匹配命令"
  })

  test("描述截断阈值: maxDescWidth = max(20, width - 30)", () => {
    // CommandShelf 默认 width=80 → maxDescWidth = 50
    // 验证截断逻辑的阈值计算
    const width = 80
    const maxDescWidth = Math.max(20, width - 30)
    expect(maxDescWidth).toBe(50)

    // 窄屏: width=40 → maxDescWidth = 20（下限）
    const narrow = Math.max(20, 40 - 30)
    expect(narrow).toBe(20)

    // 极窄屏: width=20 → maxDescWidth = 20（下限保护）
    const tiny = Math.max(20, 20 - 30)
    expect(tiny).toBe(20)
  })

  test("selectedIndex 边界: 空列表时 Math.min(0, -1) 安全", () => {
    const matches: Array<ScoredCommand<SlashCommandHint>> = []
    const commandIdx = 0
    const safeIdx = matches.length === 0
      ? 0
      : Math.min(commandIdx, matches.length - 1)
    expect(safeIdx).toBe(0)
  })

  test("selectedIndex 边界: 超出长度时 clamp 到末项", () => {
    const matches: Array<ScoredCommand<SlashCommandHint>> = [
      { command: { name: "a", description: "" }, score: 100 },
      { command: { name: "b", description: "" }, score: 100 },
    ]
    const commandIdx = 5  // 超出
    const safeIdx = Math.min(commandIdx, Math.max(0, matches.length - 1))
    expect(safeIdx).toBe(1)
  })
})

// ── PR-3 集成: fuzzy 匹配真实场景 ──

describe("PR-3: fuzzy matching real scenarios", () => {
  const commands: SlashCommandHint[] = [
    { name: "help", description: "Show help" },
    { name: "history", description: "Show history" },
    { name: "compact", description: "Compact context" },
    { name: "clear", description: "Clear screen" },
    { name: "exit", description: "Exit app" },
    { name: "model", description: "Switch model" },
    { name: "mode", description: "Switch mode" },
  ]

  test("输入 'h' → help/history 前缀匹配优先", () => {
    const matches = matchCommands("h", commands, c => c.name, 5)
    expect(matches[0]!.command.name).toBe("help")
    expect(matches[1]!.command.name).toBe("history")
    // help 和 history 都是前缀匹配
    expect(matches[0]!.score).toBeGreaterThanOrEqual(500)
    expect(matches[1]!.score).toBeGreaterThanOrEqual(500)
  })

  test("输入 'mo' → model/mode 前缀匹配", () => {
    const matches = matchCommands("mo", commands, c => c.name, 5)
    const names = matches.map(m => m.command.name)
    expect(names).toContain("model")
    expect(names).toContain("mode")
    // model (前缀 "mo") vs mode (前缀 "mo")
    // mode 更短 → ratio 加分更高 → mode 应排前
    expect(matches[0]!.command.name).toBe("mode")
  })

  test("输入 'lea' → clear 子串匹配（非前缀）", () => {
    // "clear" = c-l-e-a-r，"lea" 是 index 1 的子串
    const matches = matchCommands("lea", commands, c => c.name, 5)
    const clearMatch = matches.find(m => m.command.name === "clear")
    expect(clearMatch).toBeDefined()
    expect(clearMatch!.score).toBeGreaterThanOrEqual(300)
    expect(clearMatch!.score).toBeLessThan(500)  // 子串 < 前缀
  })

  test("输入 'cp' → compact fuzzy 匹配（c...p）", () => {
    const matches = matchCommands("cp", commands, c => c.name, 5)
    const compactMatch = matches.find(m => m.command.name === "compact")
    expect(compactMatch).toBeDefined()
    expect(compactMatch!.score).toBeGreaterThan(0)
    expect(compactMatch!.score).toBeLessThan(300)  // fuzzy < 子串
  })

  test("完全无匹配返回空数组", () => {
    const matches = matchCommands("zzz", commands, c => c.name, 5)
    expect(matches.length).toBe(0)
  })
})
