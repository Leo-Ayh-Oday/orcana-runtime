/** Built-in slash command definitions.
 *
 *  Each handler receives ParsedArgs + CommandContext. The context carries
 *  references to CLI state — handlers mutate it through the typed interface.
 */

import { createCompactor, saveCompactorState, buildCompactionPreview } from "../../memory/compactor"
import { searchAllSessions } from "../../session"
import type { Session } from "../../session"
import type { UsageStats } from "../../agent/loop"
import type { CommandContext, CommandDef } from "./types"
import {
  listRewindPoints,
  executeRewind,
  formatRewindList,
  formatRewindResult,
  type RewindMode,
} from "../../agent/rewind"

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const green = (s: string) => `\x1b[1;32m${s}\x1b[0m`

function persistAndReturnId(ctx: CommandContext): string {
  const { sessions, history, stagedCtx, compactor } = ctx
  const isNew = !ctx.sessionId
  const s: Session = isNew
    ? sessions.create({ topic: history[0]?.content?.slice(0, 50), messageCount: history.length })
    : (() => { try { return sessions.load(ctx.sessionId) } catch { return null } })()
      ?? sessions.create({ topic: history[0]?.content?.slice(0, 50), messageCount: history.length })
  s.messages = history.map(h => ({ role: h.role as "user" | "assistant", content: h.content, timestamp: Date.now(), metadata: {} }))
  s.metadata = { ...s.metadata, messageCount: history.length, stagedFiles: [...stagedCtx.loadedFiles.keys()] }
  sessions.save(s)
  saveCompactorState(compactor, s.id)
  if (s.id !== ctx.sessionId) ctx.setSessionId(s.id)
  return s.id
}

export interface RewindOverrides {
  /** Current round number (for auto-save and rewind target). */
  getCurrentRound: () => number
  /** FileTransaction IDs created since the last rewind point (for rollback). */
  getTransactionIds: () => string[]
  /** Truncate conversation history to a specific round. */
  truncateHistoryToRound: (round: number) => void
  /** Session ID. */
  getSessionId: () => string
}

export function createBuiltinCommands(
  overrides: {
    getSessionTokens: () => { input: number; output: number; ms: number }
    resetSessionTokens: () => void
    getLastUsage: () => UsageStats | null
    rewind?: RewindOverrides
  },
): CommandDef[] {
  return [
    {
      name: "exit",
      aliases: ["quit"],
      description: "退出",
      handler: () => process.exit(0),
    },
    {
      name: "help",
      description: "显示所有命令",
      handler: (_args, ctx) => {
        ctx.showHelp()
      },
    },
    {
      name: "clear",
      description: "清空当前上下文",
      handler: (_args, ctx) => {
        ctx.history.length = 0
        ctx.setSessionId("")
        Object.assign(ctx.compactor, createCompactor())
        overrides.resetSessionTokens()
        console.log(dim("已清空。\n"))
      },
    },
    {
      name: "save",
      description: "保存会话",
      handler: (_args, ctx) => {
        if (ctx.history.length) persistAndReturnId(ctx)
        console.log(ctx.history.length ? green(`已保存 ${ctx.sessionId}\n`) : dim("没有可保存的对话\n"))
      },
    },
    {
      name: "compact",
      description: "预览上下文压缩",
      usage: "[preview]",
      handler: (_args, ctx) => {
        if (ctx.history.length) persistAndReturnId(ctx)
        console.log(dim(buildCompactionPreview(ctx.compactor, {
          sessionId: ctx.sessionId,
          messageCount: ctx.history.length,
          loadedFiles: [...ctx.stagedCtx.loadedFiles.keys()],
        }) + "\n"))
      },
    },
    {
      name: "sessions",
      description: "查看历史会话",
      handler: (_args, ctx) => {
        const list = ctx.sessions.listSessions()
        if (!list.length) console.log(dim("没有历史会话\n"))
        else for (const s of list.slice(0, 10)) {
          const topic = s.topic ? ` - ${s.topic}` : ""
          console.log(`  ${dim(s.id.slice(0, 8))}  ${new Date(s.createdAt).toLocaleString("zh-CN")}  ${s.messageCount} 条${topic}`)
        }
        console.log("")
      },
    },
    {
      name: "search",
      description: "搜索会话记录",
      usage: "<关键词>",
      handler: (args, _ctx) => {
        const query = args.positional.query ?? args.raw
        if (!query) {
          console.log(dim("用法: /search <关键词>\n"))
          return
        }
        const results = searchAllSessions(query, { limit: 8 })
        if (results.length === 0) {
          console.log(dim(`未找到 "${query}" 相关记录\n`))
        } else {
          console.log("")
          for (const hit of results) {
            const date = new Date(hit.timestamp).toLocaleString("zh-CN")
            const label = hit.role === "user" ? "用户" : "助手"
            console.log(`  ${dim(hit.sessionId.slice(0, 8))} ${dim(date)} ${green(String(Math.round(hit.score * 100)))}%`)
            if (hit.sessionTopic) console.log(`  ${dim("会话:")} ${hit.sessionTopic}`)
            console.log(`  ${dim(label + ":")} ${hit.contentSnippet.slice(0, 120)}`)
            console.log("")
          }
        }
      },
    },
    {
      name: "undo",
      description: "撤销上次写入操作",
      handler: (_args, ctx) => {
        if (ctx.undoStack.length === 0) {
          console.log(dim("没有可撤销的写入操作。\n"))
          return
        }
        const snap = ctx.undoStack.pop()!
        const fs = require("node:fs")
        if (snap.previousContent === null) {
          try { fs.unlinkSync(snap.path); console.log(green(`已删除 ${snap.path}\n`)) }
          catch (e) { console.log(dim(`无法删除 ${snap.path}: ${e}\n`)) }
        } else {
          try { fs.writeFileSync(snap.path, snap.previousContent, "utf-8"); console.log(green(`已还原 ${snap.path}\n`)) }
          catch (e) { console.log(dim(`无法还原 ${snap.path}: ${e}\n`)) }
        }
      },
    },
    {
      name: "stats",
      description: "查看统计信息",
      handler: (_args, ctx) => {
        const tokens = overrides.getSessionTokens()
        const msgCount = ctx.history.length
        const fileCount = ctx.stagedCtx.loadedFiles.size
        console.log(dim(`会话: ${ctx.sessionId || "(未保存)"}  |  消息: ${msgCount}  |  文件: ${fileCount}`))
        const lastUsage = overrides.getLastUsage()
        if (lastUsage) {
          const u = lastUsage
          const hr = u.apiCalls > 0 ? Math.round(u.cacheHits / u.apiCalls * 100) : 0
          console.log(dim(`API: ${u.apiCalls} 次 | Flash ${u.flashRounds} Pro ${u.proRounds} | ${Math.round(u.estimatedInputTokens / 1000)}K | 缓存 ${hr}%`))
        }
        console.log(dim(`累计: ${formatK(tokens.input + tokens.output)} tokens | ${(tokens.ms / 1000).toFixed(0)}s\n`))
      },
    },
    {
      name: "effort",
      description: "设置推理深度 auto/high/max",
      usage: "<auto|high|max>",
      handler: (args, ctx) => {
        const val = args.positional.mode ?? args.raw
        if (val === "auto" || val === "high" || val === "max") {
          ctx.setThinkEffort(val)
          console.log(green(`推理深度: ${val}\n`))
        } else {
          console.log(dim(`推理深度: ${ctx.thinkEffort}  (/effort auto|high|max)\n`))
        }
      },
    },
    {
      name: "rewind",
      description: "回退到检查点: /rewind list | /rewind <round> [code|conv|both]",
      usage: "<list|round> [code|conv|both]",
      handler: (args, ctx) => {
        const rw = overrides.rewind
        if (!rw) {
          console.log(dim("回退功能未初始化。\n"))
          return
        }

        const sub = args.positional.mode ?? args.raw
        const modeArg = args.positional.mode2 ?? args.flags.mode as string | undefined

        // /rewind list — show available rewind points
        if (sub === "list" || sub === "ls" || !sub) {
          const points = listRewindPoints(rw.getSessionId())
          console.log(formatRewindList(points))
          return
        }

        // /rewind <round> [code|conv|both]
        const targetRound = parseInt(sub, 10)
        if (isNaN(targetRound) || targetRound <= 0) {
          console.log(dim("用法: /rewind <round> [code|conv|both]  或  /rewind list\n"))
          return
        }

        // Parse mode
        let mode: RewindMode = "code"
        if (modeArg === "conv" || modeArg === "conversation") {
          mode = "conversation"
        } else if (modeArg === "both" || modeArg === "all") {
          mode = "both"
        }

        const result = executeRewind({
          sessionId: rw.getSessionId(),
          targetRound,
          mode,
          fileTransactionIds: mode !== "conversation" ? rw.getTransactionIds() : undefined,
        })

        console.log(formatRewindResult(result))

        // Truncate conversation if mode includes conversation
        if (result.success && (mode === "conversation" || mode === "both")) {
          rw.truncateHistoryToRound(targetRound)
          console.log(green(`对话已截断到 round ${targetRound}\n`))
        }
      },
    },
  ]
}

function formatK(n: number): string {
  if (n < 1000) return String(n)
  return (n / 1000).toFixed(1) + "K"
}
