/** ShellSideEffectGuard — detect and warn about destructive shell side effects.
 *
 *  PR-5.3: Classifies shell commands by side-effect category and checks
 *  whether file modifications fall within the expected project scope.
 *
 *  Design:
 *    - Command classification is pattern-based (zero LLM dependency)
 *    - Scope checking is post-execution (compares actual changes vs expected)
 *    - This is a WARNING system, not a blocker — it informs the agent and user
 *    - Actual blocking of dangerous commands remains in shell.ts (BLOCKLIST)
 *
 *  Side-effect categories:
 *    - destructive_delete: rm, del, rmdir, Remove-Item
 *    - destructive_move: mv, move, rename (can overwrite)
 *    - git_destructive: git reset --hard, git clean -f, git stash drop
 *    - permission_change: chmod, chown, icacls, takeown
 *    - external_write: writes to paths outside project root
 */

import { relative, resolve, sep } from "node:path"

// ── Side-effect category ──

export type SideEffectCategory =
  | "destructive_delete"
  | "destructive_move"
  | "git_destructive"
  | "permission_change"
  | "external_write"
  | "none"

export interface SideEffectFinding {
  category: SideEffectCategory
  /** The specific pattern that matched. */
  pattern: string
  /** Human-readable description. */
  description: string
  /** Affected paths (if detectable from command). */
  affectedPaths: string[]
}

export interface SideEffectReport {
  /** The original command. */
  command: string
  /** All detected side-effect categories. */
  findings: SideEffectFinding[]
  /** Files modified outside the project scope. */
  outOfScopeFiles: string[]
  /** Overall severity: "none" | "warning" | "danger". */
  severity: "none" | "warning" | "danger"
}

// ── Pattern definitions ──

interface SideEffectPattern {
  category: SideEffectCategory
  regex: RegExp
  description: string
  /** Extract file paths from the command match. */
  extractPaths?: (match: RegExpExecArray, command: string) => string[]
}

const SIDE_EFFECT_PATTERNS: SideEffectPattern[] = [
  // ── Destructive delete ──
  {
    category: "destructive_delete",
    regex: /\brm\s+(?:-r(?:f)?\s+|-rf\s+|--recursive\s+)?(\S+)/i,
    description: "rm 删除文件/目录",
    extractPaths: (_m, cmd) => extractArgsAfter(cmd, /\brm\b/i),
  },
  {
    category: "destructive_delete",
    regex: /\bdel\s+\/[fsq]\s+(\S+)/i,
    description: "Windows del 强制删除",
  },
  {
    category: "destructive_delete",
    regex: /\brmdir\s+\/s\b/i,
    description: "Windows rmdir 递归删除目录",
  },
  {
    category: "destructive_delete",
    regex: /\bRemove-Item\s+(?:-[A-Za-z]+\s+)*(\S+)/i,
    description: "PowerShell Remove-Item 删除",
    extractPaths: (_m, cmd) => extractArgsAfter(cmd, /\bRemove-Item\b/i),
  },
  {
    category: "destructive_delete",
    regex: /\bgit\s+clean\s+-f/i,
    description: "git clean -f 删除未追踪文件",
  },

  // ── Destructive move/overwrite ──
  {
    category: "destructive_move",
    regex: /\bmv\s+(?:-f\s+)?(\S+)\s+(\S+)/i,
    description: "mv 移动/覆盖文件",
    extractPaths: (_m, cmd) => extractArgsAfter(cmd, /\bmv\b/i),
  },
  {
    category: "destructive_move",
    regex: /\bMove-Item\s+(?:-[A-Za-z]+\s+)*(\S+)/i,
    description: "PowerShell Move-Item",
  },
  {
    category: "destructive_move",
    regex: /\brename\s+(\S+)\s+(\S+)/i,
    description: "rename 重命名文件",
  },

  // ── Git destructive ──
  {
    category: "git_destructive",
    regex: /\bgit\s+reset\s+--hard\b/i,
    description: "git reset --hard 丢弃所有未提交更改",
  },
  {
    category: "git_destructive",
    regex: /\bgit\s+stash\s+drop\b/i,
    description: "git stash drop 删除暂存",
  },
  {
    category: "git_destructive",
    regex: /\bgit\s+stash\s+clear\b/i,
    description: "git stash clear 清空所有暂存",
  },
  {
    category: "git_destructive",
    regex: /\bgit\s+checkout\s+--\s+/i,
    description: "git checkout -- <file> 丢弃文件更改",
    extractPaths: (_m, cmd) => {
      const idx = cmd.search(/\bgit\s+checkout\s+--\s+/i)
      if (idx < 0) return []
      return cmd.slice(idx).split(/\s+/).slice(3).filter(p => p && !p.startsWith("-"))
    },
  },
  {
    category: "git_destructive",
    regex: /\bgit\s+restore\s+/i,
    description: "git restore 恢复文件",
  },

  // ── Permission change ──
  {
    category: "permission_change",
    regex: /\bchmod\s+[0-7]{3,4}\s+/i,
    description: "chmod 修改文件权限",
  },
  {
    category: "permission_change",
    regex: /\bchown\s+/i,
    description: "chown 修改文件所有者",
  },
  {
    category: "permission_change",
    regex: /\bicacls\s+/i,
    description: "Windows icacls 修改 ACL",
  },
  {
    category: "permission_change",
    regex: /\btakeown\s+/i,
    description: "Windows takeown 夺取文件所有权",
  },
]

// ── Helpers ──

function extractArgsAfter(command: string, cmdPattern: RegExp): string[] {
  const idx = command.search(cmdPattern)
  if (idx < 0) return []
  // Get the portion after the command name
  const after = command.slice(idx).split(/\s+/).slice(1)
  return after.filter(a => a && !a.startsWith("-")).slice(0, 5)
}

/** Check if a path is within the project root. */
function isInScope(absPath: string, projectRoot: string): boolean {
  const rel = relative(resolve(projectRoot), resolve(absPath))
  return !rel.startsWith("..") && !rel.startsWith(`${sep}${sep}`)
}

// ── Main API ──

/**
 * Analyze a shell command for side effects.
 * Pure function — does not execute anything.
 */
export function analyzeSideEffects(command: string, projectRoot: string): SideEffectReport {
  const findings: SideEffectFinding[] = []
  const outOfScopeFiles: string[] = []

  for (const pattern of SIDE_EFFECT_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.regex.lastIndex = 0
    const match = pattern.regex.exec(command)
    if (!match) continue

    const paths = pattern.extractPaths
      ? pattern.extractPaths(match, command)
      : []

    // Check scope for each extracted path
    for (const p of paths) {
      try {
        const abs = resolve(projectRoot, p)
        if (!isInScope(abs, projectRoot)) {
          outOfScopeFiles.push(p)
        }
      } catch {
        // Malformed path — flag it
        outOfScopeFiles.push(p)
      }
    }

    findings.push({
      category: pattern.category,
      pattern: pattern.regex.source.slice(1, 40),
      description: pattern.description,
      affectedPaths: paths,
    })
  }

  // Determine severity
  let severity: SideEffectReport["severity"] = "none"
  if (findings.length > 0) severity = "warning"
  // git_destructive or permission_change outside scope → danger
  if (findings.some(f => f.category === "git_destructive" || f.category === "permission_change")) {
    severity = outOfScopeFiles.length > 0 ? "danger" : "warning"
  }

  return { command, findings, outOfScopeFiles, severity }
}

/**
 * Check if a list of actually-changed files (from PathGuard.diff) contains
 * any files outside the expected scope. Returns files that changed but were
 * NOT in the expected set and are NOT within the project root.
 */
export function checkScopeViolations(
  changedFiles: string[],
  expectedScope: string[],
  projectRoot: string,
): string[] {
  const expected = new Set(expectedScope.map(p => resolve(projectRoot, p)))
  const violations: string[] = []
  for (const f of changedFiles) {
    const abs = resolve(projectRoot, f)
    if (expected.has(abs)) continue // expected change — not a violation
    if (!isInScope(abs, projectRoot)) {
      violations.push(f)
    }
  }
  return violations
}

/**
 * Format a side-effect report for injection into the agent context.
 */
export function formatSideEffectReport(report: SideEffectReport): string {
  if (report.severity === "none") return ""

  const yellow = (s: string) => `\x1b[1;33m${s}\x1b[0m`
  const red = (s: string) => `\x1b[1;31m${s}\x1b[0m`
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

  const lines: string[] = []
  const color = report.severity === "danger" ? red : yellow

  lines.push(color(`[Shell 副作用] ${report.command.slice(0, 80)}`))
  lines.push("")

  for (const f of report.findings) {
    const icon = f.category === "git_destructive" ? "⚠" : "•"
    lines.push(`  ${icon} ${f.description}`)
    if (f.affectedPaths.length > 0) {
      for (const p of f.affectedPaths.slice(0, 3)) {
        lines.push(`    ${dim(p)}`)
      }
    }
  }

  if (report.outOfScopeFiles.length > 0) {
    lines.push("")
    lines.push(red(`  ⚠ 范围外文件: ${report.outOfScopeFiles.length} 个`))
    for (const p of report.outOfScopeFiles.slice(0, 5)) {
      lines.push(`    ${dim(p)}`)
    }
  }

  return lines.join("\n")
}

/** Quick check: does a command have any detectable side effects? */
export function hasSideEffects(command: string): boolean {
  for (const pattern of SIDE_EFFECT_PATTERNS) {
    pattern.regex.lastIndex = 0
    if (pattern.regex.test(command)) return true
  }
  return false
}
