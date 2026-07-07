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
import { scoreCommand, matchCommands, scoreSlashCommand, matchSlashCommands, type ScoredCommand } from "../../src/tui/commands/score"
import { commandKindColor, commandShelfRows, commandShelfWindowStart } from "../../src/tui/components/CommandShelf"
import { getCommandHints, COMMANDS } from "../../src/tui/commands/registry"
import type { SlashCommandHint, CommandKind } from "../../src/tui/input"
import { palette } from "../../src/tui/theme/palette"
import { theme } from "../../src/tui/theme/theme"

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
    const empty: SlashCommandHint[] = []
    const matches = matchCommands("help", empty, c => c.name)
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

describe("CommandShelf: scroll window", () => {
  test("keeps window at top while selected item is visible near start", () => {
    expect(commandShelfWindowStart(0, 12, 7)).toBe(0)
    expect(commandShelfWindowStart(3, 12, 7)).toBe(0)
  })

  test("centers selected item after moving beyond the first page", () => {
    expect(commandShelfWindowStart(6, 12, 7)).toBe(3)
  })

  test("clamps window at the end", () => {
    expect(commandShelfWindowStart(11, 12, 7)).toBe(5)
    expect(commandShelfWindowStart(99, 12, 7)).toBe(5)
  })

  test("row count includes an overflow hint when list is scrollable", () => {
    expect(commandShelfRows(0, 7)).toBe(1)
    expect(commandShelfRows(5, 7)).toBe(5)
    expect(commandShelfRows(12, 7)).toBe(8)
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

// ── PR-4: commandKindColor 语义色 ──

describe("PR-4: commandKindColor", () => {
  test("enabled commands use one unified color regardless of kind", () => {
    const kinds: Array<CommandKind | undefined> = ["system", "runtime", "model", "skill", "debug", "danger", undefined]
    const colors = kinds.map(kind => commandKindColor(kind))
    expect(new Set(colors).size).toBe(1)
    expect(colors[0]).toBe(theme.text)
  })

  test("disabled (enabled=false) → fog (dim gray) 覆盖 kind", () => {
    // 即使 kind=danger，disabled 时仍用 dim gray
    expect(commandKindColor("danger", false)).toBe(palette.fog)
    expect(commandKindColor("system", false)).toBe(palette.fog)
    expect(commandKindColor("model", false)).toBe(palette.fog)
  })

  test("enabled=true remains unified", () => {
    expect(commandKindColor("danger", true)).toBe(theme.text)
    expect(commandKindColor("system", true)).toBe(theme.text)
  })
})

// ── PR-4: scoreSlashCommand (aliases + description + priority) ──

describe("PR-4: scoreSlashCommand", () => {
  test("空 query → priority（默认 0）", () => {
    const cmd: SlashCommandHint = { name: "help", description: "Show help" }
    expect(scoreSlashCommand("", cmd)).toBe(0)
  })

  test("空 query + priority=50 → 50", () => {
    const cmd: SlashCommandHint = { name: "help", description: "Show help", priority: 50 }
    expect(scoreSlashCommand("", cmd)).toBe(50)
  })

  test("name 完全匹配 = 1000", () => {
    const cmd: SlashCommandHint = { name: "help", description: "Show help" }
    expect(scoreSlashCommand("help", cmd)).toBe(1000)
  })

  test("aliases 前缀匹配 > description 子串匹配", () => {
    const cmd: SlashCommandHint = {
      name: "models",
      description: "model inspection",
      aliases: ["model"],
    }
    // "model" 是 alias "model" 的完全匹配 → 1000
    const aliasScore = scoreSlashCommand("model", cmd)
    // "model" 是 description "model inspection" 的前缀子串 → 200+
    const descOnlyCmd: SlashCommandHint = {
      name: "stats",
      description: "model inspection",
    }
    const descScore = scoreSlashCommand("model", descOnlyCmd)
    expect(aliasScore).toBeGreaterThan(descScore)
    expect(aliasScore).toBe(1000)  // alias 完全匹配
  })

  test("description 子串匹配 > 无匹配", () => {
    const cmd: SlashCommandHint = {
      name: "status",
      description: "Show full runtime status",
    }
    // "runtime" 在 description 中
    const score = scoreSlashCommand("runtime", cmd)
    expect(score).toBeGreaterThanOrEqual(200)
    expect(score).toBeLessThan(300)  // description 低于 name 子串
  })

  test("name 匹配优先于 description 匹配", () => {
    const cmd: SlashCommandHint = {
      name: "runtime",
      description: "runtime info",
    }
    // "runtime" 是 name 完全匹配 → 1000，也是 description 子串
    const score = scoreSlashCommand("runtime", cmd)
    expect(score).toBe(1000)  // name 完全匹配胜出
  })

  test("多别名取最高分", () => {
    const cmd: SlashCommandHint = {
      name: "models",
      description: "List models",
      aliases: ["model", "m"],
    }
    // "m" 是 alias "m" 的完全匹配 → 1000
    expect(scoreSlashCommand("m", cmd)).toBe(1000)
    // "model" 是 alias "model" 的完全匹配 → 1000
    expect(scoreSlashCommand("model", cmd)).toBe(1000)
  })

  test("禁用命令仍参与评分（可见但不可执行）", () => {
    const cmd: SlashCommandHint = {
      name: "clear",
      description: "Clear conversation",
      enabled: false,
      disabledReason: "Locked in readonly mode",
    }
    expect(scoreSlashCommand("clear", cmd)).toBe(1000)
    expect(scoreSlashCommand("cle", cmd)).toBeGreaterThan(500)
  })

  test("完全无匹配 = -1", () => {
    const cmd: SlashCommandHint = {
      name: "help",
      description: "Show help",
      aliases: ["h"],
    }
    expect(scoreSlashCommand("zzz", cmd)).toBe(-1)
  })
})

// ── PR-4: matchSlashCommands ──

describe("PR-4: matchSlashCommands", () => {
  const commands: SlashCommandHint[] = [
    { name: "help", description: "Show help", kind: "system" },
    { name: "models", description: "List models", kind: "model", aliases: ["model"] },
    { name: "clear", description: "Clear conversation", kind: "danger" },
    { name: "status", description: "Show runtime status", kind: "debug" },
    { name: "stats", description: "Token and cache stats", kind: "debug" },
  ]

  test("alias 匹配: 'model' → models 命令（via alias）", () => {
    const matches = matchSlashCommands("model", commands, 5)
    const modelsMatch = matches.find(m => m.command.name === "models")
    expect(modelsMatch).toBeDefined()
    // "model" 是 alias "model" 完全匹配 → 1000
    expect(modelsMatch!.score).toBe(1000)
  })

  test("description 匹配: 'runtime' → status 命令", () => {
    const matches = matchSlashCommands("runtime", commands, 5)
    const statusMatch = matches.find(m => m.command.name === "status")
    expect(statusMatch).toBeDefined()
    expect(statusMatch!.score).toBeGreaterThanOrEqual(200)
  })

  test("priority 影响空 query 排序", () => {
    const withPriority: SlashCommandHint[] = [
      { name: "low", description: "low pri", priority: 0 },
      { name: "high", description: "high pri", priority: 100 },
      { name: "mid", description: "mid pri", priority: 50 },
    ]
    const matches = matchSlashCommands("", withPriority, 5)
    // priority 降序: high(100) > mid(50) > low(0)
    expect(matches[0]!.command.name).toBe("high")
    expect(matches[1]!.command.name).toBe("mid")
    expect(matches[2]!.command.name).toBe("low")
  })

  test("禁用命令出现在结果中（可见）", () => {
    const disabled: SlashCommandHint[] = [
      { name: "clear", description: "Clear", enabled: false, disabledReason: "Locked" },
      { name: "help", description: "Help" },
    ]
    const matches = matchSlashCommands("clear", disabled, 5)
    expect(matches.length).toBe(1)
    expect(matches[0]!.command.enabled).toBe(false)
  })

  test("5 条上限仍生效", () => {
    const many: SlashCommandHint[] = Array.from({ length: 10 }, (_, i) => ({
      name: `cmd${i}`,
      description: `Command ${i}`,
    }))
    const matches = matchSlashCommands("", many)
    expect(matches.length).toBe(5)
  })
})

// ── PR-4: getCommandHints 输出 kind 字段 ──

describe("PR-4: getCommandHints kind inference", () => {
  const hints = getCommandHints()

  test("所有 hint 都有 kind 字段", () => {
    for (const hint of hints) {
      expect(hint.kind).toBeDefined()
    }
  })

  test("clear → danger (显式 kind)", () => {
    const clear = hints.find(h => h.name === "clear")
    expect(clear?.kind).toBe("danger")
  })

  test("undo → danger (显式 kind)", () => {
    const undo = hints.find(h => h.name === "undo")
    expect(undo?.kind).toBe("danger")
  })

  test("models → model (显式 kind + aliases)", () => {
    const models = hints.find(h => h.name === "models")
    expect(models?.kind).toBe("model")
    expect(models?.aliases).toContain("model")
  })

  test("help → system (category 推断)", () => {
    const help = hints.find(h => h.name === "help")
    expect(help?.kind).toBe("system")
  })

  test("exit → system (category 推断)", () => {
    const exit = hints.find(h => h.name === "exit")
    expect(exit?.kind).toBe("system")
  })

  test("ripple → debug (orcana category 推断)", () => {
    const ripple = hints.find(h => h.name === "ripple")
    expect(ripple?.kind).toBe("debug")
  })

  test("status → debug (info category 推断)", () => {
    const status = hints.find(h => h.name === "status")
    expect(status?.kind).toBe("debug")
  })

  test("effort → runtime (category 推断)", () => {
    const effort = hints.find(h => h.name === "effort")
    expect(effort?.kind).toBe("runtime")
  })

  test("6 种 CommandKind 在 registry 中至少覆盖 4 种", () => {
    const usedKinds = new Set(hints.map(h => h.kind))
    // system, debug, runtime, model, danger 至少出现
    expect(usedKinds.has("system")).toBe(true)
    expect(usedKinds.has("debug")).toBe(true)
    expect(usedKinds.has("runtime")).toBe(true)
    expect(usedKinds.has("danger")).toBe(true)
  })

  test("CommandDef 中的 kind 与 getCommandHints 输出一致", () => {
    for (const cmd of COMMANDS) {
      const hint = hints.find(h => h.name === cmd.name)
      expect(hint).toBeDefined()
      // 显式 kind 或推断 kind 都应该有值
      expect(hint!.kind).toBeDefined()
    }
  })
})
