/** Context Map Pipeline — pre-code context acquisition gate.
 *
 * The pipeline turns "read docs -> inspect structure -> locate code -> read
 * source" into deterministic runtime data. It is deliberately independent from
 * the agent loop so it can be tested and later wired into TaskPacket planning.
 *
 * IC01-R2: 整次 ContextMap 操作（constitution / lockfile / README / 源文件
 * 定位）统一经过 WorkspaceIoAuthority —— 秘密文件、工作区外、symlink 逃逸
 * 与 hardlink 秘密 alias 一律拒绝；所有打开后的 fd 执行 canonical 校验
 * （fail closed）；全部文件读取共享同一个累计字节预算与 AbortSignal；
 * 候选源文件采用 bounded top-K（未入选内容不长期保留）。
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { basename, extname, join, relative, resolve, sep } from "node:path"
import ts from "typescript"
import { contextMemoryLayout, MEMORY_INDEX_READ_CAP_BYTES } from "../memory/context-memory-os"
import type { TaskPacket } from "../agent/task-packet"
import { getWorkspaceIoAuthority } from "../runtime/execution-context"
import { isWithin, deepestExistingRealpath } from "../tools/path-authority"
import {
  enforceWorkspaceRead,
  validateOpenFileCanonicalSync,
  type WorkspaceIoAuthority,
  type WorkspaceIoViolation,
} from "../runtime/io/workspace-io-authority"
import {
  BoundedFileReader,
  DEFAULT_OPERATION_BUDGET_BYTES,
  FileReadError,
  readCapBytes,
} from "../runtime/io/bounded-file-reader"

// ── Types ──

export interface ProjectConstitution {
  architectureNotes: string[]
  codingRules: string[]
  forbiddenActions: string[]
  buildCommands: string[]
  testCommands: string[]
  knownPitfalls: string[]
  importantFiles: string[]
  /** IC05 Correction P0: bounded constitution probe 客观结局 —— 区分
   *  客观不存在（absent）与存在但读取失败（read_failed）/ probe 未完成
   *  （incomplete）。绝不把"存在但读不到"当"不存在"。 */
  constitutionProbe: ConstitutionProbeOutcome
}

export type ConstitutionProbeOutcome = "found" | "absent" | "read_failed" | "incomplete"

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

// ── IC01-R2: 共享读取会话（权威 + 累计预算 + AbortSignal） ──

export interface ContextMapReadOptions {
  /** 注入工作区 I/O 权威；未提供时取当前 ALS 权威（production 语义一致）。 */
  workspace?: WorkspaceIoAuthority
  /** 整次 ContextMap 操作共享累计字节预算（默认 64 MiB）。 */
  budgetBytes?: number
  /** 操作级 AbortSignal（每个文件读取边界检查）。 */
  signal?: AbortSignal
  /** 复用既有会话（同一操作的多次调用共享预算与权威）。 */
  session?: ContextMapReadSession
}

/** IC01-R2/R3: ContextMap 读取会话 —— 整次操作共享累计字节预算与 AbortSignal；
 *  所有文件读取经过权威强制 + open 后 fd canonical 校验（fail closed）。
 *  IC01-R3: 无 WorkspaceIoAuthority（无 ALS、未显式注入）时 fail closed ——
 *  任何读取都被拒绝（authorityMissing=true），绝不隐式跳过强制与 fd 校验。 */
export class ContextMapReadSession {
  readonly workspace: WorkspaceIoAuthority | undefined
  readonly signal: AbortSignal | undefined
  readonly budgetBytes: number
  /** 已读取的文件字节（累计）。 */
  bytesRead = 0
  /** 预算耗尽（后续读取返回空）。 */
  budgetExhausted = false
  /** 信号中止（后续读取返回空）。 */
  aborted = false
  /** IC01-R3: 无权威（无 ALS / 未显式注入）→ true；全部读取被拒绝。 */
  readonly authorityMissing: boolean
  private readonly reader: BoundedFileReader

  constructor(options: ContextMapReadOptions = {}) {
    this.budgetBytes = options.budgetBytes ?? DEFAULT_OPERATION_BUDGET_BYTES
    this.workspace = options.workspace ?? getWorkspaceIoAuthority()
    this.authorityMissing = this.workspace === undefined
    this.signal = options.signal
    this.reader = new BoundedFileReader({ operationBudgetBytes: this.budgetBytes })
  }

  get budgetRemaining(): number {
    return this.budgetBytes - this.bytesRead
  }

  /** 有界 + 权威强制的同步文本读取。
   *  - 无权威（authorityMissing）→ fail closed，返回 ""（绝不放行）
   *  - 权威拒绝（秘密 / 越界 / symlink 逃逸 / hardlink 未授权）→ ""
   *  - open 后 fd canonical 校验失败（fail closed）→ ""
   *  - 预算耗尽 / 中止 → ""（并置位标记，调用方循环提前退出）
   *  - 只分配 min(size, capBytes, maxFileBytes, 剩余预算) 字节。 */
  readText(path: string, capBytes: number, lexicalRoot: string): string {
    if (this.aborted || this.budgetExhausted) return ""
    if (this.signal?.aborted) {
      this.aborted = true
      return ""
    }
    if (this.authorityMissing) return ""
    // 权威读取强制（秘密 / 越界 / symlink 逃逸）—— lexical + canonical 双查。
    const violation = enforceWorkspaceRead(this.workspace!, path, path, lexicalRoot)
    if (violation) return ""
    let info
    try {
      info = this.reader.statSync(path)
    } catch {
      return ""
    }
    if (!info.isRegular) return ""
    const limit = Math.min(info.size, capBytes, this.reader.maxFileBytes, this.budgetRemaining)
    if (limit <= 0) {
      if (info.size > 0) this.budgetExhausted = true
      return ""
    }
    try {
      const buffer = this.reader.readSync(path, limit, {
        validateOpenSync: (fd: number): string | null => {
          const violation = validateOpenFileCanonicalSync(this.workspace!, path, fd)
          return violation?.reason ?? null
        },
      })
      this.bytesRead += buffer.length
      if (this.bytesRead >= this.budgetBytes) this.budgetExhausted = true
      return buffer.toString("utf-8")
    } catch (error) {
      if (error instanceof FileReadError && error.code === "ABORTED") {
        this.aborted = true
      }
      return ""
    }
  }

  /** 权威目录放行检查：目录 canonical 目标必须在权威读取根内（symlink 目录
   *  指向根外时不做内容枚举，防止目录列表泄漏）。无权威时 fail closed。 */
  isReadableDir(dir: string): boolean {
    if (this.authorityMissing) return false
    const real = deepestExistingRealpath(dir)
    if (real === undefined) return false
    return isWithin(this.workspace!.readRoot, real)
  }

  /** 权威拒绝原因（诊断用）。 */
  violationFor(path: string, lexicalRoot: string): WorkspaceIoViolation | null {
    if (this.authorityMissing) {
      return { code: "SECRET_READ", reason: `SECRET_READ: ContextMap 无 WorkspaceIoAuthority，fail closed: ${path}` }
    }
    return enforceWorkspaceRead(this.workspace!, path, path, lexicalRoot)
  }
}

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

export function loadProjectConstitution(
  root = process.cwd(),
  options: ContextMapReadOptions = {},
): ProjectConstitution {
  const session = options.session ?? new ContextMapReadSession(options)
  const empty = {
    architectureNotes: [] as string[],
    codingRules: [] as string[],
    forbiddenActions: [] as string[],
    buildCommands: [] as string[],
    testCommands: [] as string[],
    knownPitfalls: [] as string[],
    importantFiles: [] as string[],
    constitutionProbe: "incomplete" as const,
  }
  // IC01-R4: 无 authority 时零元数据泄漏 —— 在任何 existsSync / stat / read 之前
  // 直接返回确定性空结构（不得泄漏文件存在性/文件名）。
  if (session.authorityMissing) return empty
  const notes: string[] = []
  const rules: string[] = []
  const forbidden: string[] = []
  const buildCommands: string[] = []
  const testCommands: string[] = []
  const pitfalls: string[] = []
  const importantFiles: string[] = []

  let hadReadFailure = false
  for (const file of CONSTITUTION_FILES) {
    if (session.aborted || session.budgetExhausted) break
    const abs = resolveInside(root, file)
    if (!abs || !existsSync(abs)) continue
    // IC01-R2: 读取经过权威强制（README/src symlink 指向根外或 secret →
    // 拒绝，不进入 importantFiles）；有界读取 —— 大型 README/规则文件/
    // lockfile 绝不整体读入（共享累计预算内）。
    const text = session.readText(abs, 20_000, root)
    if (!text) {
      // IC05 Correction P0: 文件客观存在（existsSync 已确认）但读取被拒/
      // 失败（authority deny / canonical violation / stat-read failure）——
      // 这是 read_failed，不是 absent。
      hadReadFailure = true
      continue
    }
    importantFiles.push(file)
    classifyConstitutionText(file, text, { notes, rules, forbidden, buildCommands, testCommands, pitfalls })
  }

  if (!session.aborted && !session.budgetExhausted) {
    // IC01-R2: memory index 读取与 constitution 其余文件同路径（权威强制 +
    // 共享预算）—— 不经过 context-memory-os 的直接读取（该模块无 authority）。
    const layout = contextMemoryLayout(root)
    const memoryRaw = session.readText(layout.files.memoryIndex, MEMORY_INDEX_READ_CAP_BYTES, root)
    const counts = countMemoryIndexSections(memoryRaw)
    if (counts.alwaysLoad || counts.topicFiles) {
      notes.push(`memory index: ${counts.alwaysLoad} always-load files, ${counts.topicFiles} topic files`)
    }
  }

  const probeOutcome: ConstitutionProbeOutcome =
    importantFiles.length > 0 || notes.length > 0 || rules.length > 0 || forbidden.length > 0 ||
    buildCommands.length > 0 || testCommands.length > 0 || pitfalls.length > 0
      ? "found"
      : hadReadFailure
        ? "read_failed"
        : session.aborted || session.budgetExhausted
          ? "incomplete"
          : "absent"

  return {
    architectureNotes: unique(notes),
    codingRules: unique(rules),
    forbiddenActions: unique(forbidden),
    buildCommands: unique(buildCommands),
    testCommands: unique(testCommands),
    knownPitfalls: unique(pitfalls),
    importantFiles: unique(importantFiles),
    constitutionProbe: probeOutcome,
  }
}

/** memory index 的 Always Load / Topic Files 计数（与 context-memory-os 的
 *  loadMemoryIndex 语义一致；本管线只使用计数）。 */
function countMemoryIndexSections(raw: string): { alwaysLoad: number; topicFiles: number } {
  let section: "always" | "topic" | null = null
  let alwaysLoad = 0
  let topicFiles = 0
  for (const line of raw.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      const title = heading[1]!
      section = title === "Always Load" ? "always" : title === "Topic Files" ? "topic" : null
      continue
    }
    if (section !== null && /^-\s+/.test(line)) {
      if (section === "always") alwaysLoad++
      else topicFiles++
    }
  }
  return { alwaysLoad, topicFiles }
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

export function scanRepoStructure(
  root = process.cwd(),
  options: ContextMapReadOptions = {},
): RepoStructureMap {
  const session = options.session ?? new ContextMapReadSession(options)
  // IC01-R4: 无 authority 时零元数据泄漏 —— 在任何 readJsonFile、existsSync、
  // stat、readdir、detectPackageManager 之前直接返回确定性空结构。
  if (session.authorityMissing) {
    return {
      packageManager: "unknown",
      workspaces: [],
      sourceRoots: [],
      testRoots: [],
      configFiles: [],
      entrypoints: [],
      moduleHints: [],
    }
  }
  const packageJson = readJsonFile(resolve(root, "package.json"), session, root) as { workspaces?: string[] | { packages?: string[] }; main?: string; bin?: Record<string, string> | string } | null
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
    moduleHints: buildModuleHints(root, sourceRoots, testRoots, session),
  }
}

function detectPackageManager(root: string): RepoStructureMap["packageManager"] {
  if (existsSync(resolve(root, "bun.lock")) || existsSync(resolve(root, "bun.lockb"))) return "bun"
  if (existsSync(resolve(root, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(resolve(root, "yarn.lock"))) return "yarn"
  if (existsSync(resolve(root, "package-lock.json"))) return "npm"
  return "unknown"
}

function buildModuleHints(root: string, sourceRoots: string[], testRoots: string[], session: ContextMapReadSession): RepoStructureMap["moduleHints"] {
  const hints: RepoStructureMap["moduleHints"] = []
  for (const dir of sourceRoots) {
    if (dir === "src") {
      for (const child of safeReadDir(resolve(root, dir), session, root)) {
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

/** IC01-R6: 确定性空定位结果 factory —— 每次调用创建全新对象及全部嵌套数组
 *  （绝不允许返回模块级共享可变对象：调用方修改 primaryFiles 等会跨调用污染
 *  后续 hybridLocate / buildContextMap 的结果）。maxFiles<=0 与 authorityMissing
 *  两条路径都必须独立实例。 */
function emptyLocateResult(): LocateResult {
  return {
    primaryFiles: [],
    secondaryFiles: [],
    relevantSymbols: [],
    definitions: [],
    references: [],
    suspectedTests: [],
    confidence: 0.2,
    unresolvedQuestions: ["No source files matched the request keywords."],
  }
}

export function hybridLocate(
  root: string,
  input: HybridLocateInput,
  options: ContextMapReadOptions = {},
): LocateResult {
  const session = options.session ?? new ContextMapReadSession(options)
  // IC01-R3: maxFiles 归一化 —— undefined 保持默认 12；非有限数（NaN/
  // Infinity）或 <1（0/负数）统一归约为 0 → 安全空结果，且不进行任何
  // 文件扫描/读取；有限正数 floor 并封顶 64（病态大值不得放大保留量）。
  const rawMax = input.maxFiles
  const maxK = rawMax === undefined
    ? 12
    : typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax >= 1
      ? Math.min(Math.floor(rawMax), 64)
      : 0
  // IC01-R5: 无 authority 时在 scanRepoStructure（及其 existsSync/readdir）
  // 之前确定性早退 —— 返回与「无匹配」完全相同的结构，存在路径与不存在
  // 路径结果一致（不得形成路径存在性 oracle）。
  if (session.authorityMissing || maxK <= 0) return emptyLocateResult()
  const repo = scanRepoStructure(root, { session })
  const terms = unique([...tokenize(input.userRequest), ...(input.keywords ?? [])]).slice(0, 16)
  const files = listCandidateSourceFiles(root, [...repo.sourceRoots, ...repo.testRoots], session)

  // IC01-R2: bounded top-K —— 单趟迭代只保留得分最高的 K 个候选（连同其
  // 文本），未入选内容不长期保留在内存（配合共享累计预算，绝无 N × 16 MiB）。
  const scored: Array<{ file: string; text: string; score: number }> = []
  for (const file of files) {
    if (session.aborted || session.budgetExhausted) break
    const text = session.readText(resolve(root, file), readCapBytes(), root)
    if (!text) continue
    const score = terms.reduce((sum, term) => sum + countTerm(text, term), 0)
    if (score <= 0) continue
    pushTopK(scored, { file, text, score }, maxK)
  }
  scored.sort((a, b) => b.score - a.score)

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

/** bounded top-K 插入：数组长度恒 ≤ K，超出时替换最低分（未入选文本立即
 *  失去引用，可被 GC 回收 —— 不长期保留）。 */
function pushTopK<T extends { score: number }>(arr: T[], entry: T, k: number): void {
  if (arr.length < k) {
    arr.push(entry)
    return
  }
  let minIdx = 0
  for (let i = 1; i < arr.length; i++) {
    if (arr[i]!.score < arr[minIdx]!.score) minIdx = i
  }
  if (entry.score > arr[minIdx]!.score) {
    arr[minIdx] = entry
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

export function buildSourceUnderstanding(
  root: string,
  files: string[],
  options: ContextMapReadOptions = {},
): SourceUnderstanding {
  const session = options.session ?? new ContextMapReadSession(options)
  // IC01-R5: 无 authority 时在任何 existsSync / resolveInside / stat / read
  // 之前确定性早退 —— 返回与「无文件」完全相同的空结构（assumptions 固定
  // 文案），存在路径与不存在路径结果一致（不得形成路径存在性 oracle）。
  if (session.authorityMissing) {
    return {
      filesRead: [],
      dataFlowNotes: [],
      callFlow: [],
      invariants: [],
      assumptions: ["No concrete source files were read."],
      risks: [],
      likelyEditTargets: [],
    }
  }
  const uniqueFiles = unique(files).filter(file => resolveInside(root, file) && existsSync(resolve(root, file))).slice(0, 12)
  const dataFlowNotes: SourceUnderstanding["dataFlowNotes"] = []
  const callFlow: SourceUnderstanding["callFlow"] = []
  const invariants: string[] = []
  const assumptions: string[] = []
  const risks: string[] = []
  const likelyEditTargets: SourceUnderstanding["likelyEditTargets"] = []

  for (const file of uniqueFiles) {
    if (session.aborted || session.budgetExhausted) break
    const abs = resolve(root, file)
    // IC01-R2: 读取经过权威强制（源文件 symlink 指向根外或 secret → 拒绝，
    // 不计入 filesRead）；共享累计预算内截断。
    const text = session.readText(abs, readCapBytes(), root)
    if (!text) continue
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
    filesRead: uniqueFiles.filter(file => likelyEditTargets.some(t => t.file === file)),
    dataFlowNotes,
    callFlow,
    invariants: unique(invariants),
    assumptions,
    risks,
    likelyEditTargets,
  }
}

// ── Context map and readiness ──

export function buildContextMap(
  root: string,
  input: { taskId: string; userRequest: string; keywords?: string[] },
  options: ContextMapReadOptions = {},
): ContextMap {
  // IC01-R2: 整次操作共享同一会话（累计预算 / AbortSignal / 权威）——
  // 预算绝不按文件重置。
  const session = options.session ?? new ContextMapReadSession(options)
  const projectConstitution = loadProjectConstitution(root, { session })
  const repoStructure = scanRepoStructure(root, { session })
  const locateResult = hybridLocate(root, { userRequest: input.userRequest, keywords: input.keywords }, { session })
  const sourceUnderstanding = buildSourceUnderstanding(root, [...locateResult.primaryFiles, ...locateResult.secondaryFiles], { session })
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

export function loadContextMap(
  root: string,
  id: string,
  options: ContextMapReadOptions = {},
): ContextMap | null {
  if (!/^ctx-[a-f0-9]{12}$/.test(id)) return null
  // IC01-R5: session 在 existsSync 之前创建 —— 无 authority 时确定性早退
  // 返回 null（与文件不存在一致，.orcana/state/context-maps/<id>.json 的
  // 存在性不得形成 oracle）。
  const session = options.session ?? new ContextMapReadSession(options)
  if (session.authorityMissing) return null
  const file = resolve(root, ".orcana", "state", "context-maps", `${id}.json`)
  if (!existsSync(file)) return null
  // IC01-R2: 归档读取同样经过权威强制（秘密 / 越界 / symlink 逃逸拒绝）。
  const text = session.readText(file, readCapBytes(), root)
  if (!text) return null
  try {
    return JSON.parse(text) as ContextMap
  } catch {
    return null
  }
}

// ── Internal helpers ──

function readJsonFile(path: string, session: ContextMapReadSession, lexicalRoot: string): unknown {
  if (!existsSync(path)) return null
  try {
    // IC01-R2: 有界读取（package.json/lockfile 超限即截断，不整体读入）；
    // 读取经过权威强制（hardlink/symlink → secret 拒绝）。
    const text = session.readText(path, readCapBytes(), lexicalRoot)
    if (!text) return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

function listCandidateSourceFiles(root: string, roots: string[], session: ContextMapReadSession): string[] {
  const files: string[] = []
  for (const dir of roots) {
    const abs = resolveInside(root, dir)
    if (abs && existsSync(abs)) walkFiles(root, abs, files, session)
  }
  return files.filter(file => isReadableSource(file))
}

function walkFiles(root: string, dir: string, out: string[], session: ContextMapReadSession): void {
  // 排序保证遍历确定性（readdirSync 顺序与文件系统哈希有关）。
  const entries = safeReadDir(dir, session, root)
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walkFiles(root, abs, out, session)
    } else if (entry.isFile()) {
      out.push(toRepoPath(root, abs))
    }
  }
}

const SKIP_DIRS = new Set([".git", ".orcana", ".orcana", "node_modules", "dist", "coverage", ".next"])
const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".css", ".scss", ".html", ".yml", ".yaml"])

function isReadableSource(file: string): boolean {
  return SOURCE_EXTS.has(extname(file).toLowerCase())
}

/** 目录枚举：目录 canonical 目标逃逸权威读取根 → 不枚举（symlink 目录指向
 *  根外时不做列表泄漏）；Dirent 不跟随符号链接（symlink 文件/目录不枚举）。 */
function safeReadDir(dir: string, session: ContextMapReadSession, lexicalRoot: string): import("node:fs").Dirent[] {
  try {
    if (!session.isReadableDir(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
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
