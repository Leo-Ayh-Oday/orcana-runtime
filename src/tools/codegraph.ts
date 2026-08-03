/** Code intelligence — project scan, symbol search, references. Uses ripgrep when available. */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs"
import { resolve, relative, join } from "node:path"
import { execSync } from "node:child_process"
import type { ToolDef, ToolResult } from "./registry"
import { Result } from "./registry"

const SKIP_DIRS = new Set([".git", ".orcana", "node_modules", "__pycache__", ".pytest_cache", ".venv", "dist", "build", ".next"])
const SKIP_FILES = new Set(["deepseek-run.out.txt", "deepseek-run.err.txt"])

let _rgAvailable: boolean | null = null

function rgAvailable(): boolean {
  if (_rgAvailable !== null) return _rgAvailable
  try { execSync("rg --version", { stdio: "ignore", timeout: 2000 }); _rgAvailable = true } catch { _rgAvailable = false }
  return _rgAvailable
}

// Node-based fallback for Windows when ripgrep is absent.
function grepNode(pattern: string, extPattern: string, maxResults = 20): Array<{ file: string; line: string; text: string }> {
  const results: Array<{ file: string; line: string; text: string }> = []
  const exts = (extPattern.match(/\{([^}]+)\}/)?.[1] ?? "ts,tsx").split(",").map(e => e.startsWith("*.") ? e.slice(2) : e)
  try {
    const regex = new RegExp(pattern, "i")
    const cwd = process.cwd()
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
              results.push({ file: relative(cwd, full).replace(/\\/g, "/"), line: "", text: ll.trim().slice(0, 200) })
            }
          }
        } catch { continue }
      }
    }
    walk(cwd)
  } catch { /* best-effort */ }
  return results
}

function grep(pattern: string, glob = "*.{ts,tsx,js,jsx,py,rs,go}", maxResults = 20): Array<{ file: string; line: string; text: string }> {
  if (rgAvailable()) {
    try {
      const results: Array<{ file: string; line: string; text: string }> = []
      const out = execSync(`rg -n --no-heading -g "${glob}" -e "${pattern}" .`, {
        encoding: "utf-8", timeout: 10000, maxBuffer: 5 * 1024 * 1024,
      })
      for (const line of out.trim().split("\n").slice(0, maxResults)) {
        if (!line) continue
        const idx1 = line.indexOf(":")
        const idx2 = line.indexOf(":", idx1 + 1)
        if (idx1 > 0 && idx2 > 0) {
          results.push({ file: line.slice(0, idx1), line: line.slice(idx1 + 1, idx2), text: line.slice(idx2 + 1).trim() })
        }
      }
      return results
    } catch { /* rg failed, fall through */ }
  }
  return grepNode(pattern, glob, maxResults)
}

async function find_symbol(params: Record<string, unknown>): Promise<ToolResult> {
  const name = String(params.name ?? "")
  const kind = String(params.kind ?? "")
  const pattern = kind === "function" ? `(def|async def)\\s+${name}\\b` :
    kind === "class" ? `class\\s+${name}\\b` :
    `(def|class)\\s+${name}\\b|${name}\\s*[:=]`

  const results = grep(pattern, "*.{py,ts,tsx,js,jsx,rs,go}", Number(params.max_results ?? 15))
  if (!results.length) return Result.ok(`Symbol '${name}' not found`)

  const lines = [`Found ${results.length} match(es) for '${name}':`]
  results.forEach(r => lines.push(`  ${r.file}:${r.line}  ${r.text}`))
  return Result.ok(lines.join("\n"))
}

async function find_references(params: Record<string, unknown>): Promise<ToolResult> {
  const name = String(params.name ?? "")
  const results = grep(`\\b${name}\\b`, "*.{py,ts,tsx,js,jsx,rs,go}", Number(params.max_results ?? 20))
  if (!results.length) return Result.ok(`No references for '${name}'`)

  const lines = [`${results.length} reference(s) to '${name}':`]
  results.forEach(r => lines.push(`  ${r.file}:${r.line}  ${r.text}`))
  return Result.ok(lines.join("\n"))
}

async function project_structure(params: Record<string, unknown>): Promise<ToolResult> {
  const root = String(params.path ?? ".")
  const maxDepth = Number(params.max_depth ?? 3)

  const lines = [
    `Target project: ${resolve(root)}`,
    "Boundary: this tree is the user's project. Runtime artifacts such as .orcana are excluded.",
  ]
  walk(resolve(root), "", maxDepth, lines)
  return Result.ok(lines.slice(0, 100).join("\n"))
}

function walk(dir: string, prefix: string, maxDepth: number, out: string[], depth = 0) {
  if (depth >= maxDepth) return
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && SKIP_DIRS.has(entry.name)) continue
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
  execute: find_symbol,
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
  execute: find_references,
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
  execute: project_structure,
}

export const CODEGRAPH_TOOLS: ToolDef[] = [FIND_SYMBOL, FIND_REFERENCES, PROJECT_STRUCTURE]
