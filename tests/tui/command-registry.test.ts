/** Tests for CommandRegistry — covers PR-4 acceptance points.
 *
 *  Points covered:
 *    1. Command definitions: all 16 commands have name + description + category
 *    2. Required commands present: ripple, gates, evidence, patches, models, status, clear, exit
 *    3. getCommand(name): lookup by name
 *    4. getCommandsByCategory: filter by category
 *    5. getCommandHints: palette format (SlashCommandHint)
 *    6. formatHelpText: grouped output
 *    7. isSafeConcurrent: safe vs unsafe commands
 *    8. commandExists: existence check
 *    9. getKeybindHints: empty for now (no keybinds defined)
 */

import { describe, expect, test } from "bun:test"
import {
  COMMANDS,
  getCommand,
  getCommandsByCategory,
  getCommandHints,
  getKeybindHints,
  formatHelpText,
  isSafeConcurrent,
  commandExists,
  type CommandCategory,
} from "../../src/tui/commands/registry"

// ── Command definitions integrity ──

describe("COMMANDS integrity", () => {
  test("every command has non-empty name and description", () => {
    for (const cmd of COMMANDS) {
      expect(cmd.name.length).toBeGreaterThan(0)
      expect(cmd.description.length).toBeGreaterThan(0)
    }
  })

  test("every command has a valid category", () => {
    const validCategories: CommandCategory[] = ["session", "runtime", "orcana", "system", "info"]
    for (const cmd of COMMANDS) {
      expect(validCategories).toContain(cmd.category)
    }
  })

  test("command names are unique", () => {
    const names = COMMANDS.map(cmd => cmd.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })

  test("has at least 16 commands", () => {
    expect(COMMANDS.length).toBeGreaterThanOrEqual(16)
  })
})

// ── Required commands present ──

describe("required commands (PR-4 plan)", () => {
  const required = ["ripple", "gates", "evidence", "patches", "models", "status", "clear", "exit"]

  for (const name of required) {
    test(`/${name} exists`, () => {
      expect(commandExists(name)).toBe(true)
    })
  }

  test("all 8 required commands present", () => {
    for (const name of required) {
      expect(getCommand(name)).toBeDefined()
    }
  })
})

// ── getCommand ──

describe("getCommand", () => {
  test("finds existing command by name", () => {
    const cmd = getCommand("clear")
    expect(cmd).toBeDefined()
    expect(cmd!.name).toBe("clear")
    expect(cmd!.category).toBe("session")
  })

  test("returns undefined for unknown command", () => {
    expect(getCommand("nonexistent")).toBeUndefined()
  })

  test("returns undefined for empty string", () => {
    expect(getCommand("")).toBeUndefined()
  })
})

// ── getCommandsByCategory ──

describe("getCommandsByCategory", () => {
  test("orcana category has ripple, gates, evidence, patches", () => {
    const orcana = getCommandsByCategory("orcana")
    const names = orcana.map(cmd => cmd.name)
    expect(names).toContain("ripple")
    expect(names).toContain("gates")
    expect(names).toContain("evidence")
    expect(names).toContain("patches")
  })

  test("system category has help and exit", () => {
    const system = getCommandsByCategory("system")
    const names = system.map(cmd => cmd.name)
    expect(names).toContain("help")
    expect(names).toContain("exit")
  })

  test("info category has status and stats", () => {
    const info = getCommandsByCategory("info")
    const names = info.map(cmd => cmd.name)
    expect(names).toContain("status")
    expect(names).toContain("stats")
  })

  test("session category has clear, save, compact, sessions, search, undo", () => {
    const session = getCommandsByCategory("session")
    const names = session.map(cmd => cmd.name)
    expect(names).toContain("clear")
    expect(names).toContain("save")
    expect(names).toContain("compact")
    expect(names).toContain("sessions")
    expect(names).toContain("search")
    expect(names).toContain("undo")
  })

  test("runtime category has models, connect, and effort", () => {
    const runtime = getCommandsByCategory("runtime")
    const names = runtime.map(cmd => cmd.name)
    expect(names).toContain("models")
    expect(names).toContain("connect")
    expect(names).toContain("effort")
  })

  test("returns empty array for unknown category", () => {
    expect(getCommandsByCategory("nonexistent" as CommandCategory)).toEqual([])
  })

  test("all commands across categories sum to total", () => {
    const categories: CommandCategory[] = ["session", "runtime", "orcana", "system", "info"]
    const total = categories.reduce((sum, cat) => sum + getCommandsByCategory(cat).length, 0)
    expect(total).toBe(COMMANDS.length)
  })
})

// ── getCommandHints ──

describe("getCommandHints", () => {
  test("returns SlashCommandHint for every visible command", () => {
    const hints = getCommandHints()
    expect(hints.length).toBe(COMMANDS.length)

    for (const hint of hints) {
      expect(hint.name.length).toBeGreaterThan(0)
      expect(hint.description.length).toBeGreaterThan(0)
    }
  })

  test("includes all required commands", () => {
    const hints = getCommandHints()
    const names = hints.map(h => h.name)
    expect(names).toContain("ripple")
    expect(names).toContain("gates")
    expect(names).toContain("evidence")
    expect(names).toContain("patches")
    expect(names).toContain("models")
    expect(names).toContain("status")
    expect(names).toContain("clear")
    expect(names).toContain("exit")
  })

  test("effort command has usage hint", () => {
    const hints = getCommandHints()
    const effort = hints.find(h => h.name === "effort")
    expect(effort?.usage).toBe("<auto|high|max>")
  })

  test("search command has usage hint", () => {
    const hints = getCommandHints()
    const search = hints.find(h => h.name === "search")
    expect(search?.usage).toBe("<query>")
  })
})

// ── formatHelpText ──

describe("formatHelpText", () => {
  const helpText = formatHelpText()

  test("starts with header", () => {
    expect(helpText).toContain("Available commands:")
  })

  test("contains category labels", () => {
    expect(helpText).toContain("Orcana:")
    expect(helpText).toContain("Runtime:")
    expect(helpText).toContain("Session:")
    expect(helpText).toContain("Info:")
    expect(helpText).toContain("System:")
  })

  test("contains all required commands with / prefix", () => {
    expect(helpText).toContain("/ripple")
    expect(helpText).toContain("/gates")
    expect(helpText).toContain("/evidence")
    expect(helpText).toContain("/patches")
    expect(helpText).toContain("/models")
    expect(helpText).toContain("/connect")
    expect(helpText).toContain("/status")
    expect(helpText).toContain("/clear")
    expect(helpText).toContain("/exit")
  })

  test("contains descriptions", () => {
    expect(helpText).toContain("Show ripple scan findings")
    expect(helpText).toContain("Show gate status summary")
    expect(helpText).toContain("Exit Orcana")
  })

  test("contains tip at end", () => {
    expect(helpText).toContain("Tip:")
  })

  test("is multi-line", () => {
    expect(helpText.split("\n").length).toBeGreaterThan(10)
  })
})

// ── isSafeConcurrent ──

describe("isSafeConcurrent", () => {
  test("returns true for safe commands (orcana data queries)", () => {
    expect(isSafeConcurrent("ripple")).toBe(true)
    expect(isSafeConcurrent("gates")).toBe(true)
    expect(isSafeConcurrent("evidence")).toBe(true)
    expect(isSafeConcurrent("patches")).toBe(true)
  })

  test("returns true for info commands", () => {
    expect(isSafeConcurrent("status")).toBe(true)
    expect(isSafeConcurrent("stats")).toBe(true)
    expect(isSafeConcurrent("models")).toBe(true)
    expect(isSafeConcurrent("connect")).toBe(true)
  })

  test("returns true for help", () => {
    expect(isSafeConcurrent("help")).toBe(true)
  })

  test("returns false for clear (session reset)", () => {
    expect(isSafeConcurrent("clear")).toBe(false)
  })

  test("returns false for exit", () => {
    expect(isSafeConcurrent("exit")).toBe(false)
  })

  test("returns false for effort (changes runtime state)", () => {
    expect(isSafeConcurrent("effort")).toBe(false)
  })

  test("returns false for unknown command", () => {
    expect(isSafeConcurrent("nonexistent")).toBe(false)
  })

  test("returns false for empty string", () => {
    expect(isSafeConcurrent("")).toBe(false)
  })
})

// ── commandExists ──

describe("commandExists", () => {
  test("returns true for known commands", () => {
    expect(commandExists("help")).toBe(true)
    expect(commandExists("clear")).toBe(true)
    expect(commandExists("exit")).toBe(true)
    expect(commandExists("ripple")).toBe(true)
  })

  test("returns false for unknown commands", () => {
    expect(commandExists("nonexistent")).toBe(false)
    expect(commandExists("")).toBe(false)
    expect(commandExists("HELP")).toBe(false) // case-sensitive
  })
})

// ── getKeybindHints ──

describe("getKeybindHints", () => {
  test("returns empty array (no keybinds defined yet)", () => {
    expect(getKeybindHints()).toEqual([])
  })

  test("returns array type (future keybind support)", () => {
    const result = getKeybindHints()
    expect(Array.isArray(result)).toBe(true)
  })
})

// ── Integration: SLASH_COMMANDS via getCommandHints ──

describe("palette integration", () => {
  test("getCommandHints output matches SlashCommandHint shape", () => {
    const hints = getCommandHints()
    for (const hint of hints) {
      expect(typeof hint.name).toBe("string")
      expect(typeof hint.description).toBe("string")
      if (hint.usage !== undefined) {
        expect(typeof hint.usage).toBe("string")
      }
    }
  })

  test("every command in COMMANDS appears in hints", () => {
    const hints = getCommandHints()
    const hintNames = new Set(hints.map(h => h.name))
    for (const cmd of COMMANDS) {
      expect(hintNames.has(cmd.name)).toBe(true)
    }
  })
})
