/** 日记铁律 — 不可违背的约束引擎
 *
 *  铁律不是建议，是契约。码虽然能跑（置信度≥80%），但违反铁律
 *  仍被一票否决 → 触发深度回溯。
 *
 *  铁律来源：
 *    1. 项目根 .codejournal 文件（YAML-like 格式）
 *    2. builtinRules（代码内置，最低保障）
 *
 *  检查时机：
 *    - 写操作后（onToolAfter hook）
 *    - Review 阶段（post-edit lint）
 *    - 最终审查（Inspector 阶段）
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSyncLegacy } from "../runtime/legacy-process"

/** LNXF-R2 E1.1：.codejournal command 规则 —— 默认禁用（恶意仓库不得
 *  获得宿主执行面），仅显式 opt-in（ORCANA_JOURNAL_ALLOW_COMMAND=1）启用；
 *  即使启用也使用最小安全环境（不继承宿主 env，密钥/代理/SSH 零泄露），
 *  并以参数数组 spawn（/bin/sh -c 仅承载 command 自身语义）。
 *  后续计划：迁移到 LinuxExecutionBroker（profile=build + Receipt）。 */
export const JOURNAL_MINIMAL_ENV: Record<string, string> = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: process.env.HOME ?? "/tmp",
  TMPDIR: "/tmp",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
}

export function commandRulesEnabled(): boolean {
  return process.env.ORCANA_JOURNAL_ALLOW_COMMAND === "1"
}

// ── 铁律定义 ──

export interface JournalRule {
  id: string
  description: string
  /** 严重级别：block = 一票否决，warn = 警告但放行 */
  severity: "block" | "warn"
  /** 检查函数：返回违规原因，或 null 表示通过 */
  check: (context: RuleContext) => string | null
}

export interface RuleContext {
  projectRoot: string
  changedFiles: string[]
  toolName: string
  params: Record<string, unknown>
  result: { success: boolean; content: string }
  /** 最近 10 条对话摘要 */
  recentMessages: string[]
}

export interface Violation {
  ruleId: string
  description: string
  reason: string
  severity: "block" | "warn"
}

// ── Built-in 铁律（最低保障） ──

const builtinRules: JournalRule[] = [
  {
    id: "no-secret-leak",
    description: "禁止在代码中硬编码密钥、token、密码",
    severity: "block",
    check(ctx) {
      const content = ctx.result.content
      const patterns = [
        /(api_key|apikey|API_KEY)\s*=\s*["'][\w-]{16,}["']/,
        /(token|TOKEN)\s*=\s*["'][\w.-]{16,}["']/,
        /(password|passwd)\s*=\s*["'][^"']{4,}["']/,
        /sk-[a-zA-Z0-9]{32,}/,
        /ghp_[a-zA-Z0-9]{32,}/,
      ]
      for (const p of patterns) {
        if (p.test(content)) {
          const match = content.match(p)?.[0]
          return `检测到潜在密钥泄露: ${match?.slice(0, 40)}...`
        }
      }
      return null
    },
  },
  {
    id: "no-eval-raw-input",
    description: "禁止使用 eval/Function 执行不可信输入",
    severity: "block",
    check(ctx) {
      const content = ctx.result.content
      if (/\beval\s*\(/.test(content) && !/safe-eval|json\.parse/i.test(content)) {
        return "检测到 eval() 调用，禁止执行不可信输入"
      }
      if (/\bnew\s+Function\s*\(/.test(content)) {
        return "检测到 new Function() 动态构造，存在注入风险"
      }
      return null
    },
  },
  {
    id: "no-console-in-production",
    description: "生产代码禁止 console.log / debugger",
    severity: "warn",
    check(ctx) {
      const content = ctx.result.content
      const lines = content.split("\n").filter(l =>
        /\bconsole\.(log|debug|warn)\b/.test(l) && !l.includes("// allow-console")
      )
      if (lines.length > 0) {
        return `发现 ${lines.length} 处 console 调用，生产代码应移除或用日志框架`
      }
      if (/\bdebugger\b/.test(content)) {
        return "发现 debugger 断点，生产代码应移除"
      }
      return null
    },
  },
  {
    id: "no-any-type-abuse",
    description: "禁止用 any 逃逸类型检查（除非显式标注 @allow-any）",
    severity: "warn",
    check(ctx) {
      const content = ctx.result.content
      const anyLines = content.split("\n").filter(l =>
        /:\s*any\b/.test(l) && !l.includes("@allow-any")
      )
      if (anyLines.length >= 3) {
        return `发现 ${anyLines.length} 处 any 类型逃逸，建议使用 unknown + 类型守卫`
      }
      return null
    },
  },
  {
    id: "no-unhandled-promise",
    description: "禁止未处理的 Promise（fire-and-forget）",
    severity: "block",
    check(ctx) {
      const content = ctx.result.content
      // 检测 async 调用但没有 await 也没有 .then/.catch
      const lines = content.split("\n")
      for (const line of lines) {
        const trimmed = line.trim()
        if (
          /\b\w+\(.*\)\s*$/.test(trimmed) &&
          !/\bawait\b/.test(trimmed) &&
          !/\.then\(/.test(trimmed) &&
          !/\.catch\(/.test(trimmed) &&
          /async|Promise/.test(trimmed) &&
          !trimmed.startsWith("//") &&
          !trimmed.startsWith("return ") &&
          !trimmed.includes("=>") // arrow function body
        ) {
          // 避免误报：检查目标函数是否返回 Promise
          if (/\.push\(|\.forEach\(|\.map\(|\.filter\(/.test(trimmed)) continue
          return `可能未处理的 Promise: ${trimmed.slice(0, 80)}...`
        }
      }
      return null
    },
  },
]

// ── .codejournal 解析 ──

interface CodeJournalEntry {
  id: string
  severity: "block" | "warn"
  pattern?: string      // regex pattern to search in code
  glob?: string          // file glob pattern
  message: string
  check_type: "regex_content" | "file_exists" | "command" | "banned_import"
  command?: string       // shell command that must pass
  banned?: string[]      // banned imports or function names
}

function parseCodeJournal(path: string): RuleContext | { rules: CodeJournalEntry[] } | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, "utf-8")
    // Simple YAML-like parser (no external dep)
    const rules: CodeJournalEntry[] = []
    let current: Partial<CodeJournalEntry> = {}
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      if (trimmed.startsWith("- id:")) {
        if (current.id) { rules.push(current as CodeJournalEntry); current = {} }
        current.id = trimmed.slice(4).trim()
        continue
      }
      const colonIdx = trimmed.indexOf(":")
      if (colonIdx < 0) continue
      const key = trimmed.slice(0, colonIdx).trim()
      const val = trimmed.slice(colonIdx + 1).trim()
      if (key === "severity") current.severity = val as "block" | "warn"
      if (key === "pattern") current.pattern = val
      if (key === "glob") current.glob = val
      if (key === "message") current.message = val
      if (key === "check_type") current.check_type = val as CodeJournalEntry["check_type"]
      if (key === "command") current.command = val
      if (key === "banned") current.banned = val ? val.slice(1, -1).split(",").map(s => s.trim()) : []
    }
    if (current.id) rules.push(current as CodeJournalEntry)
    return { rules } as any
  } catch {
    return null
  }
}

function codeJournalToRules(entries: CodeJournalEntry[], projectRoot: string): JournalRule[] {
  return entries.map(e => ({
    id: e.id,
    description: e.message || e.id,
    severity: e.severity,
    check(ctx: RuleContext) {
      switch (e.check_type) {
        case "regex_content": {
          if (!e.pattern) return null
          const re = new RegExp(e.pattern, "gm")
          const matches = ctx.result.content.match(re)
          if (matches) return `${e.message}: 匹配到 ${matches.length} 处 "${e.pattern}"`
          return null
        }
        case "banned_import": {
          if (!e.banned?.length) return null
          for (const ban of e.banned) {
            if (ctx.result.content.includes(ban)) {
              return `${e.message}: 检测到被禁用的导入 "${ban}"`
            }
          }
          return null
        }
        case "file_exists": {
          if (!e.glob) return null
          const path = join(projectRoot, e.glob)
          if (existsSync(path)) return `${e.message}: 文件 ${e.glob} 存在（不应该存在）`
          return null
        }
        case "command": {
          if (!e.command) return null
          if (!commandRulesEnabled()) return null // 默认禁用（E1.1 fail-closed）
          try {
            const res = spawnSyncLegacy("/bin/sh", ["-c", e.command], {
              cwd: projectRoot,
              timeout: 10_000,
              env: JOURNAL_MINIMAL_ENV,
              encoding: "utf8",
            })
            return res.status === 0
              ? null
              : `${e.message}: 命令 "${e.command}" 执行失败（exit ${res.status}）`
          } catch {
            return `${e.message}: 命令 "${e.command}" 执行失败`
          }
        }
        default:
          return null
      }
    },
  }))
}

// ── 日记引擎 ──

export class JournalEngine {
  private rules: JournalRule[] = []
  private projectRoot: string

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot
    this.load()
  }

  private load() {
    // Always load builtin rules
    this.rules = [...builtinRules]

    // Load .codejournal if exists
    const journalPath = join(this.projectRoot, ".codejournal")
    const parsed = parseCodeJournal(journalPath) as { rules: CodeJournalEntry[] } | null
    if (parsed?.rules) {
      // E1.1：command 类型默认剔除（仓库级输入 → 宿主执行的 RCE 面），
      // 显式 opt-in 才保留；regex_content/file_exists/banned_import 纯
      // 只读检查不受影响。
      const allowed = commandRulesEnabled()
        ? parsed.rules
        : parsed.rules.filter(r => r.check_type !== "command")
      const custom = codeJournalToRules(allowed, this.projectRoot)
      this.rules.push(...custom)
    }
  }

  /** 重新加载（当 .codejournal 变更时） */
  reload() { this.load() }

  /** 获取所有铁律描述（用于注入 prompts） */
  getRulesSummary(): string {
    const blocks = this.rules.filter(r => r.severity === "block")
    const warns = this.rules.filter(r => r.severity === "warn")
    let summary = ""
    if (blocks.length > 0) {
      summary += "**一票否决铁律（违反即否决）：**\n"
      for (const r of blocks) summary += `- ❌ ${r.id}: ${r.description}\n`
    }
    if (warns.length > 0) {
      summary += "**警告铁律（严重违规记过）：**\n"
      for (const r of warns) summary += `- ⚠️ ${r.id}: ${r.description}\n`
    }
    return summary
  }

  /** 执行铁律检查，返回所有违规 */
  check(ctx: RuleContext): Violation[] {
    const violations: Violation[] = []
    for (const rule of this.rules) {
      try {
        const reason = rule.check(ctx)
        if (reason) {
          violations.push({
            ruleId: rule.id,
            description: rule.description,
            reason,
            severity: rule.severity,
          })
        }
      } catch {
        // 规则检查自身异常不阻塞
      }
    }
    return violations
  }

  /** 是否有阻塞级违规 */
  hasBlockingViolation(violations: Violation[]): boolean {
    return violations.some(v => v.severity === "block")
  }

  /** 格式化违规报告 */
  formatViolations(violations: Violation[]): string {
    if (violations.length === 0) return ""
    const blocks = violations.filter(v => v.severity === "block")
    const warns = violations.filter(v => v.severity === "warn")
    let report = ""

    if (blocks.length > 0) {
      report += `\n[一票否决 — 违反铁律]\n`
      for (const v of blocks) {
        report += `  ❌ [${v.ruleId}] ${v.reason}\n`
      }
      report += `\n[强制要求] 上述修改违反不可违背铁律。你必须：\n`
      report += `  1. 分析为什么触发了这条铁律\n`
      report += `  2. 提出替代方案（不能用任何方式绕过）\n`
      report += `  3. 重写代码，确保铁律检查通过\n`
    }
    if (warns.length > 0) {
      report += `\n[警告]\n`
      for (const v of warns) {
        report += `  ⚠️ [${v.ruleId}] ${v.reason}\n`
      }
    }
    return report
  }
}
