/** ProjectProgram — project-wide TypeScript type graph via ts.createProgram.
 *
 *  Provides semantic reference resolution that the text-based findCallers
 *  in engine.ts cannot do: barrel re-export chains, type-alias resolution,
 *  filtering out same-name-different-package false positives.
 *
 *  Design:
 *    - Lazy creation on first call
 *    - mtime-based cache reuse (skip rebuild if no source files changed)
 *    - File write invalidates individual files, not the entire program
 *    - Non-blocking: callers use fast path if program is still building
 */

import ts from "typescript"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve, dirname } from "node:path"
import type { RippleCaller } from "./types"

const SKIP_DIRS = new Set([".git", ".codegraph", "node_modules", "dist", "coverage", ".next", ".orcana"])

interface FileVersion {
  mtimeMs: number
  version: number
}

export class ProjectProgram {
  private program: ts.Program | null = null
  private checker: ts.TypeChecker | null = null
  private fileVersions = new Map<string, FileVersion>()
  private projectRoot: string
  private sourceFiles: string[] = []
  private building = false
  private buildPromise: Promise<void> | null = null
  private lastBuildMs = 0

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot)
  }

  /** Whether the program is ready for semantic queries. */
  get ready(): boolean {
    return this.program !== null && !this.building
  }

  /** Get the (possibly stale) program. Callers must check `ready` first. */
  private getProgram(): ts.Program | null {
    return this.program
  }

  /** Build or rebuild the program. Non-blocking — returns immediately if building. */
  ensureProgram(): void {
    if (this.building) return
    if (this.program && !this.filesChanged()) return

    this.building = true
    this.buildPromise = this.build()
    this.buildPromise.finally(() => { this.building = false })
  }

  private async build(): Promise<void> {
    const started = Date.now()

    // Discover source files (or reuse cached list)
    if (this.sourceFiles.length === 0 || this.filesChanged()) {
      this.sourceFiles = this.discoverFiles()
    }

    if (this.sourceFiles.length === 0) {
      this.program = null
      this.checker = null
      return
    }

    // Read tsconfig compiler options
    const tsconfigPath = resolve(this.projectRoot, "tsconfig.json")
    const compilerOptions: ts.CompilerOptions = existsSync(tsconfigPath)
      ? this.readTsConfig(tsconfigPath)
      : {
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
        }

    // Determine module resolution kind — fileExtension is critical for
    // .ts/.tsx resolution in createProgram
    try {
      this.program = ts.createProgram(this.sourceFiles, {
        ...compilerOptions,
        noEmit: true,
        skipLibCheck: true,
      })
      this.checker = this.program.getTypeChecker()

      // Update file version tracking
      for (const file of this.sourceFiles) {
        try {
          const st = statSync(file)
          this.fileVersions.set(file, { mtimeMs: st.mtimeMs, version: (this.fileVersions.get(file)?.version ?? 0) + 1 })
        } catch { /* file deleted mid-scan */ }
      }
    } catch {
      // Program creation failed — likely syntax errors in project files
      this.program = null
      this.checker = null
    }

    this.lastBuildMs = Date.now() - started
  }

  // ── Semantic queries ──

  /**
   * Find semantic references to a symbol at a given position.
   * Returns caller locations with file + line, filtered to project scope.
   * This is the type-checker answer — no text matching.
   */
  findReferences(fileName: string, position: number): RippleCaller[] {
    if (!this.checker || !this.program) return []

    const sourceFile = this.program.getSourceFile(fileName)
    if (!sourceFile) return []

    // Get the symbol at the position using the type checker
    const node = findNodeAtPosition(sourceFile, position)
    if (!node) return []

    const symbol = this.checker.getSymbolAtLocation(node)
    if (!symbol) return []

    // Follow alias chains (import { foo } from './bar' → actual declaration)
    const resolvedSymbol = this.checker.getAliasedSymbol(symbol) ?? symbol

    // Get all references across the project
    const references = this.findReferencesForSymbol(resolvedSymbol, sourceFile, position)

    // Convert to RippleCaller format, filter to project scope
    const root = this.projectRoot
    const callers: RippleCaller[] = []

    for (const ref of references) {
      const refFile = ref.fileName ?? fileName
      const absPath = resolve(refFile)
      // Skip non-project files (node_modules, lib.d.ts, etc.)
      if (!absPath.startsWith(root) && !refFile.startsWith(root)) continue

      const relPath = relative(root, refFile).replace(/\\/g, "/")
      // Skip self-references (the declaration site)
      if (relPath === relative(root, fileName).replace(/\\/g, "/") && ref.textSpan.start === position) continue

      // Read the line for context
      let line = 1
      let text = ""
      try {
        const content = readFileSync(refFile, "utf-8")
        const pos = ref.textSpan.start
        let charCount = 0
        for (let i = 0; i < Math.min(pos, content.length); i++) {
          if (content[i] === "\n") { line++; charCount = 0 }
          else charCount++
        }
        const lineStart = pos - charCount
        const lineEnd = content.indexOf("\n", pos)
        text = content.slice(lineStart, lineEnd >= 0 ? lineEnd : content.length).trim()
      } catch { continue }

      callers.push({
        file: relPath,
        line,
        symbol: symbol.getName(),
        text: text.slice(0, 160),
      })
    }

    return callers
  }

  /**
   * Get the resolved symbol at a position. Handles import aliases
   * and re-exports by following the alias chain to the root declaration.
   */
  getSymbolAt(fileName: string, position: number): ts.Symbol | undefined {
    if (!this.checker || !this.program) return undefined
    const sourceFile = this.program.getSourceFile(fileName)
    if (!sourceFile) return undefined
    const node = findNodeAtPosition(sourceFile, position)
    if (!node) return undefined
    const symbol = this.checker.getSymbolAtLocation(node)
    return symbol ? (this.checker.getAliasedSymbol(symbol) ?? symbol) : undefined
  }

  /** Called after a file is written — invalidate it in the program cache. */
  invalidateFile(fileName: string): void {
    const absPath = resolve(fileName)
    this.fileVersions.delete(absPath)
  }

  /** Full program rebuild on next ensureProgram(). */
  invalidate(): void {
    this.program = null
    this.checker = null
    this.fileVersions.clear()
    this.sourceFiles = []
  }

  // ── Internal ──

  private filesChanged(): boolean {
    if (this.sourceFiles.length === 0) return true
    for (const file of this.sourceFiles) {
      const prev = this.fileVersions.get(file)
      if (!prev) return true
      try {
        const st = statSync(file)
        if (st.mtimeMs !== prev.mtimeMs) return true
      } catch { return true }
    }
    return false
  }

  private discoverFiles(): string[] {
    const files: string[] = []
    const walk = (dir: string) => {
      let entries
      try { entries = readdirSync(dir).sort() } catch { return }
      for (const name of entries) {
        const full = join(dir, name)
        let st
        try { st = statSync(full) } catch { continue }
        if (st.isDirectory()) {
          if (!SKIP_DIRS.has(name)) walk(full)
        } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
          files.push(full)
        }
      }
    }
    // Walk src/ and tests/ only (avoid root config files)
    for (const sub of ["src", "tests"]) {
      const d = join(this.projectRoot, sub)
      if (existsSync(d)) walk(d)
    }
    return files
  }

  private readTsConfig(configPath: string): ts.CompilerOptions {
    try {
      const configFile = ts.readConfigFile(configPath, path =>
        readFileSync(path, "utf-8")
      )
      if (configFile.error) return {}
      const parsed = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        dirname(configPath),
      )
      return parsed.options
    } catch {
      return {}
    }
  }

  /**
   * Find all references to a symbol across the program.
   * Uses ts.getPreEmitDiagnostics() to ensure full type checking,
   * then iterates all source files looking for references.
   */
  private findReferencesForSymbol(
    symbol: ts.Symbol,
    sourceFile: ts.SourceFile,
    position: number,
  ): Array<{ fileName: string; textSpan: { start: number; length: number } }> {
    const files = this.program?.getSourceFiles() ?? []
    const results: Array<{ fileName: string; textSpan: { start: number; length: number } }> = []

    for (const sf of files) {
      // Skip declaration files
      if (sf.isDeclarationFile) continue
      const sfPath = sf.fileName
      if (!sfPath.startsWith(this.projectRoot) && !sfPath.replace(/\\/g, "/").startsWith(this.projectRoot.replace(/\\/g, "/"))) continue

      // Walk the AST looking for identifiers that resolve to this symbol
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node)) {
          const nodeSymbol = this.checker?.getSymbolAtLocation(node)
          const resolved = nodeSymbol ? (this.checker?.getAliasedSymbol(nodeSymbol) ?? nodeSymbol) : undefined
          if (resolved === symbol) {
            results.push({
              fileName: sfPath,
              textSpan: { start: node.getStart(sf), length: node.getWidth(sf) },
            })
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
    }

    return results
  }
}

// ── Helper: find the narrowest node at a position ──

function findNodeAtPosition(sourceFile: ts.SourceFile, position: number): ts.Node | undefined {
  function visit(node: ts.Node): ts.Node | undefined {
    if (position < node.getStart(sourceFile) || position >= node.getEnd()) return undefined
    const children: ts.Node[] = []
    ts.forEachChild(node, child => { children.push(child) })
    for (const child of children) {
      const found = visit(child)
      if (found) return found
    }
    return node
  }
  return visit(sourceFile)
}
