/** Staged context — aligned with DeepSeek V4 tri-attention.
 *  Ported from deepseek-code/core/context.py */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs"
import { resolve, relative, join, dirname } from "node:path"

// ── File ordering ──

const ENTRY = new Set(["main.py","app.py","cli.py","ds.py","index.py","run.py","index.ts","main.ts","app.ts"])
const CORE = ["engine","core/","service","model","domain","api","handler","router","agent","provider"]
const UTIL = ["util","helper","config","setting","constant","logger","format","convert","hooks"]
const TEST = ["test_","_test","spec_","_spec","conftest"]

function priorityScore(path: string): number {
  const name = path.toLowerCase()
  for (const p of ENTRY) if (name.includes(p) || name.endsWith(p)) return 0
  for (const p of CORE) if (name.includes(p)) return 1
  for (const p of UTIL) if (name.includes(p)) return 2
  for (const p of TEST) if (name.includes(p)) return 3
  return 4
}

/** Clip source context without leaving an incomplete source escape at the end.
 * DeepSeek's Anthropic-compatible parser rejects message content ending in a
 * partial `\xNN` / `\uNNNN` sequence even though the outer JSON is valid. */
export function clipProviderContext(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  const marker = `\n[context clipped from ${content.length} chars]`
  const budget = Math.max(0, maxChars - marker.length)
  let clipped = content.slice(0, budget)
  const lastNewline = clipped.lastIndexOf("\n")
  if (lastNewline >= Math.floor(budget * 0.75)) clipped = clipped.slice(0, lastNewline)
  clipped = clipped.replace(/\\(?:x[0-9a-fA-F]{0,1}|u[0-9a-fA-F]{0,3})?$/, "")
  const lastCodeUnit = clipped.charCodeAt(clipped.length - 1)
  if (lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF) clipped = clipped.slice(0, -1)
  return clipped + marker
}

// ── Project scanner ──

const SKIP = new Set([".git","__pycache__",".pytest_cache","node_modules",".venv","venv","dist","build",".egg-info",".codegraph",".obsidian",".wolf",".deepseek-code"])

export function scanProject(root: string, maxDepth = 3): string {
  const lines = [
    `Target project: ${resolve(root).split(/[\\/]/).pop()}`,
    "Boundary: this is the user's project; assistant runtime artifacts are excluded.",
  ]

  function walk(dir: string, depth: number) {
    if (depth >= maxDepth) return
    let entries: string[] = []
    try { entries = readdirSync(dir, { withFileTypes: true }).filter(e => !SKIP.has(e.name) && !(e.name.startsWith(".") && e.name !== ".env.example")).map(e => e.name + (e.isDirectory() ? "/" : "")) } catch { return }
    entries.sort()

    for (const entry of entries) {
      const full = join(dir, entry)
      const prefix = "  ".repeat(depth) + "├─ "
      const name = entry.endsWith("/") ? entry.slice(0, -1) : entry
      const isDir = entry.endsWith("/")

      let annotation = ""
      if (!isDir) {
        if (["CLAUDE.md","AGENTS.md","README.md"].includes(name)) annotation = " ← rules"
        else if (name === "package.json" || name === "pyproject.toml") annotation = " ← deps"
        else if ([...ENTRY].some(p => name.includes(p) || name.endsWith(p))) annotation = " ← entry"
        else if (CORE.some(p => name.toLowerCase().includes(p))) annotation = " ← core"
      }
      lines.push(`${prefix}${name}${annotation}`)
      if (isDir) walk(join(dir, name), depth + 1)
      if (lines.length >= 80) return
    }
  }

  walk(root, 0)
  return lines.slice(0, 80).join("\n")
}

// ── Staged context manager ──

export interface ContextLayer {
  name: string
  content: string
  source: string
  tokenEstimate: number
}

export interface HybridContext {
  hot: ContextLayer[]
  warm: ContextLayer[]
  cold: ContextLayer[]
  estimateTokens(): number
  toPromptText(): string
}

export function createHybridContext(): HybridContext {
  const hot: ContextLayer[] = []
  const warm: ContextLayer[] = []
  const cold: ContextLayer[] = []
  return {
    hot, warm, cold,
    estimateTokens() { return [...this.hot, ...this.warm, ...this.cold].reduce((s,l) => s + l.tokenEstimate, 0) },
    toPromptText() {
      const p: string[] = []
      if (cold.length) { p.push("## Project\n"); for (const l of cold) p.push(l.content + "\n") }
      if (warm.length) { p.push("## Active Files\n"); for (const l of warm) p.push(`### ${l.source}\n${l.content}\n`) }
      if (hot.length) { p.push("## Focus\n"); for (const l of hot) p.push(`### ${l.source}\n${l.content}\n`) }
      return p.join("\n")
    },
  }
}

export class StagedContextManager {
  projectRoot: string
  loadedFiles: Map<string, string> = new Map()
  roundSummaries: string[] = []
  isFirstRound = true
  maxActive = 12

  constructor(projectRoot: string) { this.projectRoot = resolve(projectRoot) }

  buildContext(): HybridContext {
    const ctx = createHybridContext()

    const coldLines = [scanProject(this.projectRoot)]
    if (this.roundSummaries.length) {
      coldLines.push("## Previous Actions\n" + this.roundSummaries.slice(-3).map(s => `- ${s}`).join("\n"))
    }
    ctx.cold.push({ name: "cold", content: coldLines.join("\n"), source: "project-index", tokenEstimate: 800 })

    if (this.loadedFiles.size > 0) {
      const sorted = [...this.loadedFiles.entries()].sort((a, b) => priorityScore(a[0]) - priorityScore(b[0]))
      for (const [path, content] of sorted.slice(0, this.maxActive)) {
        const truncated = clipProviderContext(content, 4000)
        ctx.warm.push({ name: "warm", content: truncated, source: path, tokenEstimate: Math.ceil(truncated.length / 3) })
      }
    }
    return ctx
  }

  markLoaded(path: string) {
    const full = join(this.projectRoot, path)
    if (existsSync(full) && !this.loadedFiles.has(path)) {
      try { this.loadedFiles.set(path, readFileSync(full, "utf-8")) } catch { /* */ }
    }
  }

  markEdited(path: string) {
    const full = join(this.projectRoot, path)
    if (existsSync(full)) {
      try { this.loadedFiles.set(path, readFileSync(full, "utf-8")) } catch { /* */ }
    }
  }

  addSummary(s: string) { this.roundSummaries.push(s) }
  advance() { this.isFirstRound = false }

  /**
   * Fork stable (L1) context for a sub-agent.
   *
   * The sub-agent inherits the same system prompt, rules, and project structure
   * (L1/stable) so the prefix cache hits. Volatile context (L2) contains only
   * the task-specific instructions, tool whitelist, and task description.
   *
   * Inspired by Claude Code coordinatorMode.ts Worker context pattern.
   */
  forkStableContext(subTask: {
    description: string
    /** Tool names the sub-agent can use */
    allowedTools?: string[]
    /** Additional context specific to this subtask */
    extraContext?: string
  }): { stableContext: string; volatileContext: string; cachePointIndex: number } {
    // L1 stable: project structure + loaded files (the "prefix" for cache)
    const stableCtx = createHybridContext()
    const coldLines = [scanProject(this.projectRoot)]
    stableCtx.cold.push({ name: "cold", content: coldLines.join("\n"), source: "project-index", tokenEstimate: 800 })

    if (this.loadedFiles.size > 0) {
      const sorted = [...this.loadedFiles.entries()]
        .sort((a, b) => priorityScore(a[0]) - priorityScore(b[0]))
      for (const [path, content] of sorted.slice(0, this.maxActive)) {
        const truncated = clipProviderContext(content, 2000)
        stableCtx.warm.push({ name: "warm", content: truncated, source: path, tokenEstimate: Math.ceil(truncated.length / 3) })
      }
    }

    const stableText = stableCtx.toPromptText()

    // L2 volatile: task-specific only
    const volatileParts = [
      "## Sub-task",
      subTask.description,
    ]
    if (subTask.allowedTools?.length) {
      volatileParts.push("", "## Available tools", subTask.allowedTools.sort().join(", "))
    }
    if (subTask.extraContext) {
      volatileParts.push("", subTask.extraContext)
    }
    const volatileText = volatileParts.join("\n")

    // cachePointIndex = where the child starts diverging from parent
    const stableLines = stableText.split("\n").length

    return {
      stableContext: stableText,
      volatileContext: volatileText,
      cachePointIndex: stableLines,
    }
  }
}
