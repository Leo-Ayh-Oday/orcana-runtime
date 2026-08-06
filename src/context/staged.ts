/** Staged context — aligned with DeepSeek V4 tri-attention.
 *  Ported from orcana/core/context.py */

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

const SKIP = new Set([".git","__pycache__",".pytest_cache","node_modules",".venv","venv","dist","build",".egg-info",".codegraph",".obsidian",".wolf",".orcana"])

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

// ── K37: file cache freshness ──

/** FNV-1a digest — mirror of the harness `contentDigest`
 *  (src/harness/context/request.ts, K54): same algorithm and seed, so
 *  digests produced here compare byte-for-byte with harness freshness
 *  contracts. Kept local (not imported from harness) to avoid a
 *  src/context → src/harness dependency edge. */
export function fileContentDigest(content: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/** Cached file content with K37 freshness metadata.
 *  `mtimeMs` is the mtime at read time; an entry without it (legacy cache
 *  structure — a plain string) is treated as needing refresh. */
export interface FileCacheEntry {
  content: string
  mtimeMs?: number
  /** FNV-1a digest of `content` (K40-aligned with harness K54 contracts). */
  digest?: string
}

// ── K38: relevance ranking ──

/** English function words — never meaningful task terms. */
const STOPWORDS = new Set([
  "the","and","that","this","with","for","from","your","you","not","are","was",
  "were","will","have","has","been","into","does","do","is","in","on","of","to",
  "it","we","our","they","their","or","but","be","as","at","by","can","could",
  "should","would","about","how","what","why","when","where","which","who",
  "all","any","please","me","my","too","very","just","only","then","than",
])

/** Cheap term extraction (no embedding, no new deps): latin identifiers +
 *  CJK bigrams from the task text. Deterministic. */
function extractPromptTerms(prompt: string): string[] {
  const terms = new Set<string>()
  for (const t of (prompt.toLowerCase().match(/[a-z][a-z0-9_.\-]*/g) ?? [])) {
    if (t.length >= 3 && !STOPWORDS.has(t)) terms.add(t)
  }
  for (const run of (prompt.match(/[一-鿿]+/g) ?? [])) {
    if (run.length >= 2) {
      for (let i = 0; i + 2 <= run.length && terms.size < 48; i++) terms.add(run.slice(i, i + 2))
    }
  }
  return [...terms].slice(0, 48)
}

/** Relevance penalty for one file vs the current task text: 0 = perfect
 *  match, 99 = no overlap. Content keyword hits (70%) + filename/title hits
 *  (30%). Empty prompt → 0 (no behavior change). */
function relevancePenalty(content: string, path: string, prompt: string): number {
  if (!prompt.trim()) return 0
  const terms = extractPromptTerms(prompt)
  if (!terms.length) return 0
  const lower = content.toLowerCase()
  const nameLower = path.toLowerCase()
  let contentHits = 0
  let nameHits = 0
  for (const t of terms) {
    if (lower.includes(t)) contentHits++
    if (nameLower.includes(t)) nameHits++
  }
  const contentRatio = contentHits / terms.length
  const nameRatio = nameHits / terms.length
  return Math.round(99 * (1 - (0.7 * contentRatio + 0.3 * nameRatio)))
}

/** Sort key: mechanical baseline (priorityScore) stays dominant (×100, so a
 *  band never overturns on relevance); relevance breaks ties inside the same
 *  band. Lower = better; stable sort keeps insertion order for equal keys. */
function rankKey(file: readonly [path: string, content: string], prompt: string): number {
  return priorityScore(file[0]) * 100 + relevancePenalty(file[1], file[0], prompt)
}

/** Normalize a cache value into content (K37: legacy plain-string entries
 *  have no meta and are re-read on refresh; here just unwrap). */
function cacheContent(value: string | FileCacheEntry): string {
  return typeof value === "string" ? value : value.content
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
  /** Path → cached content (K37). Values may be legacy plain strings (no
   *  freshness meta — treated as needing refresh) or FileCacheEntry. */
  loadedFiles: Map<string, string | FileCacheEntry> = new Map()
  roundSummaries: string[] = []
  isFirstRound = true
  maxActive = 12

  constructor(projectRoot: string) { this.projectRoot = resolve(projectRoot) }

  /** Injectable file reader — tests spy on this to assert cache reuse
   *  (K37: unchanged files must not be re-read). */
  readFileContent(fullPath: string): string {
    return readFileSync(fullPath, "utf-8")
  }

  /** K37: re-validate every cached file against its mtime and re-read any
   *  entry that drifted on disk (or is a legacy entry without meta). Files
   *  that vanished keep their last known content; failed reads keep the old
   *  entry — never drop cached data silently.
   *
   *  Detection is stat-only (cheap); the stored FNV-1a digest (K40-aligned
   *  with harness K54 contracts) is available for any consumer that wants
   *  content-level verification. Known caveat: on some filesystems (observed
   *  on WSL2 ext4) two writes to the same file landing in one journal
   *  transaction may not bump mtime — real-world edits are spaced out and
   *  update mtime normally, so this is a stat/display staleness edge, not
   *  the write path (markEdited always re-reads). */
  refreshLoadedFiles(): { refreshed: string[]; reused: string[] } {
    const refreshed: string[] = []
    const reused: string[] = []
    for (const [path, cached] of [...this.loadedFiles]) {
      const full = join(this.projectRoot, path)
      let mtime: number | null = null
      try { mtime = existsSync(full) ? statSync(full).mtimeMs : null } catch { mtime = null }
      if (mtime === null) continue // file gone — keep last known content
      if (typeof cached !== "string" && cached.mtimeMs === mtime) {
        reused.push(path)
        continue
      }
      try {
        const content = this.readFileContent(full)
        this.loadedFiles.set(path, { content, mtimeMs: mtime, digest: fileContentDigest(content) })
        refreshed.push(path)
      } catch {
        reused.push(path) // read failed — keep the old entry rather than drop it
      }
    }
    return { refreshed, reused }
  }

  buildContext(prompt = ""): HybridContext {
    this.refreshLoadedFiles()
    const ctx = createHybridContext()

    const coldLines = [scanProject(this.projectRoot)]
    if (this.roundSummaries.length) {
      coldLines.push("## Previous Actions\n" + this.roundSummaries.slice(-3).map(s => `- ${s}`).join("\n"))
    }
    ctx.cold.push({ name: "cold", content: coldLines.join("\n"), source: "project-index", tokenEstimate: 800 })

    if (this.loadedFiles.size > 0) {
      const sorted = [...this.loadedFiles.entries()]
        .map(([path, v]): [string, string] => [path, cacheContent(v)])
        .sort((a, b) => rankKey(a, prompt) - rankKey(b, prompt))
      for (const [path, content] of sorted.slice(0, this.maxActive)) {
        const truncated = clipProviderContext(content, 4000)
        ctx.warm.push({ name: "warm", content: truncated, source: path, tokenEstimate: Math.ceil(truncated.length / 3) })
      }
    }
    return ctx
  }

  markLoaded(path: string) {
    const full = join(this.projectRoot, path)
    if (!existsSync(full)) return
    const cached = this.loadedFiles.get(path)
    let mtime: number | null = null
    try { mtime = statSync(full).mtimeMs } catch { return }
    if (cached !== undefined && typeof cached !== "string" && cached.mtimeMs === mtime) return
    try {
      const content = this.readFileContent(full)
      this.loadedFiles.set(path, { content, mtimeMs: mtime, digest: fileContentDigest(content) })
    } catch { /* keep existing */ }
  }

  markEdited(path: string) {
    const full = join(this.projectRoot, path)
    if (!existsSync(full)) return
    try {
      const content = this.readFileContent(full)
      this.loadedFiles.set(path, { content, mtimeMs: statSync(full).mtimeMs, digest: fileContentDigest(content) })
    } catch { /* */ }
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
   * K40: the stable part carries ONLY immutable sources (the project
   * skeleton). Mutable file content (loadedFiles) must not ride the stable
   * prefix — a cached fork of it would keep serving stale bytes (cache hit
   * ≠ correct). Loaded files move to the volatile part, where the harness
   * staged-context provider already attaches a {kind:"file", digest}
   * freshness contract (K54) for drift detection, and get re-validated
   * against disk mtime on every fork.
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
    // L1 stable: immutable project structure only (the "prefix" for cache)
    const stableCtx = createHybridContext()
    const coldLines = [scanProject(this.projectRoot)]
    stableCtx.cold.push({ name: "cold", content: coldLines.join("\n"), source: "project-index", tokenEstimate: 800 })
    const stableText = stableCtx.toPromptText()

    // L2 volatile: task-specific + mutable loaded files (K40: files live
    // here, not in the stable prefix), relevance-ranked against the task.
    const volatileParts = [
      "## Sub-task",
      subTask.description,
    ]
    if (subTask.allowedTools?.length) {
      volatileParts.push("", "## Available tools", subTask.allowedTools.sort().join(", "))
    }
    if (this.loadedFiles.size > 0) {
      this.refreshLoadedFiles()
      const sorted = [...this.loadedFiles.entries()]
        .map(([path, v]): [string, string] => [path, cacheContent(v)])
        .sort((a, b) => rankKey(a, subTask.description) - rankKey(b, subTask.description))
      const fileParts: string[] = []
      for (const [path, content] of sorted.slice(0, this.maxActive)) {
        fileParts.push(`### ${path}\n${clipProviderContext(content, 2000)}`)
      }
      volatileParts.push("", "## Loaded files", fileParts.join("\n"))
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
