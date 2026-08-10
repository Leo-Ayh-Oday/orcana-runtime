/** Code intelligence — project scan, symbol search, references. Uses ripgrep when available. */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs"
import { resolve, relative, join } from "node:path"
import type { ToolDef, ToolExecutionContext, ToolResult } from "./registry"
import { collectProcessRun } from "../runtime/process-executor"
import { Result } from "./registry"
import { resolveToolPath } from "./path-authority"

const SKIP_DIRS = new Set([".git", ".orcana", "node_modules", "__pycache__", ".pytest_cache", ".venv", "dist", "build", ".next"])
const SKIP_FILES = new Set(["deepseek-run.out.txt", "deepseek-run.err.txt"])

let _rgAvailable: Promise<boolean> | null = null

function rgAvailable(): Promise<boolean> {
  if (_rgAvailable !== null) return _rgAvailable
  _rgAvailable = (async () => {
    try {
      await collectProcessRun({ command: "rg", args: ["--version"], timeoutMs: 2000 })
      return true
    } catch {
      return false
    }
  })()
  return _rgAvailable
}

// Node-based fallback for Windows when ripgrep is absent.
// RC-19 Phase 2 (D7): scans root, never process.cwd() — results are
// root-relative so the same call yields the same output from any cwd.
function grepNode(root: string, pattern: string, extPattern: string, maxResults = 20): Array<{ file: string; line: string; text: string }> {
  const results: Array<{ file: string; line: string; text: string }> = []
  const exts = (extPattern.match(/\{([^}]+)\}/)?.[1] ?? "ts,tsx").split(",").map(e => e.startsWith("*.") ? e.slice(2) : e)
  try {
    const regex = new RegExp(pattern, "i")
    const walk = (dir: string) => {
      if (results.length >= maxResults) return
      let entries: string[]; try { entries = readdirSync(dir) } catch { return }
      for (const name of entries) {
        if (name.startsWith(".") || SKIP_DIRS.has(name)) continue
        const full = join(dir, name)
        try {
          const st = statSync(full)
          if (st.isDirectory()) { walk(full); continue }
          if (!exts.some(e => name.endsWith("." + e) || name.endsWith(e))) continue
          const content = readFileSync(full, "utf-8")
          for (const ll of content.split("\n")) {
            if (results.length >= maxResults) return
            if (regex.test(ll)) {
              results.push({ file: relative(root, full).replace(/\\/g, "/"), line: "", text: ll.trim().slice(0, 200) })
            }
          }
        } catch { continue }
      }
    }
    walk(root)
  } catch { /* best-effort */ }
  return results
}

async function grep(root: string, pattern: string, glob = "*.{ts,tsx,js,jsx,py,rs,go}", maxResults = 20): Promise<Array<{ file: string; line: string; text: string }>> {
  if (await rgAvailable()) {
    try {
      const results: Array<{ file: string; line: string; text: string }> = []
      // Scan the authoritative root explicitly (never `.` — that is cwd);
      // file paths come out root-prefixed and are stripped back to relative.
      const out = await collectProcessRun({ command: "rg", args: ["-n", "--no-heading", "-g", glob, "-e", pattern, root], timeoutMs: 10000 })
      const rootPrefix = resolve(root) + "/"
      for (const line of out.stdout.trim().split("\n").slice(0, maxResults)) {
        if (!line) continue
        const idx1 = line.indexOf(":")
        const idx2 = line.indexOf(":", idx1 + 1)
        if (idx1 > 0 && idx2 > 0) {
          const raw = line.slice(0, idx1)
          const file = raw.startsWith(rootPrefix) ? raw.slice(rootPrefix.length) : raw
          results.push({ file: file.replace(/\\/g, "/"), line: line.slice(idx1 + 1, idx2), text: line.slice(idx2 + 1).trim() })
        }
      }
      return results
    } catch { /* rg failed, fall through */ }
  }
  return grepNode(root, pattern, glob, maxResults)
}

/** RC-19 Phase 2 (D7): the scan root comes from the execution authority —
 *  absent root fails closed (no cwd fallback). */
function scanRoot(context: ToolExecutionContext | undefined): string | undefined {
  return context?.projectRoot || undefined
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function find_symbol(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
  const name = String(params.name ?? "")
  const kind = String(params.kind ?? "")
  const root = scanRoot(context)
  if (!root) return Result.blocked("find_symbol requires a projectRoot authority (RC-19 Phase 2)", { gate: "path_authority" })
  const escaped = escapeRegExp(name)
  const pattern = kind === "function" ? `(def|async def)\\s+${escaped}\\b` :
    kind === "class" ? `class\\s+${escaped}\\b` :
    `(def|class)\\s+${escaped}\\b|${escaped}\\s*[:=]`

  const results = await grep(root, pattern, "*.{py,ts,tsx,js,jsx,rs,go}", Number(params.max_results ?? 15))
  if (!results.length) return Result.ok(`Symbol '${name}' not found`)

  const lines = [`Found ${results.length} match(es) for '${name}':`]
  results.forEach(r => lines.push(`  ${r.file}:${r.line}  ${r.text}`))
  return Result.ok(lines.join("\n"))
}

async function find_references(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
  const name = String(params.name ?? "")
  const root = scanRoot(context)
  if (!root) return Result.blocked("find_references requires a projectRoot authority (RC-19 Phase 2)", { gate: "path_authority" })
  const results = await grep(root, `\\b${escapeRegExp(name)}\\b`, "*.{py,ts,tsx,js,jsx,rs,go}", Number(params.max_results ?? 20))
  if (!results.length) return Result.ok(`No references for '${name}'`)

  const lines = [`${results.length} reference(s) to '${name}':`]
  results.forEach(r => lines.push(`  ${r.file}:${r.line}  ${r.text}`))
  return Result.ok(lines.join("\n"))
}

async function project_structure(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
  // RC-19 Phase 2 (D7): the default "." binds to projectRoot — never cwd.
  const rawRoot = String(params.path ?? ".")
  const resolution = resolveToolPath(context, rawRoot, "read")
  if (!resolution.ok) return Result.blocked(resolution.message, { gate: "path_authority" })
  const root = resolution.path
  const maxDepth = Number(params.max_depth ?? 3)

  const lines = [
    `Target project: ${root}`,
    "Boundary: user source tree only. Hidden entries, Runtime artifacts (.orcana), and dependency/build directories (node_modules, dist, build, .next, __pycache__, .venv) are skipped.",
  ]
  walk(root, "", maxDepth, lines)
  return Result.ok(lines.slice(0, 100).join("\n"))
}

function walk(dir: string, prefix: string, maxDepth: number, out: string[], depth = 0) {
  if (depth >= maxDepth) return
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue
      if (entry.isFile() && SKIP_FILES.has(entry.name)) continue
      const indent = "  ".repeat(depth) + "├─ "
      if (entry.isDirectory()) {
        out.push(`${indent}${entry.name}/`)
        walk(join(dir, entry.name), prefix, maxDepth, out, depth + 1)
      } else {
        out.push(`${indent}${entry.name}`)
        if (out.length >= 100) return
      }
    }
  } catch { /* permission denied */ }
}

export const FIND_SYMBOL: ToolDef = {
  name: "find_symbol",
  description: "Find function, class, or variable definitions by name. Set kind to function, class, or leave empty for all.",
  isReadonly: true,
  category: "safe" as const,
  isConcurrencySafe: true,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Symbol name" },
      kind: { type: "string", description: "Optional: function, class" },
      max_results: { type: "integer", description: "Max results (default 15)" },
    },
    required: ["name"],
  },
  execute: (params, _onProgress, context) => find_symbol(params, context),
}

export const FIND_REFERENCES: ToolDef = {
  name: "find_references",
  description: "Find all references to a symbol across the codebase",
  isReadonly: true,
  category: "safe" as const,
  isConcurrencySafe: true,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Symbol name" },
      max_results: { type: "integer", description: "Max results (default 20)" },
    },
    required: ["name"],
  },
  execute: (params, _onProgress, context) => find_references(params, context),
}

export const PROJECT_STRUCTURE: ToolDef = {
  name: "project_structure",
  description: "Show the target project's directory tree, excluding Orcana runtime artifacts. Use this first when entering a new user project to understand its layout.",
  isReadonly: true,
  category: "safe" as const,
  isConcurrencySafe: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Root path (default: .)" },
      max_depth: { type: "integer", description: "Max depth (default 3)" },
    },
  },
  execute: (params, _onProgress, context) => project_structure(params, context),
}

export const CODEGRAPH_TOOLS: ToolDef[] = [FIND_SYMBOL, FIND_REFERENCES, PROJECT_STRUCTURE]
