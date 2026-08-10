/** Tool Runtime 2.0 (RT-9): Repo Map — semantic-first code intelligence.
 *
 *  build_repo_map     — scan a project: entrypoints, ranked symbols, import
 *                       dependency edges, related tests, token estimate.
 *  query_repo_map     — look up a symbol with authority + confidence.
 *  build_context_slice — entry file + dependencies within a token budget.
 *
 *  Priority chain (plan §5 RT-9): TypeScript compiler AST → ripgrep fallback.
 *  Text fallbacks always declare authority: "text" and lower confidence.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import * as ts from "typescript"
import type { ToolDef, ToolExecutionContext, ToolResult } from "./registry"
import { Result } from "./registry"
import { isWithin } from "./path-authority"

const SKIP_DIRS = new Set([".git", ".orcana", "node_modules", "__pycache__", ".pytest_cache", ".venv", "dist", "build", ".next"])
const TS_EXT = new Set(["ts", "tsx"])

/** RC-19 Phase 2 (D7): the scan root. The execution authority wins; the
 *  legacy `cwd` param survives only as an explicit test/CLI injection and is
 *  gated against the authority when one is present. NEVER process.cwd(). */
function repoScanRoot(context: ToolExecutionContext | undefined, params: Record<string, unknown>): string | undefined {
  const authority = context?.projectRoot
  const paramCwd = typeof params["cwd"] === "string" ? String(params["cwd"]) : undefined
  if (authority) {
    if (paramCwd && !isWithin(authority, resolve(paramCwd))) {
      return undefined // param cwd escapes the authority → cross-project
    }
    return authority
  }
  return paramCwd
}

export interface RepoSymbol {
  name: string
  file: string
  line: number
  kind: "function" | "class" | "interface" | "type" | "const" | "method" | "unknown"
  authority: "compiler" | "ast" | "text"
  confidence: number
}

export interface DependencyEdge {
  from: string
  to: string
}

export interface RepoMap {
  entrypoints: string[]
  rankedSymbols: RepoSymbol[]
  dependencyEdges: DependencyEdge[]
  relatedTests: string[]
  tokenEstimate: number
  provenance: "compiler" | "text"
  scannedFiles: number
}

function walkTsFiles(root: string, maxFiles = 500): string[] {
  const files: string[] = []
  const visit = (dir: string) => {
    if (files.length >= maxFiles) return
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      if (files.length >= maxFiles) return
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (st.isDirectory()) visit(full)
        else if (TS_EXT.has(name.split(".").pop() ?? "")) files.push(full)
      } catch { continue }
    }
  }
  visit(root)
  return files
}

/** Extract exported symbols + import edges from one TS file. */
function analyzeTsFile(file: string): { symbols: RepoSymbol[]; imports: string[] } {
  const content = readFileSync(file, "utf-8")
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true)
  const symbols: RepoSymbol[] = []
  const imports: string[] = []
  const lineOf = (pos: number) => source.getLineAndCharacterOfPosition(pos).line

  const isExported = (node: ts.Node): boolean =>
    Boolean((node as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text)
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text)
    }
    let name: string | undefined
    let kind: RepoSymbol["kind"] = "unknown"
    if (ts.isFunctionDeclaration(node)) { name = node.name?.text; kind = "function" }
    else if (ts.isClassDeclaration(node)) { name = node.name?.text; kind = "class" }
    else if (ts.isInterfaceDeclaration(node)) { name = node.name?.text; kind = "interface" }
    else if (ts.isTypeAliasDeclaration(node)) { name = node.name.text; kind = "type" }
    else if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          symbols.push({ name: decl.name.text, file, line: lineOf(node.getStart(source)), kind: "const", authority: "ast", confidence: 0.95 })
        }
      }
      name = undefined
    }
    if (name && isExported(node)) {
      symbols.push({ name, file, line: lineOf(node.getStart(source)), kind, authority: "ast", confidence: 0.95 })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { symbols, imports }
}

/** Reference count of a symbol name across the scanned files (rank signal). */
function countReferences(root: string, symbol: RepoSymbol, files: string[]): number {
  let count = 0
  for (const file of files) {
    if (file === symbol.file) continue
    try {
      const content = readFileSync(file, "utf-8")
      const re = new RegExp(`\\b${escapeRegExp(symbol.name)}\\b`, "g")
      count += (content.match(re) ?? []).length
    } catch { continue }
  }
  return count
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function tokenEstimate(text: string | number): number {
  const chars = typeof text === "number" ? text : text.length
  return Math.ceil(chars / 3)
}

export function buildRepoMap(params: { projectRoot: string; entryFile?: string; includeTests?: boolean; maxFiles?: number }): RepoMap {
  const root = params.projectRoot
  const files = walkTsFiles(root, params.maxFiles ?? 500)
  const all: RepoSymbol[] = []
  const edges: DependencyEdge[] = []
  for (const file of files) {
    const rel = relative(root, file).replace(/\\/g, "/")
    const { symbols, imports } = analyzeTsFile(file)
    for (const s of symbols) all.push({ ...s, file: rel })
    for (const imp of imports) {
      edges.push({ from: rel, to: imp })
    }
  }
  // Rank by reference count.
  const ranked = all
    .map((s) => ({ ...s, refs: countReferences(root, s, files) }))
    .sort((a, b) => b.refs - a.refs)
    .map(({ refs, ...s }) => s)

  const entrypoints = params.entryFile
    ? [params.entryFile]
    : ranked.filter((s) => s.kind === "function" || s.kind === "class").slice(0, 5).map((s) => s.file)

  const relatedTests = (params.includeTests ?? true)
    ? files.map((f) => relative(root, f).replace(/\\/g, "/")).filter((f) => /\.test\.|\.spec\./.test(f)).slice(0, 10)
    : []

  const total = files.reduce((n, f) => n + readFileSync(f, "utf-8").length, 0)
  return {
    entrypoints,
    rankedSymbols: ranked.slice(0, 100),
    dependencyEdges: edges.slice(0, 200),
    relatedTests,
    tokenEstimate: tokenEstimate(total),
    provenance: "compiler",
    scannedFiles: files.length,
  }
}

export function queryRepoMap(params: { projectRoot: string; query: string }): RepoSymbol[] {
  const root = params.projectRoot
  const files = walkTsFiles(root, 300)
  const results: RepoSymbol[] = []
  for (const file of files) {
    const rel = relative(root, file).replace(/\\/g, "/")
    const { symbols } = analyzeTsFile(file)
    for (const s of symbols) {
      if (s.name.toLowerCase().includes(params.query.toLowerCase())) results.push({ ...s, file: rel })
    }
  }
  return results.slice(0, 20)
}

// ── Tools ──

const BUILD_REPO_MAP_SCHEMA = {
  type: "object",
  properties: {
    goal: { type: "string", description: "Task goal (used for ranking hints)" },
    entryFile: { type: "string", description: "Optional entry file to anchor entrypoints" },
    includeTests: { type: "boolean", description: "Include related tests (default true)" },
  },
} as const

export const BUILD_REPO_MAP_TOOL: ToolDef = {
  name: "build_repo_map",
  description: "Build a repository map: entrypoints, ranked exported symbols (compiler-AST authority), import dependency edges, related tests, token estimate. Never returns raw repo content.",
  isReadonly: true,
  category: "safe",
  isConcurrencySafe: true,
  inputSchema: BUILD_REPO_MAP_SCHEMA as unknown as Record<string, unknown>,
  execute(params, _onProgress, context) {
    const projectRoot = repoScanRoot(context, params)
    if (!projectRoot) return Result.blocked("build_repo_map requires a projectRoot authority (RC-19 Phase 2)", { gate: "path_authority" })
    const map = buildRepoMap({
      projectRoot,
      entryFile: typeof params["entryFile"] === "string" ? String(params["entryFile"]) : undefined,
      includeTests: params["includeTests"] !== false,
    })
    const lines = [
      `scanned ${map.scannedFiles} TS file(s), ${map.rankedSymbols.length} symbols, ${map.dependencyEdges.length} import edges`,
      `tokenEstimate: ${map.tokenEstimate}`,
      `provenance: ${map.provenance}`,
      "",
      "## Entrypoints",
      ...map.entrypoints.map((e) => `- ${e}`),
      "",
      "## Top symbols",
      ...map.rankedSymbols.slice(0, 15).map((s) => `${s.file}:${s.line + 1}  ${s.kind} ${s.name}  (${s.authority}, conf ${s.confidence})`),
      "",
      "## Related tests",
      ...(map.relatedTests.length ? map.relatedTests.map((t) => `- ${t}`) : ["(none)"]),
    ]
    return Result.ok(lines.join("\n"), { map })
  },
}

const QUERY_REPO_MAP_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string" },
    name: { type: "string", description: "Alias of query" },
  },
  required: ["query"],
} as const

export const QUERY_REPO_MAP_TOOL: ToolDef = {
  name: "query_repo_map",
  description: "Query exported symbols by name across the repo. Each match carries file/line/kind, authority (compiler/ast) and confidence.",
  isReadonly: true,
  category: "safe",
  isConcurrencySafe: true,
  inputSchema: QUERY_REPO_MAP_SCHEMA as unknown as Record<string, unknown>,
  execute(params, _onProgress, context) {
    const query = String(params["query"] ?? "")
    const projectRoot = repoScanRoot(context, params)
    if (!projectRoot) return Result.blocked("query_repo_map requires a projectRoot authority (RC-19 Phase 2)", { gate: "path_authority" })
    if (!query) return Result.fail("query_repo_map requires query")
    const matches = queryRepoMap({ projectRoot, query })
    if (matches.length === 0) return Result.ok("No symbols match", { matches: [] })
    const lines = matches.map((m) => `${m.file}:${m.line + 1}  ${m.kind} ${m.name}  (${m.authority}, conf ${m.confidence})`)
    return Result.ok(lines.join("\n"), { matches })
  },
}

const BUILD_CONTEXT_SLICE_SCHEMA = {
  type: "object",
  properties: {
    goal: { type: "string" },
    entryFile: { type: "string", description: "Entry file to anchor the slice" },
    tokenBudget: { type: "number", description: "Approximate token budget (default 8000)" },
  },
  required: ["entryFile"],
} as const

export const BUILD_CONTEXT_SLICE_TOOL: ToolDef = {
  name: "build_context_slice",
  description: "Build a context slice from an entry file + its direct imports, bounded by a token budget. Never dumps the whole repo.",
  isReadonly: true,
  category: "safe",
  isConcurrencySafe: true,
  inputSchema: BUILD_CONTEXT_SLICE_SCHEMA as unknown as Record<string, unknown>,
  execute(params, _onProgress, context) {
    const entryFile = String(params["entryFile"] ?? "")
    const budget = Number(params["tokenBudget"] ?? 8000)
    const projectRoot = repoScanRoot(context, params)
    if (!projectRoot) return Result.blocked("build_context_slice requires a projectRoot authority (RC-19 Phase 2)", { gate: "path_authority" })
    const entry = join(projectRoot, entryFile)
    if (!existsSync(entry)) return Result.fail(`entry file not found: ${entryFile}`)

    const seen = new Set<string>()
    const parts: string[] = []
    let used = 0
    const collect = (file: string) => {
      if (used >= budget || seen.has(file)) return
      seen.add(file)
      try {
        const content = readFileSync(file, "utf-8")
        const rel = relative(projectRoot, file).replace(/\\/g, "/")
        const est = tokenEstimate(content)
        if (used + est > budget && parts.length > 0) return
        parts.push(`// ── ${rel} ──\n${content}`)
        used += est
        const { imports } = analyzeTsFile(file)
        for (const imp of imports) {
          const candidate = resolve(file, "..", imp) + ".ts"
          if (existsSync(candidate)) collect(candidate)
        }
      } catch { /* skip unreadable */ }
    }
    collect(entry)
    return Result.ok(parts.join("\n\n"), { files: [...seen].map((f) => relative(projectRoot, f).replace(/\\/g, "/")), usedTokens: used, budget })
  },
}
