import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import ts from "typescript"
import type { RuntimeContextBudgetMode } from "../agent/runtime-context"
import { buildContextKernel } from "../context/kernel"
import { HybridMemory } from "../memory/hybrid"
import { diffApiSurface, toSymbolShapes, changedSymbolNames, hasSeverity, type ApiChange } from "./api-diff"
import { ProjectProgram } from "./program"
import { getSemanticReferenceProvider, resetSemanticReferenceProvider } from "./semantic-reference-provider"
import { classifyCallers, formatUsageSummary } from "./usage-classifier"
import { buildVerificationMap, formatVerificationMap, verificationStrictness } from "./verification-map"
import { getAstGrepProvider, resetAstGrepProvider } from "./astgrep-provider"
import type {
  RippleCaller,
  RippleCascadePlan,
  RippleDecision,
  RippleFinding,
  RipplePreviewInput,
  RippleReport,
} from "./types"

let _program: ProjectProgram | null = null
let _pendingCascadeFiles = new Set<string>()

/** Get or create the shared ProjectProgram (lazy, cached). */
export function getRippleProgram(): ProjectProgram {
  if (!_program) _program = new ProjectProgram(process.cwd())
  return _program
}

/** Reset the program (e.g. after project root changes). */
export function resetRippleProgram(): void {
  _program?.invalidate()
  _program = null
  resetSemanticReferenceProvider()
  resetAstGrepProvider()
  invalidateFileListCache()
  parseCache.clear()
}

/** Invalidate the file list cache so the next call to cachedProjectFiles re-walks the project. */
export function invalidateFileListCache(): void {
  _fileListCache = null
}

/** Set files currently being cascaded (set by loop.ts when ripple obligations exist). */
export function setCascadeFiles(files: Set<string>): void {
  _pendingCascadeFiles = files
}

interface SymbolInfo {
  name: string
  kind: "function" | "interface" | "type" | "class" | "const"
  exported: boolean
  header: string
  async: boolean
  returnType: string
  fields: Set<string>
  line: number
  nameStart: number
  nameEnd: number
  declStart: number
  declEnd: number
}

const SKIP_DIRS = new Set([".git", ".codegraph", "node_modules", "dist", "coverage", ".next", ".deepseek-code", "blog"])

// Parse cache: cache SourceFile+lines keyed by mtime.
// Even when mtime matches we still walk the AST — the *target* symbol
// changed, not this file. Caching avoids re-reading and re-parsing.
const parseCache = new Map<string, { mtimeMs: number; source: ts.SourceFile; lines: string[] }>()

// File list cache: avoid full recursive walk every call
let _fileListCache: { files: string[]; projectRoot: string; at: number } | null = null
const FILE_LIST_CACHE_TTL_MS = 5000 // refresh at most every 5s

function cachedProjectFiles(projectRoot: string): string[] {
  if (_fileListCache && _fileListCache.projectRoot === projectRoot && Date.now() - _fileListCache.at < FILE_LIST_CACHE_TTL_MS) {
    return _fileListCache.files
  }
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full)
      } else if (isTsFile(full)) {
        files.push(full)
      }
    }
  }
  walk(projectRoot)
  _fileListCache = { files, projectRoot, at: Date.now() }
  return files
}

function isTsFile(path: string): boolean {
  return path.endsWith(".ts") || path.endsWith(".tsx")
}

function extractSymbols(content: string): Map<string, SymbolInfo> {
  content = content.replace(/^﻿/, "")
  const source = ts.createSourceFile("ripple.tsx", content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const symbols = new Map<string, SymbolInfo>()

  const exported = (node: ts.Node) => {
    const flags = ts.getCombinedModifierFlags(node as ts.Declaration)
    return Boolean(flags & ts.ModifierFlags.Export) || Boolean(flags & ts.ModifierFlags.Default)
  }
  const lineNum = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const headerOf = (node: ts.Node) => node.getText(source).split("\n")[0]?.trim() ?? ""
  const declStart = (node: ts.Node) => node.getStart(source)
  const declEnd = (node: ts.Node) => node.getEnd()

  for (const node of source.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text
      symbols.set(name, {
        name,
        kind: "function",
        exported: exported(node),
        header: headerOf(node),
        async: Boolean(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Async),
        returnType: node.type?.getText(source) ?? "",
        fields: new Set(),
        line: lineNum(node),
        nameStart: node.name.getStart(source),
        nameEnd: node.name.getEnd(),
        declStart: declStart(node),
        declEnd: declEnd(node),
      })
    } else if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text
      const fields = new Set<string>()
      for (const member of node.members) {
        const memberName = member.name
        if (memberName && ts.isIdentifier(memberName)) fields.add(memberName.text)
      }
      symbols.set(name, {
        name,
        kind: "interface",
        exported: exported(node),
        header: headerOf(node),
        async: false,
        returnType: "",
        fields,
        line: lineNum(node),
        nameStart: node.name.getStart(source),
        nameEnd: node.name.getEnd(),
        declStart: declStart(node),
        declEnd: declEnd(node),
      })
    } else if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text
      symbols.set(name, {
        name,
        kind: "type",
        exported: exported(node),
        header: headerOf(node),
        async: false,
        returnType: node.type.getText(source),
        fields: new Set(),
        line: lineNum(node),
        nameStart: node.name.getStart(source),
        nameEnd: node.name.getEnd(),
        declStart: declStart(node),
        declEnd: declEnd(node),
      })
    } else if (ts.isClassDeclaration(node) && node.name) {
      const name = node.name.text
      const classSymbol: SymbolInfo = {
        name,
        kind: "class",
        exported: exported(node),
        header: headerOf(node),
        async: false,
        returnType: "",
        fields: new Set(),
        line: lineNum(node),
        nameStart: node.name.getStart(source),
        nameEnd: node.name.getEnd(),
        declStart: declStart(node),
        declEnd: declEnd(node),
      }
      for (const member of node.members) {
        if (ts.isConstructorDeclaration(member)) {
          const methodName = "constructor"
          classSymbol.fields.add(methodName)
          symbols.set(`${name}.${methodName}`, {
            name: `${name}.${methodName}`,
            kind: "function",
            exported: exported(node),
            header: `constructor(${member.parameters.map(p => p.getText(source)).join(", ")})`,
            async: false,
            returnType: name,
            fields: new Set(),
            line: source.getLineAndCharacterOfPosition(member.getStart(source)).line + 1,
            nameStart: member.getStart(source),
            nameEnd: member.getStart(source),
            declStart: declStart(member),
            declEnd: declEnd(member),
          })
        } else if (ts.isMethodDeclaration(member) && member.name) {
          const methodName = ts.isIdentifier(member.name) ? member.name.text : `[${member.name.getText(source)}]`
          classSymbol.fields.add(methodName)
          symbols.set(`${name}.${methodName}`, {
            name: `${name}.${methodName}`,
            kind: "function",
            exported: exported(node),
            header: member.getText(source).split("\n")[0]?.trim() ?? "",
            async: Boolean(ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Async),
            returnType: member.type?.getText(source) ?? "",
            fields: new Set(),
            line: source.getLineAndCharacterOfPosition(member.getStart(source)).line + 1,
            nameStart: ts.isIdentifier(member.name) ? member.name.getStart(source) : member.getStart(source),
            nameEnd: ts.isIdentifier(member.name) ? member.name.getEnd() : member.getEnd(),
            declStart: declStart(member),
            declEnd: declEnd(member),
          })
        } else if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          classSymbol.fields.add(member.name.text)
        } else if (ts.isGetAccessor(member) && member.name && ts.isIdentifier(member.name)) {
          classSymbol.fields.add(`get ${member.name.text}`)
        } else if (ts.isSetAccessor(member) && member.name && ts.isIdentifier(member.name)) {
          classSymbol.fields.add(`set ${member.name.text}`)
        }
      }
      symbols.set(name, classSymbol)
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue
        const name = decl.name.text
        symbols.set(name, {
          name,
          kind: "const",
          exported: exported(node),
          header: headerOf(node),
          async: false,
          returnType: decl.type?.getText(source) ?? "",
          fields: new Set(),
          line: lineNum(node),
          nameStart: decl.name.getStart(source),
          nameEnd: decl.name.getEnd(),
          declStart: declStart(node),
          declEnd: declEnd(node),
        })
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const name = element.name.text
          symbols.set(name, {
            name,
            kind: "const",
            exported: true,
            header: `re-export ${name}`,
            async: false,
            returnType: "",
            fields: new Set(),
            line: lineNum(node),
            nameStart: element.name.getStart(source),
            nameEnd: element.name.getEnd(),
            declStart: declStart(node),
            declEnd: declEnd(node),
          })
        }
      }
    }
  }

  return symbols
}

// ── PR 2: replaced by diffApiSurface in api-diff.ts ──
// The old changedSymbols() returned a flat string[] and required downstream
// code to re-derive severity + kind by re-checking oldSym/newSym fields.
// Now diffApiSurface produces structured ApiChange[] with pre-computed severity.

function findCallers(projectRoot: string, targetFile: string, symbols: string[]): RippleCaller[] {
  if (!symbols.length || !existsSync(projectRoot)) return []
  const targetAbs = resolve(projectRoot, targetFile)
  const wanted = new Set(symbols)
  const callers: RippleCaller[] = []

  for (const file of cachedProjectFiles(projectRoot)) {
    if (resolve(file) === targetAbs) continue

    let fileMtime = 0
    try { fileMtime = statSync(file).mtimeMs } catch { continue }

    let source: ts.SourceFile
    let lines: string[]
    const cached = parseCache.get(file)
    if (cached && cached.mtimeMs === fileMtime) {
      source = cached.source
      lines = cached.lines
    } else {
      let content = ""
      try { content = readFileSync(file, "utf-8") } catch { continue }
      lines = content.split("\n")
      source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      parseCache.set(file, { mtimeMs: fileMtime, source, lines })
    }

    const aliases = new Map<string, string>()
    for (const stmt of source.statements) {
      if (ts.isImportDeclaration(stmt) && stmt.importClause?.namedBindings && ts.isNamedImports(stmt.importClause.namedBindings)) {
        for (const element of stmt.importClause.namedBindings.elements) {
          const importedName = (element.propertyName ?? element.name).text
          const localName = element.name.text
          if (localName !== importedName) aliases.set(localName, importedName)
        }
      }
    }

    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node)) {
        const resolvedName = aliases.get(node.text) ?? node.text
        if (wanted.has(resolvedName) && !isDeclarationIdentifier(node)) {
          const loc = source.getLineAndCharacterOfPosition(node.getStart(source))
          callers.push({
            file: relative(projectRoot, file).replace(/\\/g, "/"),
            line: loc.line + 1,
            symbol: resolvedName,
            text: (lines[loc.line] ?? "").trim(),
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return callers.slice(0, 50)
}

function isDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent
  return (
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
    (ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && parent.name === node) ||
    (ts.isImportClause(parent) && parent.name === node)
  )
}

export function decide(report: Pick<RippleReport, "findings">): RippleDecision {
  if (report.findings.some(f => f.severity === "block")) return "block"
  if (report.findings.some(f => f.severity === "warn")) return "warn"
  return "allow"
}

export function tightenRippleDecision(report: RippleReport, mode: RuntimeContextBudgetMode, _pendingFiles?: Set<string>): RippleDecision {
  if (mode === "block") return "block"
  // Cascade-aware leniency: demote block→warn when agent is working
  // through a cascade. The obligations system catches any truly
  // unresolved callers at exit.
  const pendingFiles = _pendingFiles ?? _pendingCascadeFiles
  if (report.decision === "block" && pendingFiles && pendingFiles.has(report.targetFile)) {
    return "warn"
  }
  if (mode !== "degraded") return report.decision
  if (report.decision === "block") return "block"
  if (report.findings.some(f => f.severity === "warn")) return "block"
  if (report.callers.length > 2) return "block"
  if (hasSeverity(report.apiChanges, "block") && report.callers.length > 2) return "warn"
  return report.decision
}

export function cascadeAwareDecision(report: RippleReport, modifiedFiles: Set<string>, mode: RuntimeContextBudgetMode): RippleDecision {
  const uncoveredCallers = report.callers.filter(caller => !modifiedFiles.has(caller.file))
  const cascadeKinds = new Set(["signature-change", "async-return-change"])
  // Info-severity findings (e.g. strictness gap advisories) are not blocking —
  // they must not prevent cascade-aware leniency when every REAL finding is a
  // cascade kind and all callers are covered by the current transaction.
  const actionableFindings = report.findings.filter(f => f.severity !== "info")
  const onlyCascadeFindings = actionableFindings.length > 0 && actionableFindings.every(f => cascadeKinds.has(f.kind))
  if (uncoveredCallers.length === 0 && onlyCascadeFindings) return "allow"
  return tightenRippleDecision(report, mode)
}

export function buildCascadePlan(report: Pick<RippleReport, "targetFile" | "callers" | "findings" | "decision">): RippleCascadePlan {
  const affected = new Set<string>([report.targetFile])
  const callerFiles = new Set<string>()
  const blockedReasons: string[] = []

  for (const caller of report.callers) {
    affected.add(caller.file)
    callerFiles.add(caller.file)
  }
  for (const finding of report.findings) {
    affected.add(finding.file)
    if (finding.severity === "block") blockedReasons.push(finding.reason)
  }

  const required = report.decision !== "allow" || callerFiles.size > 0
  const steps = [
    `Read ${[...callerFiles].slice(0, 8).join(", ") || report.targetFile} before retrying the write.`,
    "Prepare one atomic multi_edit that includes the target file and every affected caller that must change.",
    "Run typecheck/tests after the cascade patch.",
    "If verification fails and repair is riskier than revert, use rollback_transaction with the returned transactionId.",
  ]

  return {
    required,
    recommendedTool: affected.size > 1 ? "multi_edit" : "edit_file",
    targetFile: report.targetFile,
    affectedFiles: [...affected],
    callerFiles: [...callerFiles],
    blockedReasons: [...new Set(blockedReasons)],
    steps,
  }
}

/** Detect a likely replacement symbol when a deprecated export is removed.
 *
 *  Matches when the new code has a symbol whose name:
 *  - Shares a common prefix with the old name (e.g. "oldMethod" → "newMethod"
 *    where both contain "Method")
 *  - OR is within Levenshtein distance ≤ 2
 *
 *  This lets the ripple engine suggest deprecation-replacement migrations
 *  instead of just blocking the edit.
 */
function detectReplacement(
  oldName: string,
  _oldSym: { kind: string },
  newSymbols: Map<string, { kind: string }>,
): string | null {
  // Same-kind candidates only
  const candidates = [...newSymbols.entries()]
    .filter(([_, s]) => s.kind === _oldSym.kind || _oldSym.kind === "interface" && s.kind === "type")
    .map(([n]) => n)

  if (candidates.length === 0) return null

  // First: check if any new symbol shares a significant prefix/suffix
  for (const cand of candidates) {
    // Shared prefix of ≥3 chars (e.g. "buildConfig" ← "buildConfigV2")
    const prefixLen = sharedPrefixLen(oldName, cand)
    if (prefixLen >= Math.min(oldName.length, cand.length) * 0.6 && prefixLen >= 3) return cand
    // Shared suffix of ≥3 chars (e.g. "UserService" ← "OldUserService")
    const suffixLen = sharedSuffixLen(oldName, cand)
    if (suffixLen >= Math.min(oldName.length, cand.length) * 0.6 && suffixLen >= 3) return cand
  }

  // Second: Levenshtein check for small rename (e.g. "colour" → "color")
  for (const cand of candidates) {
    if (levenshtein(oldName, cand) <= 2) return cand
  }

  return null
}

function sharedPrefixLen(a: string, b: string): number {
  let i = 0
  for (; i < Math.min(a.length, b.length); i++) { if (a[i] !== b[i]) break }
  return i
}

function sharedSuffixLen(a: string, b: string): number {
  let i = 0
  for (; i < Math.min(a.length, b.length); i++) { if (a[a.length - 1 - i] !== b[b.length - 1 - i]) break }
  return i
}

function levenshtein(a: string, b: string): number {
  const n = a.length, m = b.length
  if (n === 0) return m
  if (m === 0) return n

  let prev: number[] = Array.from({ length: m + 1 }, (_, j) => j)
  let curr: number[] = new Array(m + 1).fill(0)

  for (let i = 0; i < n; i++) {
    curr[0] = i + 1
    for (let j = 0; j < m; j++) {
      const cost = a[i] === b[j] ? 0 : 1
      curr[j + 1] = Math.min((prev[j] ?? 0) + cost, (prev[j + 1] ?? 0) + 1, (curr[j] ?? 0) + 1)
    }
    const tmp = prev; prev = curr; curr = tmp // swap buffers
  }
  return prev[m] ?? m
}

export function previewEdit(input: RipplePreviewInput): RippleReport {
  const projectRoot = resolve(input.projectRoot ?? process.cwd())
  const targetFile = relative(projectRoot, resolve(projectRoot, input.targetFile)).replace(/\\/g, "/")
  const oldContent = input.oldContent ?? ""
  const newContent = input.newContent ?? ""

  if (!isTsFile(targetFile)) {
    return {
      targetFile,
      changedSymbols: [],
      apiChanges: [],
      usageImpacts: [],
      callers: [],
      findings: [],
      memoryHits: [],
      decision: "allow",
    }
  }

  const oldSymbols = extractSymbols(oldContent)
  const newSymbols = extractSymbols(newContent)
  const oldShapes = toSymbolShapes(oldSymbols)
  const newShapes = toSymbolShapes(newSymbols)
  const apiChanges = diffApiSurface(oldShapes, newShapes)

  // Collect symbol names for caller search
  const relevantChanges = apiChanges.filter(c => {
    const os = oldSymbols.get(c.symbol)
    const ns = newSymbols.get(c.symbol)
    return os?.exported || ns?.exported || os?.kind === "function" || ns?.kind === "function"
  })
  const relevantSymbols = changedSymbolNames(relevantChanges)

  // ── PR 3: Semantic reference as PRIMARY caller discovery path ──
  // Try the type-checker-based semantic path first. Falls back to
  // text-based AST scan when the program is still building.
  const semanticProvider = getSemanticReferenceProvider(projectRoot)
  const semanticResult = semanticProvider.findCallers(targetFile, relevantSymbols, oldSymbols)

  let callers: RippleCaller[]
  if (semanticResult.semanticPathUsed) {
    callers = semanticResult.references
    // Supplement same-file callers from text scan — semantic path filters
    // out same-file references as self-references, but we need them for
    // non-exported functions that the text scan catches.
    if (relevantSymbols.length > 0) {
      const textCallers = findCallers(projectRoot, targetFile, relevantSymbols)
      const sameFile = textCallers.filter(c => c.file === targetFile)
      const seen = new Set(callers.map(c => `${c.file}:${c.line}`))
      for (const c of sameFile) {
        if (!seen.has(`${c.file}:${c.line}`)) {
          callers.push(c)
        }
      }
    }
  } else {
    // FALLBACK: semantic program not ready — use text-based scan
    // with secondary semantic verification (existing path).
    const fastCallers = findCallers(projectRoot, targetFile, relevantSymbols)
    callers = verifyCallersSemantically(fastCallers, targetFile, relevantSymbols, oldSymbols, newContent, projectRoot)
  }

  // ── PR 7: Ast-grep enrichment ──
  // Run ast-grep as a supplementary path. In semantic-primary mode it
  // catches cross-language references (e.g. .js files importing from .ts).
  // In fallback mode it adds precision to text-based results.
  if (relevantSymbols.length > 0) {
    const astGrep = getAstGrepProvider(projectRoot)
    if (astGrep.isAvailable()) {
      const agCallers = astGrep.discoverCallers(targetFile, relevantSymbols)
      if (agCallers.length > 0) {
        const seen = new Set(callers.map(c => `${c.file}:${c.line}`))
        for (const c of agCallers) {
          if (!seen.has(`${c.file}:${c.line}`)) {
            callers.push(c)
          }
        }
      }
    }
  }

  // ── PR 4: Classify each caller's usage pattern ──
  const usageImpacts = classifyCallers(callers, apiChanges)

  // ── PR 6: Build verification map ──
  const callerFiles = [...new Set(callers.map(c => c.file))]
  const verificationMap = buildVerificationMap(targetFile, callerFiles, apiChanges, usageImpacts, projectRoot)

  // ── Generate findings from structured ApiChange[] ──
  const findings: RippleFinding[] = []

  // ── Wire verificationStrictness into findings ──
  // Deep changes (async/signature/removal) with uncovered symbols surface
  // an advisory note — the model sees the verification gap but the decision
  // is unchanged (info severity). Escalation to warn/block still comes from
  // the specific change findings (async_boundary_changed, signature_changed, etc.).
  const strictness = verificationStrictness(apiChanges)
  if (strictness === "strict" && verificationMap.uncoveredSymbols.length > 0) {
    findings.push({
      file: targetFile,
      severity: "info",
      kind: "depth-warning",
      reason: `Strict verification gap: ${verificationMap.uncoveredSymbols.length} changed symbol(s) have no test coverage (${verificationMap.uncoveredSymbols.slice(0, 3).join(", ")}).`,
      suggestedFix: `Run \`${verificationMap.steps.find(s => s.priority === "required")?.command ?? "bun run typecheck"}\` and manually verify callers before proceeding.`,
    })
  }

  for (const change of apiChanges) {
    const symbolCallers = callers.filter(c => c.symbol === change.symbol)

    switch (change.kind) {
      case "export_removed": {
        const oldSym = oldSymbols.get(change.symbol)
        const replacement = oldSym ? detectReplacement(change.symbol, oldSym, newSymbols) : null
        const replacementHint = replacement
          ? ` Suggested replacement: '${replacement}'. Consider adding a deprecated re-export or cascade-migrating callers.`
          : ""
        // PR 4: enrich with usage-specific removal actions
        const usageActions = usageImpacts
          .filter(i => i.caller.symbol === change.symbol)
          .map(i => `  - ${i.caller.file}:${i.caller.line} (${i.usage}): ${i.requiredAction}`)
          .slice(0, 6)
        const usageBlock = usageActions.length > 0
          ? `\nPer-caller actions:\n${usageActions.join("\n")}`
          : ""
        findings.push({
          file: targetFile,
          line: change.oldShape?.line,
          severity: "block",
          kind: replacement ? "deprecated-replacement" : "exported-symbol-removal",
          reason: `Exported ${change.oldShape?.kind ?? "symbol"} '${change.symbol}' was removed.${replacementHint}${usageBlock}`,
          suggestedFix: replacement
            ? `Deprecation-replacement: '${change.symbol}' → '${replacement}'. Add a re-export alias or update all callers in one transaction.`
            : "Keep a compatibility export or update every caller in the same transaction.",
        })
        break
      }

      case "async_boundary_changed": {
        if (symbolCallers.length > 0) {
          // PR 4: count callers that specifically need await
          const awaitCount = usageImpacts.filter(i =>
            i.caller.symbol === change.symbol && i.requiredAction.includes("await")
          ).length
          const detailParts = [`'${change.symbol}' now returns a Promise/async result and has ${symbolCallers.length} external caller(s).`]
          if (awaitCount > 0) detailParts.push(`${awaitCount} call site(s) need await.`)
          findings.push({
            file: symbolCallers[0]?.file ?? targetFile,
            line: symbolCallers[0]?.line,
            severity: "block",
            kind: "async-return-change",
            reason: detailParts.join(" "),
            suggestedFix: "Update callers to await or preserve a synchronous wrapper.",
          })
        }
        break
      }

      case "signature_changed": {
        if (symbolCallers.length > 0) {
          // PR 4: count callers that need argument updates
          const updateCount = usageImpacts.filter(i =>
            i.caller.symbol === change.symbol && i.requiredAction.includes("arguments")
          ).length
          const detailParts = [`'${change.symbol}' signature changed and ${symbolCallers.length} external caller(s) reference it.`]
          if (updateCount > 0) detailParts.push(`${updateCount} call site(s) need argument update.`)
          findings.push({
            file: symbolCallers[0]?.file ?? targetFile,
            line: symbolCallers[0]?.line,
            severity: change.severity,
            kind: "signature-change",
            reason: detailParts.join(" "),
            suggestedFix: "Generate a cascade patch for affected callers before writing.",
          })
        }
        break
      }

      case "return_type_changed": {
        if (change.severity === "warn" && symbolCallers.length > 0) {
          findings.push({
            file: symbolCallers[0]?.file ?? targetFile,
            line: symbolCallers[0]?.line,
            severity: "warn",
            kind: "signature-change",
            reason: change.detail,
            suggestedFix: "Verify callers handle the new return type.",
          })
        }
        break
      }

      case "interface_field_removed": {
        // symbol is "InterfaceName.fieldName" — extract interface name
        const ifaceName = change.symbol.split(".")[0] ?? change.symbol
        const oldSym = oldSymbols.get(ifaceName)
        findings.push({
          file: targetFile,
          line: oldSym?.line,
          severity: "block",
          kind: "exported-type-change",
          reason: change.detail,
          suggestedFix: "Keep deprecated fields or update all object construction and property reads in one transaction.",
        })
        break
      }

      case "kind_changed": {
        if (change.severity === "block" || change.severity === "warn") {
          findings.push({
            file: targetFile,
            line: change.oldShape?.line,
            severity: change.severity,
            kind: "exported-type-change",
            reason: change.detail,
            suggestedFix: "Verify all consumers handle the kind change.",
          })
        }
        break
      }

      // export_added, interface_field_added → no finding (informational only)
    }
  }

  const changedNames = changedSymbolNames(apiChanges)
  const memoryHits = new HybridMemory(projectRoot).findRelevant(`${targetFile} ${changedNames.join(" ")}`)
  for (const hit of memoryHits) {
    findings.push({
      file: targetFile,
      severity: "warn",
      kind: "memory-contract",
      reason: `Project memory matched '${hit.topic}': ${hit.rule}`,
      suggestedFix: `Review source ${hit.source} before applying this edit.`,
    })
  }

  const kernel = buildContextKernel(projectRoot)
  const report: RippleReport = {
    targetFile,
    changedSymbols: changedNames,
    apiChanges,
    usageImpacts,
    verificationMap,
    callers,
    findings,
    memoryHits,
    contextKernel: {
      hash: kernel.hash,
      estimatedTokens: kernel.estimatedTokens,
      sections: kernel.sections,
    },
    decision: "allow",
  }

  const MAX_AFFECTED_CALLERS = 10
  if (callers.length > MAX_AFFECTED_CALLERS) {
    findings.push({
      file: targetFile,
      severity: "block",
      kind: "caller-overflow",
      reason: `Ripple blocked: ${callers.length} callers > limit ${MAX_AFFECTED_CALLERS}.`,
      suggestedFix: "Reduce scope or manually verify all callers before proceeding.",
    })
  } else if (changedNames.length > 2 && callers.length > 3) {
    findings.push({
      file: targetFile,
      severity: "warn",
      kind: "depth-warning",
      reason: `Ripple depth ${changedNames.length} symbols with ${callers.length} callers.`,
      suggestedFix: "Verify each caller handles the changed symbols correctly.",
    })
  }
  report.decision = decide(report)
  report.cascadePlan = buildCascadePlan(report)
  return report
}

// ── Semantic caller verification ──

/**
 * Cross-check text-based callers against the type checker.
 *
 * When fastCallers found cross-file references, the ProjectProgram's
 * type graph is used to:
 *   1. Filter out same-name-different-package false positives
 *   2. Catch barrel re-export chains that text search missed
 *
 * Degrades gracefully: if the program is not ready, returns fastCallers
 * unchanged (the existing behavior).
 */
function verifyCallersSemantically(
  fastCallers: RippleCaller[],
  targetFile: string,
  changed: string[],
  oldSymbols: Map<string, { kind: string; exported: boolean; line: number; async: boolean; returnType: string; nameStart: number }>,
  _newContent: string,
  projectRoot: string,
): RippleCaller[] {
  if (fastCallers.length === 0) return fastCallers

  try {
    const program = getRippleProgram()
    program.ensureProgram()
    if (!program.ready) return fastCallers

    // Build a map of verified semantic callers by file:line
    const verified = new Map<string, RippleCaller>()
    const fastMap = new Map<string, RippleCaller>()
    for (const c of fastCallers) {
      fastMap.set(`${c.file}:${c.line}`, c)
    }

    // For each changed exported symbol, find semantic references
    for (const name of changed) {
      const oldSym = oldSymbols.get(name)
      if (!oldSym?.exported) continue

      const absTarget = resolve(projectRoot, targetFile)
      // PR 1+2: use precise nameStart byte offset, not fragile lineStart
      const position = oldSym.nameStart
      if (position < 0) continue

      const semRefs = program.findReferences(absTarget, position)
      for (const ref of semRefs) {
        const key = `${ref.file}:${ref.line}`
        if (verified.has(key)) continue

        // Check if a text-based caller at the same location exists
        // (confirms text match was correct)
        const textMatch = fastMap.get(key)
        if (textMatch) {
          verified.set(key, textMatch)
        } else {
          // New reference found by semantic analysis — text search missed it
          // (likely barrel re-export or type-alias chain)
          verified.set(key, ref)
        }
      }
    }

    // Merge: keep all verified callers + text-only callers that are same-file
    // (same-file references are usually correct even without semantic check)
    const result: RippleCaller[] = []
    const seen = new Set<string>()
    for (const c of fastCallers) {
      const key = `${c.file}:${c.line}`
      const semRef = verified.get(key)
      if (semRef) {
        if (!seen.has(key)) { result.push(semRef); seen.add(key) }
      } else if (c.file === targetFile || !oldSymbols.has(c.symbol)) {
        // Same-file or non-symbol text match — keep
        if (!seen.has(key)) { result.push(c); seen.add(key) }
      }
      // Cross-file text matches without semantic confirmation → dropped (false positive)
    }
    // Add semantic references that text search missed
    for (const [key, ref] of verified) {
      if (!seen.has(key)) { result.push(ref); seen.add(key) }
    }

    return result
  } catch {
    return fastCallers
  }
}

// ── Concise ripple message formatters (for model context) ──

/** Minimal ripple block message — model needs only actionable items. */
export function formatRippleBlock(report: RippleReport): string {
  // PR 4: annotate callers with usage kind + required action
  const callerLines = report.callers.slice(0, 6).map(c => {
    const impact = report.usageImpacts?.find(i => i.caller.file === c.file && i.caller.line === c.line)
    const actionTag = impact && impact.usage !== "plain_ref"
      ? ` [${impact.usage}: ${impact.requiredAction}]`
      : ""
    return `- ${c.file}:${c.line} — uses ${c.symbol}${actionTag}`
  })
  const findingReasons = report.findings
    .filter(f => f.severity === "block")
    .map(f => f.reason)
  const changeSummary = report.apiChanges
    .filter(c => c.severity === "block" || c.severity === "warn")
    .map(c => `${c.symbol}(${c.kind})`)
    .join(", ") || report.changedSymbols.join(", ")

  // PR 4: add usage summary when available
  const usageLines = report.usageImpacts && report.usageImpacts.length > 0
    ? formatUsageSummary(report.usageImpacts)
    : ""

  // PR 6: add verification commands when available
  const verifyLines = report.verificationMap && report.verificationMap.steps.length > 0
    ? formatVerificationMap(report.verificationMap)
    : ""

  const parts = [
    "<system-reminder>",
    `[Ripple blocked] ${changeSummary} 变更影响 ${report.callers.length} 个调用方:`,
    ...callerLines,
  ]
  if (usageLines) {
    parts.push("Required actions:", usageLines)
  }
  if (verifyLines) {
    parts.push(verifyLines)
  }
  if (findingReasons.length) {
    parts.push("原因:", ...findingReasons.map(r => `  - ${r}`))
  }
  parts.push(
    "→ 使用 multi_edit 级联修复所有受影响的调用方后重试写盘。",
    "</system-reminder>"
  )
  return parts.join("\n")
}

/** Minimal exit gate message. */
export function formatRippleExitGateCallers(obligations: Array<{ caller: RippleCaller; symbol: string }>): string {
  const lines = obligations.slice(0, 8).map(o =>
    `- ${o.caller.file}:${o.caller.line} (${o.symbol})`
  )
  return [
    "<system-reminder>",
    `[Ripple pending] ${obligations.length} 个调用方未同步:`,
    ...lines,
    "→ 读取这些文件，级联修复，typecheck 验证。",
    "</system-reminder>",
  ].join("\n")
}

export function formatCascadeSuggestion(report: RippleReport): string {
  const plan = report.cascadePlan ?? buildCascadePlan(report)

  const lines = [
    "[Cascade Suggestion]",
    `Affected files: ${plan.affectedFiles.join(", ")}`,
    `Recommended tool: ${plan.recommendedTool}`,
  ]

  if (report.callers.length) {
    lines.push("Callers to inspect:")
    for (const caller of report.callers.slice(0, 8)) {
      lines.push(`- ${caller.file}:${caller.line} uses ${caller.symbol}: ${caller.text.slice(0, 140)}`)
    }
  }

  if (report.findings.length) {
    lines.push("Reasons:")
    for (const finding of report.findings.slice(0, 8)) {
      const loc = finding.line ? `${finding.file}:${finding.line}` : finding.file
      lines.push(`- ${loc}: ${finding.reason}`)
      if (finding.suggestedFix) lines.push(`  next: ${finding.suggestedFix}`)
    }
  }

  lines.push("Next actions:")
  for (const [index, step] of plan.steps.entries()) {
    lines.push(`${index + 1}. ${step}`)
  }

  return lines.join("\n")
}
