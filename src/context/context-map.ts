/** Context Map Pipeline — pre-code context acquisition gate.
 *
 * The pipeline turns "read docs -> inspect structure -> locate code -> read
 * source" into deterministic runtime data. It is deliberately independent from
 * the agent loop so it can be tested and later wired into TaskPacket planning.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { basename, extname, join, relative, resolve, sep } from "node:path"
import ts from "typescript"
import { loadMemoryIndex } from "../memory/context-memory-os"
import type { TaskPacket } from "../agent/task-packet"

// ── Types ──

export interface ProjectConstitution {
  architectureNotes: string[]
  codingRules: string[]
  forbiddenActions: string[]
  buildCommands: string[]
  testCommands: string[]
  knownPitfalls: string[]
  importantFiles: string[]
}

export interface RepoStructureMap {
  packageManager: "bun" | "pnpm" | "npm" | "yarn" | "unknown"
  workspaces: string[]
  sourceRoots: string[]
  testRoots: string[]
  configFiles: string[]
  entrypoints: string[]
  moduleHints: Array<{ path: string; purpose: string }>
}

export interface SymbolLocation {
  file: string
  symbol: string
  line: number
  character: number
  kind: "definition" | "reference"
}

export interface LocateResult {
  primaryFiles: string[]
  secondaryFiles: string[]
  relevantSymbols: string[]
  definitions: SymbolLocation[]
  references: SymbolLocation[]
  suspectedTests: string[]
  confidence: number
  unresolvedQuestions: string[]
}

export interface SourceUnderstanding {
  filesRead: string[]
  dataFlowNotes: Array<{ file: string; summary: string }>
  callFlow: Array<{ from: string; to: string; reason: string }>
  invariants: string[]
  assumptions: string[]
  risks: string[]
  likelyEditTargets: Array<{ file: string; reason: string; confidence: number }>
}

export interface ContextMap {
  id: string
  taskId: string
  projectConstitution: ProjectConstitution
  repoStructure: RepoStructureMap
  locateResult: LocateResult
  sourceUnderstanding: SourceUnderstanding
  verificationHints: {
    commands: string[]
    suspectedTests: string[]
  }
  confidence: number
  blockers: string[]
}

export interface ContextReadiness {
  hasProjectConstitution: boolean
  hasRepoStructureMap: boolean
  hasLocateResult: boolean
  hasSourceUnderstanding: boolean
  hasVerificationPlan: boolean
  confidence: number
  blockers: string[]
}

export type ContextMapTaskLevel = "small" | "medium" | "long" | "high_risk"

// ── Project constitution loader ──

const CONSTITUTION_FILES = [
  ".orcana/memory/MEMORY.md",
  "ORCANA.md",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "ARCHITECTURE.md",
  "package.json",
  "tsconfig.json",
  "bun.lock",
  "pnpm-lock.yaml",
]

export function loadProjectConstitution(root = process.cwd()): ProjectConstitution {
  const notes: string[] = []
  const rules: string[] = []
  const forbidden: string[] = []
  const buildCommands: string[] = []
  const testCommands: string[] = []
  const pitfalls: string[] = []
  const importantFiles: string[] = []

  for (const file of CONSTITUTION_FILES) {
    const abs = resolveInside(root, file)
    if (!abs || !existsSync(abs)) continue
    importantFiles.push(file)
    const text = readFileSync(abs, "utf-8").slice(0, 20_000)
    classifyConstitutionText(file, text, { notes, rules, forbidden, buildCommands, testCommands, pitfalls })
  }

  try {
    const index = loadMemoryIndex(root)
    if (index.alwaysLoad.length || index.topicFiles.length) {
      notes.push(`memory index: ${index.alwaysLoad.length} always-load files, ${index.topicFiles.length} topic files`)
    }
  } catch {
    // Memory index is optional in early repos.
  }

  return {
    architectureNotes: unique(notes),
    codingRules: unique(rules),
    forbiddenActions: unique(forbidden),
    buildCommands: unique(buildCommands),
    testCommands: unique(testCommands),
    knownPitfalls: unique(pitfalls),
    importantFiles: unique(importantFiles),
  }
}

function classifyConstitutionText(
  file: string,
  text: string,
  out: {
    notes: string[]
    rules: string[]
    forbidden: string[]
    buildCommands: string[]
    testCommands: string[]
    pitfalls: string[]
  },
): void {
  if (file === "package.json") {
    try {
      const pkg = JSON.parse(text) as { scripts?: Record<string, string>; main?: string; bin?: Record<string, string> | string }
      for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
        if (/build|typecheck/i.test(name)) out.buildCommands.push(`${name}: ${command}`)
        if (/test|check/i.test(name)) out.testCommands.push(`${name}: ${command}`)
      }
      if (pkg.main) out.notes.push(`package main: ${pkg.main}`)
      if (pkg.bin) out.notes.push("package exposes CLI entrypoints")
    } catch {
      out.pitfalls.push("package.json could not be parsed")
    }
    return
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.replace(/^[-*#>\s]+/, "").trim()
    if (!trimmed || trimmed.length > 240) continue
    if (/architecture|runtime|agent|context|memory|replay|架构|运行时|上下文|记忆/i.test(trimmed)) out.notes.push(`${file}: ${trimmed}`)
    if (/must|should|prefer|read|check|run|必须|优先|先|检查/i.test(trimmed)) out.rules.push(`${file}: ${trimmed}`)
    if (/do not|never|forbidden|禁止|不要|不能/i.test(trimmed)) out.forbidden.push(`${file}: ${trimmed}`)
    if (/pitfall|risk|warning|known|风险|注意|不要重复/i.test(trimmed)) out.pitfalls.push(`${file}: ${trimmed}`)
  }
}

// ── Repo structure scanner ──

export function scanRepoStructure(root = process.cwd()): RepoStructureMap {
  const packageJson = readJsonFile(resolve(root, "package.json")) as { workspaces?: string[] | { packages?: string[] }; main?: string; bin?: Record<string, string> | string } | null
  const workspaces = Array.isArray(packageJson?.workspaces)
    ? packageJson.workspaces
    : packageJson?.workspaces?.packages ?? []

  const sourceRoots = ["src", "packages", "apps", "server", "client"].filter(dir => existsSync(resolve(root, dir)))
  const testRoots = ["test", "tests", "__tests__"].filter(dir => existsSync(resolve(root, dir)))
  const configFiles = ["package.json", "tsconfig.json", "tsconfig.build.json", "bun.lock", "pnpm-lock.yaml", ".github/workflows/ci.yml"]
    .filter(file => existsSync(resolve(root, file)))

  const entrypoints: string[] = []
  if (packageJson?.main) entrypoints.push(packageJson.main)
  if (typeof packageJson?.bin === "string") entrypoints.push(packageJson.bin)
  if (packageJson?.bin && typeof packageJson.bin === "object") entrypoints.push(...Object.values(packageJson.bin))
  for (const candidate of ["src/index.ts", "src/cli.ts", "src/ui/cli.ts", "src/tui/main.tsx"]) {
    if (existsSync(resolve(root, candidate))) entrypoints.push(candidate)
  }

  return {
    packageManager: detectPackageManager(root),
    workspaces,
    sourceRoots,
    testRoots,
    configFiles,
    entrypoints: unique(entrypoints),
    moduleHints: buildModuleHints(root, sourceRoots, testRoots),
  }
}

function detectPackageManager(root: string): RepoStructureMap["packageManager"] {
  if (existsSync(resolve(root, "bun.lock")) || existsSync(resolve(root, "bun.lockb"))) return "bun"
  if (existsSync(resolve(root, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(resolve(root, "yarn.lock"))) return "yarn"
  if (existsSync(resolve(root, "package-lock.json"))) return "npm"
  return "unknown"
}

function buildModuleHints(root: string, sourceRoots: string[], testRoots: string[]): RepoStructureMap["moduleHints"] {
  const hints: RepoStructureMap["moduleHints"] = []
  for (const dir of sourceRoots) {
    if (dir === "src") {
      for (const child of safeReadDir(resolve(root, dir))) {
        if (child.isDirectory()) hints.push({ path: `src/${child.name}`, purpose: inferPurpose(child.name) })
      }
    } else {
      hints.push({ path: dir, purpose: inferPurpose(dir) })
    }
  }
  for (const dir of testRoots) hints.push({ path: dir, purpose: "tests and replay fixtures" })
  return hints
}

function inferPurpose(name: string): string {
  if (/agent|runtime|loop/i.test(name)) return "agent runtime"
  if (/memory|context/i.test(name)) return "context and memory"
  if (/ripple/i.test(name)) return "change impact analysis"
  if (/tool/i.test(name)) return "tool execution"
  if (/tui|ui/i.test(name)) return "terminal interface"
  if (/provider/i.test(name)) return "model provider integration"
  return "module"
}

// ── Hybrid locator v1: text search + TypeScript AST symbols ──

export interface HybridLocateInput {
  userRequest: string
  keywords?: string[]
  maxFiles?: number
}

export function hybridLocate(root: string, input: HybridLocateInput): LocateResult {
  const repo = scanRepoStructure(root)
  const terms = unique([...tokenize(input.userRequest), ...(input.keywords ?? [])]).slice(0, 16)
  const files = listCandidateSourceFiles(root, [...repo.sourceRoots, ...repo.testRoots])
  const scored = files.map(file => {
    const text = safeReadText(resolve(root, file))
    const score = terms.reduce((sum, term) => sum + countTerm(text, term), 0)
    return { file, text, score }
  }).filter(hit => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.maxFiles ?? 12)

  const primaryFiles = scored.slice(0, 5).map(hit => hit.file)
  const secondaryFiles = scored.slice(5).map(hit => hit.file)
  const definitions: SymbolLocation[] = []
  const references: SymbolLocation[] = []
  const relevantSymbols = new Set<string>()

  for (const hit of scored) {
    const symbols = extractTypeScriptSymbols(hit.file, hit.text)
    for (const symbol of symbols) {
      if (terms.some(term => symbol.symbol.toLowerCase().includes(term.toLowerCase())) || hit.score > 0) {
        definitions.push(symbol)
        relevantSymbols.add(symbol.symbol)
      }
    }
    for (const term of terms) {
      for (const ref of findTextReferences(hit.file, hit.text, term).slice(0, 5)) {
        references.push(ref)
      }
    }
  }

  const suspectedTests = unique(scored.map(hit => hit.file).filter(file => /(^|\/)(tests?|__tests__)\//i.test(file) || /\.test\./i.test(file)))
  const unresolvedQuestions = primaryFiles.length === 0
    ? ["No source files matched the request keywords."]
    : []

  return {
    primaryFiles,
    secondaryFiles,
    relevantSymbols: [...relevantSymbols].slice(0, 20),
    definitions: definitions.slice(0, 40),
    references: references.slice(0, 60),
    suspectedTests,
    confidence: primaryFiles.length === 0 ? 0.2 : clamp01(0.45 + Math.min(primaryFiles.length, 5) * 0.08 + Math.min(definitions.length, 10) * 0.02),
    unresolvedQuestions,
  }
}

function extractTypeScriptSymbols(file: string, text: string): SymbolLocation[] {
  if (!/\.(tsx?|jsx?)$/i.test(file)) return []
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const symbols: SymbolLocation[] = []

  function visit(node: ts.Node): void {
    const name = getNodeName(node)
    if (name) {
      const pos = source.getLineAndCharacterOfPosition(name.getStart(source))
      symbols.push({
        file,
        symbol: name.getText(source),
        line: pos.line + 1,
        character: pos.character + 1,
        kind: "definition",
      })
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return symbols
}

function getNodeName(node: ts.Node): ts.Identifier | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) return node.name
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name
  return undefined
}

function findTextReferences(file: string, text: string, term: string): SymbolLocation[] {
  if (term.length < 3) return []
  const refs: SymbolLocation[] = []
  const lowerTerm = term.toLowerCase()
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const index = lines[i]!.toLowerCase().indexOf(lowerTerm)
    if (index >= 0) refs.push({ file, symbol: term, line: i + 1, character: index + 1, kind: "reference" })
  }
  return refs
}

// ── Source understanding ──

export function buildSourceUnderstanding(root: string, files: string[]): SourceUnderstanding {
  const uniqueFiles = unique(files).filter(file => resolveInside(root, file) && existsSync(resolve(root, file))).slice(0, 12)
  const dataFlowNotes: SourceUnderstanding["dataFlowNotes"] = []
  const callFlow: SourceUnderstanding["callFlow"] = []
  const invariants: string[] = []
  const assumptions: string[] = []
  const risks: string[] = []
  const likelyEditTargets: SourceUnderstanding["likelyEditTargets"] = []

  for (const file of uniqueFiles) {
    const text = safeReadText(resolve(root, file))
    const imports = (text.match(/^import\s.+$/gm) ?? []).length
    const exports = (text.match(/^export\s.+$/gm) ?? []).length
    const tests = /describe\(|test\(|expect\(/.test(text)
    dataFlowNotes.push({ file, summary: `${imports} imports, ${exports} exports${tests ? ", contains tests" : ""}` })
    if (imports > 0) callFlow.push({ from: file, to: "imported modules", reason: "static imports indicate dependencies" })
    if (/forbidden|permission|sandbox|gate|evidence|ripple/i.test(text)) invariants.push(`${file}: contains runtime guard or verification terms`)
    if (text.length > 30_000) risks.push(`${file}: large file; read narrower symbols before editing`)
    likelyEditTargets.push({ file, reason: tests ? "matched test file" : "matched request terms", confidence: tests ? 0.55 : 0.75 })
  }

  if (!uniqueFiles.length) assumptions.push("No concrete source files were read.")
  return {
    filesRead: uniqueFiles,
    dataFlowNotes,
    callFlow,
    invariants: unique(invariants),
    assumptions,
    risks,
    likelyEditTargets,
  }
}

// ── Context map and readiness ──

export function buildContextMap(root: string, input: { taskId: string; userRequest: string; keywords?: string[] }): ContextMap {
  const projectConstitution = loadProjectConstitution(root)
  const repoStructure = scanRepoStructure(root)
  const locateResult = hybridLocate(root, { userRequest: input.userRequest, keywords: input.keywords })
  const sourceUnderstanding = buildSourceUnderstanding(root, [...locateResult.primaryFiles, ...locateResult.secondaryFiles])
  const verificationCommands = unique([
    ...projectConstitution.testCommands,
    ...projectConstitution.buildCommands,
  ]).slice(0, 8)
  const blockers: string[] = []
  if (!repoStructure.sourceRoots.length) blockers.push("No source roots found.")
  if (!locateResult.primaryFiles.length) blockers.push("No primary files located.")
  if (!sourceUnderstanding.filesRead.length) blockers.push("No source files read.")

  const confidence = clamp01(
    locateResult.confidence * 0.55 +
    (sourceUnderstanding.filesRead.length ? 0.2 : 0) +
    (projectConstitution.importantFiles.length ? 0.15 : 0) +
    (verificationCommands.length ? 0.1 : 0),
  )

  return {
    id: `ctx-${hashText(`${input.taskId}:${input.userRequest}`).slice(0, 12)}`,
    taskId: input.taskId,
    projectConstitution,
    repoStructure,
    locateResult,
    sourceUnderstanding,
    verificationHints: {
      commands: verificationCommands,
      suspectedTests: locateResult.suspectedTests,
    },
    confidence,
    blockers,
  }
}

export function evaluateContextReadiness(map: ContextMap, level: ContextMapTaskLevel): ContextReadiness {
  const readiness: ContextReadiness = {
    hasProjectConstitution: map.projectConstitution.importantFiles.length > 0,
    hasRepoStructureMap: map.repoStructure.sourceRoots.length > 0 || map.repoStructure.configFiles.length > 0,
    hasLocateResult: map.locateResult.primaryFiles.length > 0,
    hasSourceUnderstanding: map.sourceUnderstanding.filesRead.length > 0,
    hasVerificationPlan: map.verificationHints.commands.length > 0 || map.verificationHints.suspectedTests.length > 0,
    confidence: map.confidence,
    blockers: [...map.blockers],
  }

  if ((level === "medium" || level === "long" || level === "high_risk") && !readiness.hasLocateResult) {
    readiness.blockers.push("LocateResult is required for medium and larger tasks.")
  }
  if ((level === "medium" || level === "long" || level === "high_risk") && !readiness.hasSourceUnderstanding) {
    readiness.blockers.push("SourceUnderstanding is required for medium and larger tasks.")
  }
  if ((level === "long" || level === "high_risk") && !readiness.hasProjectConstitution) {
    readiness.blockers.push("ProjectConstitution is required for long tasks.")
  }
  if ((level === "long" || level === "high_risk") && !readiness.hasVerificationPlan) {
    readiness.blockers.push("Verification plan is required for long tasks.")
  }
  if (level === "high_risk" && map.confidence < 0.75) {
    readiness.blockers.push("High-risk task confidence below 0.75.")
  }
  return readiness
}

export function selectContextMapTaskLevel(input: {
  userRequest: string
  risk?: "low" | "medium" | "high"
  touchedFiles?: number
}): ContextMapTaskLevel {
  if (input.risk === "high") return "high_risk"
  const text = input.userRequest.toLowerCase()
  if (/architecture|runtime|migration|multi[- ]?file|refactor|long task|架构|重构|长任务/.test(text)) return "long"
  if ((input.touchedFiles ?? 0) >= 3) return "long"
  if (/fix|bug|feature|implement|add|修改|实现|修复/.test(text)) return "medium"
  return "small"
}

export function contextEvidenceForMap(map: ContextMap): string[] {
  const evidence: string[] = []
  if (map.projectConstitution.importantFiles.length) {
    evidence.push(`projectConstitution:${map.projectConstitution.importantFiles.slice(0, 5).join(",")}`)
  }
  if (map.repoStructure.sourceRoots.length) {
    evidence.push(`repoStructure:${map.repoStructure.sourceRoots.join(",")}`)
  }
  if (map.locateResult.primaryFiles.length) {
    evidence.push(`locateResult:${map.locateResult.primaryFiles.slice(0, 5).join(",")}`)
  }
  if (map.sourceUnderstanding.filesRead.length) {
    evidence.push(`sourceUnderstanding:${map.sourceUnderstanding.filesRead.slice(0, 5).join(",")}`)
  }
  if (map.verificationHints.commands.length || map.verificationHints.suspectedTests.length) {
    evidence.push(`verification:${[...map.verificationHints.commands, ...map.verificationHints.suspectedTests].slice(0, 5).join(",")}`)
  }
  return evidence
}

export function attachContextMapToTaskPacket(packet: TaskPacket, map: ContextMap): TaskPacket {
  return {
    ...packet,
    contextMapId: map.id,
    requiredContextEvidence: contextEvidenceForMap(map),
  }
}

export function saveContextMap(root: string, map: ContextMap): string {
  const dir = resolve(root, ".orcana", "state", "context-maps")
  mkdirSync(dir, { recursive: true })
  const file = resolve(dir, `${map.id}.json`)
  writeFileSync(file, JSON.stringify(map, null, 2) + "\n", "utf-8")
  return file
}

export function loadContextMap(root: string, id: string): ContextMap | null {
  if (!/^ctx-[a-f0-9]{12}$/.test(id)) return null
  const file = resolve(root, ".orcana", "state", "context-maps", `${id}.json`)
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, "utf-8")) as ContextMap
}

// ── Internal helpers ──

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return null
  }
}

function listCandidateSourceFiles(root: string, roots: string[]): string[] {
  const files: string[] = []
  for (const dir of roots) {
    const abs = resolveInside(root, dir)
    if (abs && existsSync(abs)) walkFiles(root, abs, files)
  }
  return files.filter(file => isReadableSource(file))
}

function walkFiles(root: string, dir: string, out: string[]): void {
  for (const entry of safeReadDir(dir)) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walkFiles(root, abs, out)
    } else if (entry.isFile()) {
      out.push(toRepoPath(root, abs))
    }
  }
}

const SKIP_DIRS = new Set([".git", ".deepseek-code", ".orcana", "node_modules", "dist", "coverage", ".next"])
const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".css", ".scss", ".html", ".yml", ".yaml"])

function isReadableSource(file: string): boolean {
  return SOURCE_EXTS.has(extname(file).toLowerCase())
}

function safeReadDir(dir: string): import("node:fs").Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function safeReadText(path: string): string {
  try {
    return readFileSync(path, "utf-8")
  } catch {
    return ""
  }
}

function resolveInside(root: string, path: string): string | null {
  const base = resolve(root)
  const target = resolve(base, path)
  return target === base || target.startsWith(base + sep) ? target : null
}

function toRepoPath(root: string, abs: string): string {
  return relative(root, abs).replace(/\\/g, "/")
}

function tokenize(text: string): string[] {
  return unique(text.toLowerCase().split(/[^a-z0-9_./-]+/i).filter(term => term.length >= 3 && !STOP_WORDS.has(term))).slice(0, 24)
}

const STOP_WORDS = new Set(["the", "and", "for", "with", "from", "this", "that", "into", "when", "what", "how", "fix", "add", "实现", "修复"])

function countTerm(text: string, term: string): number {
  if (!term) return 0
  const lower = text.toLowerCase()
  let count = 0
  let index = lower.indexOf(term.toLowerCase())
  while (index >= 0 && count < 20) {
    count++
    index = lower.indexOf(term.toLowerCase(), index + term.length)
  }
  return count
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function hashText(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const len = (text.length & 0xffff).toString(16).padStart(4, "0")
  return (hash >>> 0).toString(16).padStart(8, "0") + len
}

export function formatContextMapSummary(map: ContextMap): string {
  return [
    `ContextMap ${map.id} for ${map.taskId}`,
    `confidence: ${map.confidence}`,
    `primaryFiles: ${map.locateResult.primaryFiles.join(", ") || "(none)"}`,
    `verification: ${map.verificationHints.commands.join(" | ") || "(none)"}`,
    map.blockers.length ? `blockers: ${map.blockers.join(" | ")}` : "blockers: none",
  ].join("\n")
}

export function filenamePurpose(file: string): string {
  return inferPurpose(basename(file, extname(file)))
}
