/** Command system types — extension point for slash commands. */

import type { StagedContextManager } from "../../context/staged"
import type { SessionManager } from "../../session"
import type { ThinkingStore } from "../../memory/thinking-store"
import type { KnowledgeBase } from "../../memory/knowledge"
import type { HookSystem } from "../../hooks"
import type { CompactionState } from "../../memory/compactor"

export interface ParsedArgs {
  positional: Record<string, string>
  flags: Record<string, unknown>
  raw: string
}

export interface CommandContext {
  history: Array<{ role: "user" | "assistant" | "system"; content: string }>
  stagedCtx: StagedContextManager
  sessions: SessionManager
  thinkingStore: ThinkingStore
  knowledgeBase: KnowledgeBase
  compactor: CompactionState
  sessionId: string
  undoStack: Array<{ path: string; previousContent: string | null }>
  thinkEffort: "auto" | "high" | "max"
  hooks: HookSystem

  setThinkEffort: (val: "auto" | "high" | "max") => void
  setSessionId: (id: string) => void
  /** Print the generated help table. Bound to the CommandRegistry at startup. */
  showHelp: () => void
  reprompt: () => void
}

export interface CommandDef {
  name: string
  aliases?: string[]
  description: string
  usage?: string
  args?: CommandArgDef[]
  handler: (args: ParsedArgs, ctx: CommandContext) => void | Promise<void>
  hidden?: boolean
}

export interface CommandArgDef {
  name: string
  description?: string
  required?: boolean
  rest?: boolean
}
