/**
 * SemanticReferenceProvider — Layer 2 of Ripple Engine 2.0.
 *
 * Primary caller finder using TypeScript's type checker via ProjectProgram.
 * Replaces the text-based findCallers() as the main entry point for
 * discovering ripple impact.
 *
 * Design:
 *   - Wraps ProjectProgram (ts.createProgram + TypeChecker)
 *   - Primary path: semantic reference resolution (resolves imports, re-exports, aliases)
 *   - Fallback path: text-based AST scan (existing findCallers in engine.ts)
 *   - Lazy initialization — program builds on first use
 *   - Deduplicates references across symbols
 *
 * Why not ts-morph:
 *   ProjectProgram already provides the same capability (semantic findReferences)
 *   via the native TypeScript Compiler API. No extra dependency needed.
 */

import { relative, resolve } from "node:path"
import type { RippleCaller } from "./types"
import { ProjectProgram } from "./program"

// ── Types ──────────────────────────────────────────────────────────

export interface SemanticReference {
  /** Relative path from project root. */
  file: string
  /** 1-based line number. */
  line: number
  /** Resolved symbol name (canonical, not alias). */
  symbol: string
  /** Source line text (truncated to 160 chars). */
  text: string
}

export interface SemanticFindResult {
  /** Semantic references found (deduplicated). */
  references: RippleCaller[]
  /** true if the semantic path was used (program was ready). */
  semanticPathUsed: boolean
}

// ── Provider ───────────────────────────────────────────────────────

export class SemanticReferenceProvider {
  private program: ProjectProgram
  private projectRoot: string

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot)
    this.program = new ProjectProgram(this.projectRoot)
  }

  /** Whether the type-checker program is ready for queries. */
  get ready(): boolean {
    return this.program.ready
  }

  /**
   * Find all callers of changed symbols using semantic analysis.
   *
   * This is the PRIMARY caller discovery path. It:
   *   1. For each changed exported symbol, resolves via TypeChecker
   *   2. Follows import/export chains to find true references
   *   3. Deduplicates across symbols
   *   4. Filters out self-references (target file itself)
   *
   * **First-call limitation**: `ensureProgram()` builds the TypeScript
   * program asynchronously in the background. If this is the very first
   * call in a process (or the first call after a `reset`), the program
   * will still be building — `semanticPathUsed` will be `false` and
   * `references` will be empty. Callers MUST fall back to text-based
   * scanning in that case. On the *next* call (typically the next
   * agent round or ripple check), `ready` will be `true` and the
   * semantic path activates.
   *
   * This trade-off keeps ripple checks non-blocking — we never wait
   * for a full `ts.createProgram` build on the critical path.
   */
  findCallers(
    targetFile: string,
    changedSymbols: string[],
    oldSymbols: Map<string, { exported: boolean; nameStart: number }>,
  ): SemanticFindResult {
    // Trigger lazy build
    if (!this.ready) {
      this.program.ensureProgram()
      return { references: [], semanticPathUsed: false }
    }

    const absTarget = resolve(this.projectRoot, targetFile)
    const seen = new Map<string, RippleCaller>()

    for (const name of changedSymbols) {
      const oldSym = oldSymbols.get(name)
      if (!oldSym?.exported) continue

      const position = oldSym.nameStart
      if (position < 0) continue

      const semRefs = this.program.findReferences(absTarget, position)
      for (const ref of semRefs) {
        const key = `${ref.file}:${ref.line}`
        if (!seen.has(key)) {
          seen.set(key, ref)
        }
      }
    }

    return {
      references: [...seen.values()],
      semanticPathUsed: true,
    }
  }

  /**
   * Resolve a single symbol to its canonical representation.
   * Handles re-exports, barrel files, and type aliases.
   */
  resolveSymbol(
    fileName: string,
    position: number,
  ): { name: string } | undefined {
    if (!this.ready) return undefined
    const absPath = resolve(this.projectRoot, fileName)
    const symbol = this.program.getSymbolAt(absPath, position)
    return symbol ? { name: symbol.getName() } : undefined
  }

  /** Invalidate cached program state. */
  invalidate(): void {
    this.program.invalidate()
  }
}

// ── Global singleton (lazy, cached) ─────────────────────────────────

let _provider: SemanticReferenceProvider | null = null

/** Get or create the shared SemanticReferenceProvider. */
export function getSemanticReferenceProvider(projectRoot?: string): SemanticReferenceProvider {
  const root = projectRoot ?? process.cwd()
  if (!_provider) {
    _provider = new SemanticReferenceProvider(root)
  }
  return _provider
}

/** Reset the provider (e.g. after project root changes). */
export function resetSemanticReferenceProvider(): void {
  _provider?.invalidate()
  _provider = null
}
