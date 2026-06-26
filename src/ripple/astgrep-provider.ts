/**
 * AstGrep Provider — Layer 7 of Ripple Engine 2.0.
 *
 * External pattern-based caller discovery using ast-grep CLI
 * (https://ast-grep.github.io/). Serves as a precision fallback when
 * the TypeScript TypeChecker (ProjectProgram) is unavailable and the
 * text-based AST scan may produce false positives.
 *
 * Key advantages over text-based findCallers:
 *   1. Language-agnostic — handles .js, .jsx, .ts, .tsx equally
 *   2. Pattern-aware — matches AST structure not raw text
 *   3. Cross-language — works for non-TS projects
 *
 * Degrades gracefully: if `sg` is not installed, isAvailable() returns
 * false and all discovery methods return empty results. Zero runtime
 * cost when unused — availability is checked once and cached.
 */

import { execSync } from "node:child_process"
import { resolve, relative } from "node:path"
import type { RippleCaller } from "./types"

// ── Types ────────────────────────────────────────────────────────────

export interface AstGrepMatch {
  file: string
  line: number
  /** The pattern that produced this match. */
  pattern: string
  /** Matched source text. */
  text: string
}

export interface AstGrepStats {
  /** Whether ast-grep is available on this system. */
  available: boolean
  /** Version string (e.g. "0.19.0"), empty if not available. */
  version: string
  /** Total matches found in the last query. */
  lastMatchCount: number
  /** Pattern types that yielded matches. */
  matchedPatterns: string[]
}

// ── Pattern generation ──────────────────────────────────────────────

/**
 * Generate ast-grep patterns for finding references to a symbol.
 *
 * Each pattern targets a different usage kind. Patterns use ast-grep's
 * `$$$` (ellipsis) to match any number of args/params.
 *
 * Order: most-specific first to minimize noise in multi-pattern runs.
 */
function generatePatterns(symbol: string): Array<{ pattern: string; label: string }> {
  const escaped = symbol.replace(/([.*+?^${}()|[\]\\])/g, "\\$1")
  return [
    // 1. Import specifier — import { sym } from '...'
    { pattern: `import { $$$, ${escaped}, $$$ } from '$$$'`, label: "import" },
    // 2. Export specifier — export { sym } from '...'
    { pattern: `export { $$$, ${escaped}, $$$ }`, label: "re_export" },
    // 3. New expression — new Sym(args)
    { pattern: `new ${escaped}($$$)`, label: "new_instance" },
    // 4. Method call — obj.sym(args)
    { pattern: `$$$.${escaped}($$$)`, label: "method_call" },
    // 5. Direct call — sym(args)
    { pattern: `${escaped}($$$)`, label: "call_expr" },
    // 6. Bare identifier — catch-all for type refs, JSX, array types, etc.
    //    Intentionally broad; downstream dedup and caller-classifier
    //    refine these into specific usage kinds. Last pattern so earlier
    //    structured patterns (call_expr, method_call, etc.) match first.
    { pattern: `${escaped}`, label: "identifier" },
  ]
}

// ── Provider ─────────────────────────────────────────────────────────

export class AstGrepProvider {
  private _available: boolean | null = null
  private _version = ""
  private _lastMatchCount = 0
  private _matchedPatterns: string[] = []
  private projectRoot: string
  /** Test-only: override execSync. Not part of public API. */
  _execFn: ((cmd: string) => string) | null = null

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot)
  }

  // ── Availability ─────────────────────────────────────────────────

  /** Check whether ast-grep CLI is installed and functional. Cached. */
  isAvailable(): boolean {
    if (this._available !== null) return this._available
    try {
      const result = this._exec("sg --version").trim()
      // sg --version outputs something like "sg 0.19.0"
      const match = result.match(/(\d+\.\d+\.\d+)/)
      this._version = (match?.[1]) ?? result.slice(0, 20)
      this._available = true
    } catch {
      this._available = false
      this._version = ""
    }
    return this._available
  }

  /** Version string, empty if unavailable. */
  get version(): string {
    if (this._available === null) this.isAvailable()
    return this._version
  }

  /** Statistics from the last query. */
  get stats(): AstGrepStats {
    if (this._available === null) this.isAvailable()
    return {
      available: this._available ?? false,
      version: this._version,
      lastMatchCount: this._lastMatchCount,
      matchedPatterns: [...this._matchedPatterns],
    }
  }

  // ── Discovery ────────────────────────────────────────────────────

  /**
   * Discover callers of the given symbols using ast-grep pattern matching.
   *
   * Returns an empty array when ast-grep is unavailable or finds no matches.
   * Never throws — all errors are caught and logged to the stats object.
   */
  discoverCallers(
    targetFile: string,
    symbols: string[],
  ): RippleCaller[] {
    if (symbols.length === 0) return []

    if (!this.isAvailable()) {
      this._lastMatchCount = 0
      this._matchedPatterns = []
      return []
    }

    const absTarget = resolve(this.projectRoot, targetFile)
    const results: RippleCaller[] = []
    const seen = new Set<string>()
    const matchedLabels = new Set<string>()

    for (const sym of symbols) {
      const patterns = generatePatterns(sym)
      for (const { pattern, label } of patterns) {
        try {
          const matches = this.runQuery(pattern, absTarget)
          for (const m of matches) {
            const key = `${m.file}:${m.line}`
            if (seen.has(key)) continue
            seen.add(key)
            matchedLabels.add(label)
            results.push({
              file: relative(this.projectRoot, resolve(m.file)).replace(/\\/g, "/"),
              line: m.line,
              symbol: sym,
              text: m.text,
            })
          }
        } catch {
          // Pattern failed to parse or sg process died — skip this pattern
          continue
        }
      }
    }

    this._lastMatchCount = results.length
    this._matchedPatterns = [...matchedLabels]
    return results
  }

  // ── Internal: Run ast-grep query ─────────────────────────────────

  // ── Internal: Shell execution ────────────────────────────────────

  /**
   * Execute a shell command. Uses _execFn in test mode, execSync otherwise.
   */
  private _exec(cmd: string): string {
    if (this._execFn) return this._execFn(cmd)
    return execSync(cmd, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    }) as string
  }

  /**
   * Execute `sg scan` with a single pattern and parse JSON output.
   *
   * ast-grep JSON output format:
   *   [{ "file": "src/foo.ts", "range": { "start": { "line": 10, ... } }, "text": "..." }]
   */
  private runQuery(pattern: string, excludeFile: string): AstGrepMatch[] {
    const root = this.projectRoot
    // Quote the pattern for shell safety
    const cmd = `sg scan --json --no-ignore "${pattern.replace(/"/g, '\\"')}" "${root}"`

    let stdout = ""
    try {
      stdout = this._exec(cmd).trim()
    } catch (e: unknown) {
      // Exit code 1 = no matches (sg convention), other codes = real errors
      const code = (e as { status?: number })?.status
      if (code !== 1 && code !== undefined) {
        // Real error — re-throw to let caller handle
        throw e
      }
      return []
    }

    if (!stdout) return []

    let parsed: unknown
    try {
      parsed = JSON.parse(stdout)
    } catch {
      return []
    }

    if (!Array.isArray(parsed)) return []

    const absExclude = resolve(root, excludeFile)
    const results: AstGrepMatch[] = []

    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue
      const file = String((item as Record<string, unknown>).file ?? "")
      if (!file) continue

      // Skip matches in the changed file itself (self-references)
      try {
        if (resolve(file) === absExclude) continue
      } catch {
        continue
      }

      const range = (item as Record<string, unknown>).range as
        | { start?: { line?: number; column?: number } }
        | undefined
      const line = (range?.start?.line ?? 0) + 1 // sg uses 0-based lines
      const text = String((item as Record<string, unknown>).text ?? "")

      results.push({ file, line, pattern, text })
    }

    return results
  }
}

// ── Global singleton ─────────────────────────────────────────────────

let _astGrep: AstGrepProvider | null = null

export function getAstGrepProvider(projectRoot?: string): AstGrepProvider {
  const root = projectRoot ?? process.cwd()
  if (!_astGrep || _astGrep.stats.available === null) {
    _astGrep = new AstGrepProvider(root)
  }
  return _astGrep
}

export function resetAstGrepProvider(): void {
  _astGrep = null
}
