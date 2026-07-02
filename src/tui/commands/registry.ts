/** CommandRegistry — 斜杠命令的单一数据源。
 *
 *  PR-4 核心模块：/commands、palette、footer hints、未来 which-key 面板
 *  全部从这里读取命令定义，避免多处分散维护。
 *
 *  设计原则：
 *    - registry 只存元数据（name、description、category、keybind、safeConcurrent）
 *    - handler 逻辑留在 main.tsx（需要访问 store/runtime/history）
 *    - palette 通过 getCommandHints() 获取列表
 *    - /help 通过 formatHelpText() 获取格式化输出
 *    - FooterHints 通过 getKeybindHints() 获取键位提示
 *
 *  命令分类：
 *    session  — 会话管理（clear、save、sessions、search、undo）
 *    runtime  — 运行时控制（models、effort）
 *    orcana   — Orcana 引擎数据（ripple、gates、evidence、patches）
 *    system   — 系统命令（help、exit）
 *    info     — 信息查询（status、stats）
 */

import type { SlashCommandHint } from "../input"

// ── 类型定义 ──

export type CommandCategory = "session" | "runtime" | "orcana" | "system" | "info"

export interface CommandDef {
  /** 命令名（不含 / 前缀），如 "clear" */
  name: string
  /** 简短描述，用于 palette 和 /help */
  description: string
  /** 用法提示，如 "<query>" 或 "[preview]" */
  usage?: string
  /** 分类，用于 palette 分组展示 */
  category: CommandCategory
  /** 未来 which-key 面板用的快捷键，如 "Ctrl+L" */
  keybind?: string
  /** 是否在 agent 忙碌时安全执行（默认 false）。
   *  true = 可排队执行；false = 必须等 agent 空闲。 */
  safeConcurrent?: boolean
  /** 是否在 palette 中显示（默认 true）。
   *  某些内部命令可能不需要在 palette 出现。 */
  visible?: boolean
}

// ── 命令定义 ──

export const COMMANDS: CommandDef[] = [
  // ── Orcana 引擎数据 ──
  {
    name: "ripple",
    description: "Show ripple scan findings",
    category: "orcana",
    safeConcurrent: true,
  },
  {
    name: "gates",
    description: "Show gate status summary",
    category: "orcana",
    safeConcurrent: true,
  },
  {
    name: "evidence",
    description: "Show evidence ledger",
    category: "orcana",
    safeConcurrent: true,
  },
  {
    name: "patches",
    description: "Show patch transaction history",
    category: "orcana",
    safeConcurrent: true,
  },

  // ── 运行时控制 ──
  {
    name: "models",
    description: "List available models and show current selection",
    usage: "[provider]",
    category: "runtime",
    safeConcurrent: true,
  },
  {
    name: "connect",
    description: "Show provider connection status and setup guide",
    usage: "[provider]",
    category: "runtime",
    safeConcurrent: true,
  },
  {
    name: "effort",
    description: "Set thinking depth",
    usage: "<auto|high|max>",
    category: "runtime",
  },

  // ── 会话管理 ──
  {
    name: "clear",
    description: "Clear current conversation",
    category: "session",
  },
  {
    name: "save",
    description: "Save this session",
    category: "session",
    safeConcurrent: true,
  },
  {
    name: "compact",
    description: "Preview memory compaction",
    usage: "[preview]",
    category: "session",
    safeConcurrent: true,
  },
  {
    name: "sessions",
    description: "List saved sessions",
    category: "session",
    safeConcurrent: true,
  },
  {
    name: "search",
    description: "Search session history",
    usage: "<query>",
    category: "session",
    safeConcurrent: true,
  },
  {
    name: "undo",
    description: "Undo last write",
    category: "session",
  },

  // ── 信息查询 ──
  {
    name: "status",
    description: "Show full runtime status",
    category: "info",
    safeConcurrent: true,
  },
  {
    name: "stats",
    description: "Show token and cache stats",
    category: "info",
    safeConcurrent: true,
  },

  // ── 系统命令 ──
  {
    name: "help",
    description: "Show all commands",
    category: "system",
    safeConcurrent: true,
  },
  {
    name: "exit",
    description: "Exit DeepSeek Code",
    category: "system",
  },
]

// ── 查询函数 ──

/** 按名称查找命令定义。找不到返回 undefined。 */
export function getCommand(name: string): CommandDef | undefined {
  return COMMANDS.find(cmd => cmd.name === name)
}

/** 按分类筛选命令。 */
export function getCommandsByCategory(category: CommandCategory): CommandDef[] {
  return COMMANDS.filter(cmd => cmd.category === category)
}

/** 获取所有可见命令的 palette 提示（SlashCommandHint 格式）。
 *  用于 OrcanaComposer 的命令面板。 */
export function getCommandHints(): SlashCommandHint[] {
  return COMMANDS
    .filter(cmd => cmd.visible !== false)
    .map(cmd => ({
      name: cmd.name,
      description: cmd.description,
      usage: cmd.usage,
    }))
}

/** 获取所有带 keybind 的命令，用于 FooterHints 或 which-key 面板。
 *  当前没有命令绑定 keybind，返回空数组。
 *  未来添加 keybind 后，FooterHints 可从这里读取。 */
export function getKeybindHints(): Array<{ key: string; command: string; desc: string }> {
  return COMMANDS
    .filter(cmd => cmd.keybind)
    .map(cmd => ({
      key: cmd.keybind!,
      command: cmd.name,
      desc: cmd.description,
    }))
}

/** 格式化 /help 输出文本。按分类分组展示。 */
export function formatHelpText(): string {
  const categoryLabels: Record<CommandCategory, string> = {
    orcana: "Orcana",
    runtime: "Runtime",
    session: "Session",
    info: "Info",
    system: "System",
  }

  const categoryOrder: CommandCategory[] = ["orcana", "runtime", "session", "info", "system"]

  const lines: string[] = ["Available commands:"]

  for (const category of categoryOrder) {
    const cmds = getCommandsByCategory(category)
    if (cmds.length === 0) continue

    lines.push("")
    lines.push(`  ${categoryLabels[category]}:`)
    for (const cmd of cmds) {
      const usage = cmd.usage ? ` ${cmd.usage}` : ""
      const keybind = cmd.keybind ? ` [${cmd.keybind}]` : ""
      lines.push(`    /${cmd.name}${usage}  — ${cmd.description}${keybind}`)
    }
  }

  lines.push("")
  lines.push("Tip: Type / followed by Tab to autocomplete commands.")

  return lines.join("\n")
}

/** 检查命令是否在 agent 忙碌时安全执行。
 *  用于 main.tsx submit() 决定是立即执行还是排队。 */
export function isSafeConcurrent(name: string): boolean {
  const cmd = getCommand(name)
  return cmd?.safeConcurrent ?? false
}

/** 检查命令是否存在。 */
export function commandExists(name: string): boolean {
  return COMMANDS.some(cmd => cmd.name === name)
}
