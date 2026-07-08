/** CommandRegistry — extensible slash command dispatch.
 *
 *  Pattern: class-based (matching HookSystem / PermissionGate).
 *  Commands are registered at startup. /help is auto-generated.
 */

import type { CommandContext, CommandDef } from "./types"
import { parseArgs } from "./parser"
import { parseRuntimeInput } from "../../runtime/control-plane"

interface CommandMatch {
  def: CommandDef
  input: string
  /** The name the user actually typed (may be an alias, not the canonical name) */
  invokedAs: string
}

export class CommandRegistry {
  private commands = new Map<string, CommandDef>()

  register(def: CommandDef): void {
    this.commands.set(def.name, def)
    for (const alias of def.aliases ?? []) {
      this.commands.set(alias, def)
    }
  }

  find(input: string): CommandMatch | null {
    const parsed = parseRuntimeInput(input)
    if (parsed.kind !== "slash_command") return null

    const def = this.commands.get(parsed.name)
    if (!def) return null

    return { def, input: parsed.raw, invokedAs: parsed.name }
  }

  /**
   * Parse and execute a slash command. Returns true if a command was found
   * and executed, false if the input was not a known command.
   */
  execute(input: string, ctx: CommandContext): boolean {
    const match = this.find(input)
    if (!match) return false

    const rest = match.input.slice(match.invokedAs.length + 1).trim()
    const args = parseArgs(rest, match.def)
    match.def.handler(args, ctx)
    return true
  }

  list(): CommandDef[] {
    const seen = new Set<string>()
    const result: CommandDef[] = []
    for (const def of this.commands.values()) {
      if (seen.has(def.name)) continue
      seen.add(def.name)
      if (!def.hidden) result.push(def)
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  buildHelp(): string {
    const lines: string[] = ["── 命令 ──"]
    const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
    const cyan = (s: string) => `\x1b[1;36m${s}\x1b[0m`
    for (const def of this.list()) {
      const usage = def.usage ? ` ${def.usage}` : ""
      lines.push(`  ${cyan(`/${def.name}`)}${dim(usage)}  ${dim(def.description)}`)
    }
    return lines.join("\n")
  }
}
