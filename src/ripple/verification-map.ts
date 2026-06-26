/**
 * Verification Map — Layer 6 of Ripple Engine 2.0.
 *
 * Maps API changes to concrete verification commands. When ripple detects
 * a change, this layer tells the agent exactly what to run to verify the
 * change is safe: which test files, which typecheck commands, and whether
 * coverage of the changed symbols is adequate.
 *
 * Test file discovery is convention-based:
 *   src/foo/bar.ts → tests/bar.test.ts, tests/foo/bar.test.ts
 *   src/foo/index.ts → tests/foo.test.ts
 */

import { existsSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import type { ApiChange, ApiChangeKind } from "./api-diff"
import type { RippleCaller } from "./types"
import type { UsageImpact } from "./usage-classifier"

// ── Types ────────────────────────────────────────────────────────────

export interface VerificationStep {
  /** Category of verification. */
  type: "typecheck" | "test" | "lint" | "custom"
  /** Shell command to run. */
  command: string
  /** Human-readable label for model context. */
  label: string
  /** How directly this step verifies the changed symbols. */
  coverage: "direct" | "indirect" | "none"
  /** Whether this step is required, recommended, or optional. */
  priority: "required" | "recommended" | "optional"
}

export interface VerificationMap {
  /** The file that was changed. */
  targetFile: string
  /** Ordered verification steps to run. */
  steps: VerificationStep[]
  /** Test files discovered for the target + caller files. */
  affectedTestFiles: string[]
  /** Changed symbols that have no discoverable test file. */
  uncoveredSymbols: string[]
  /** Estimated test coverage of changed symbols (0–1). */
  coverage: number
}

// ── Constants ────────────────────────────────────────────────────────

/** Extensions we consider "test files". */
const TEST_EXTENSIONS = [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", ".test.js", ".test.jsx"]

/** Directories that conventionally contain tests. */
const TEST_DIRS = ["tests", "__tests__", "test", "spec"]

// ── Core: Build Verification Map ─────────────────────────────────────

/**
 * Build a verification map for a changed file and its callers.
 *
 * Heuristics:
 * 1. Find the primary test file for the changed file
 * 2. Find test files for each caller file
 * 3. Always recommend a typecheck
 * 4. Estimate coverage by checking what fraction of changed symbols have test files
 */
export function buildVerificationMap(
  targetFile: string,
  callerFiles: string[],
  apiChanges: ApiChange[],
  usageImpacts: UsageImpact[],
  projectRoot: string,
): VerificationMap {
  const absRoot = resolve(projectRoot)
  const testFiles = new Set<string>()

  // 1. Test file for the changed file itself
  const targetTests = findTestFiles(targetFile, absRoot)
  for (const t of targetTests) testFiles.add(t)

  // 2. Test files for each caller file (up to 10 to avoid noise)
  const uniqueCallerFiles = [...new Set(callerFiles)].slice(0, 10)
  for (const cf of uniqueCallerFiles) {
    const ct = findTestFiles(cf, absRoot)
    for (const t of ct) testFiles.add(t)
  }

  // 3. Coverage: which changed symbols have matching test files?
  const changedSymbols = [...new Set(apiChanges.map(c => c.symbol.split(".")[0] ?? c.symbol))]
  const uncovered: string[] = []
  for (const sym of changedSymbols) {
    // A symbol is "covered" if its source file has a test file
    if (targetTests.length === 0) {
      uncovered.push(sym)
    }
  }

  const coverage = changedSymbols.length > 0
    ? (changedSymbols.length - uncovered.length) / changedSymbols.length
    : 1.0

  // 4. Build verification steps
  const steps = buildSteps(targetFile, [...testFiles], apiChanges, usageImpacts, absRoot)

  return {
    targetFile,
    steps,
    affectedTestFiles: [...testFiles],
    uncoveredSymbols: uncovered,
    coverage,
  }
}

// ── Test File Discovery ──────────────────────────────────────────────

/**
 * Find test files that likely cover a given source file.
 *
 * Checks multiple conventions:
 *   1. tests/<flat-name>.test.ts      (tests/engine.test.ts)
 *   2. tests/<subdir>/<name>.test.ts  (tests/ripple/engine.test.ts)
 *   3. __tests__/<name>.test.ts
 *   4. <src-dir>/__tests__/<name>.test.ts
 */
function findTestFiles(sourceFile: string, projectRoot: string): string[] {
  const rel = relative(projectRoot, resolve(projectRoot, sourceFile)).replace(/\\/g, "/")
  const parts = rel.split("/")

  // Extract filename without extension
  const fileName = parts[parts.length - 1] ?? ""
  const baseName = fileName.replace(/\.(ts|tsx|js|jsx)$/, "")

  // Remove "src/" prefix if present to get path inside source tree
  const srcStripped = parts[0] === "src" ? parts.slice(1) : parts
  const subDir = srcStripped.length > 1 ? srcStripped.slice(0, -1).join("/") : ""

  const candidates: string[] = []

  // Convention 1: tests/<baseName>.test.{ts,tsx}  (flat)
  for (const ext of TEST_EXTENSIONS) {
    for (const dir of TEST_DIRS) {
      candidates.push(join(projectRoot, dir, `${baseName}${ext}`))
    }
  }

  // Convention 2: tests/<subDir>/<baseName>.test.{ts,tsx}  (mirror)
  if (subDir) {
    for (const ext of TEST_EXTENSIONS) {
      for (const dir of TEST_DIRS) {
        candidates.push(join(projectRoot, dir, subDir, `${baseName}${ext}`))
      }
    }
  }

  // Convention 3: __tests__ inside source dir
  const srcDir = parts.slice(0, -1).join("/")
  if (srcDir) {
    for (const ext of TEST_EXTENSIONS) {
      candidates.push(join(projectRoot, srcDir, "__tests__", `${baseName}${ext}`))
    }
  }

  // Convention 4: index files → parent directory test
  //   src/ripple/index.ts → tests/ripple.test.ts
  if (baseName === "index" && subDir) {
    const parentParts = subDir.split("/")
    const parentName = parentParts[parentParts.length - 1] ?? ""
    if (parentName) {
      for (const ext of TEST_EXTENSIONS) {
        for (const dir of TEST_DIRS) {
          candidates.push(join(projectRoot, dir, `${parentName}${ext}`))
        }
      }
    }
  }

  // Filter to existing files
  const results: string[] = []
  for (const c of candidates) {
    try {
      if (existsSync(c)) {
        const relPath = relative(projectRoot, c).replace(/\\/g, "/")
        if (!results.includes(relPath)) {
          results.push(relPath)
        }
      }
    } catch {
      // Permission errors, etc. — skip
    }
  }

  return results
}

// ── Step Generation ──────────────────────────────────────────────────

function buildSteps(
  targetFile: string,
  testFiles: string[],
  apiChanges: ApiChange[],
  usageImpacts: UsageImpact[],
  projectRoot: string,
): VerificationStep[] {
  const steps: VerificationStep[] = []

  // ── 1. Typecheck (always required for TS changes) ──
  // NOTE: hardcoded "bun run typecheck" — assumes the project has this
  // package.json script. In a future iteration this should detect the
  // actual typecheck tool (tsc --noEmit, pnpm typecheck, etc.).
  steps.push({
    type: "typecheck",
    command: "bun run typecheck",
    label: "Type-check the full project",
    coverage: "direct",
    priority: "required",
  })

  // ── 2. Test files — individual when ≤3, aggregate otherwise ──
  const directTests = testFiles.filter(t => t.includes(baseNameNoExt(targetFile)))
  const indirectTests = testFiles.filter(t => !t.includes(baseNameNoExt(targetFile)))

  if (testFiles.length <= 3) {
    // Run each test file individually
    for (const tf of testFiles) {
      const isDirect = directTests.includes(tf)
      steps.push({
        type: "test",
        command: `bun test ${tf}`,
        label: `Run tests in ${tf}`,
        coverage: isDirect ? "direct" : "indirect",
        priority: isDirect ? "required" : "recommended",
      })
    }
  } else {
    // Too many — recommend aggregate
    if (directTests.length > 0) {
      const directCmd = directTests.length === 1
        ? `bun test ${directTests[0]}`
        : `bun test ${directTests.slice(0, 3).join(" ")}`
      steps.push({
        type: "test",
        command: directCmd,
        label: `Run direct test files (${directTests.length} found)`,
        coverage: "direct",
        priority: "required",
      })
    }
    if (indirectTests.length > 0) {
      steps.push({
        type: "test",
        command: "bun run test:all",
        label: `Run full test suite (${testFiles.length} related test files found)`,
        coverage: "indirect",
        priority: "recommended",
      })
    }
  }

  // ── 3. Usage-based hints ──
  const urgencyTags = new Set(usageImpacts.map(i => i.requiredAction))
  const signatureChanges = apiChanges.filter(c => c.kind === "signature_changed")
  const asyncChanges = apiChanges.filter(c => c.kind === "async_boundary_changed")
  const removalChanges = apiChanges.filter(c => c.kind === "export_removed" || c.kind === "interface_field_removed")

  // When signature/async/removal changes exist, add a focused re-test hint
  if (asyncChanges.length > 0) {
    steps.push({
      type: "custom",
      command: "bun run typecheck",
      label: "Verify all call sites handle async (await) correctly after change",
      coverage: "direct",
      priority: "required",
    })
  }

  if (signatureChanges.length > 0) {
    steps.push({
      type: "custom",
      command: "bun run typecheck",
      label: "Verify all call sites pass correct arguments to changed functions",
      coverage: "direct",
      priority: "required",
    })
  }

  // Deduplicate by command + label
  return deduplicateSteps(steps)
}

// ── Formatting ────────────────────────────────────────────────────────

/**
 * Format verification map as a concise block for model context.
 */
export function formatVerificationMap(map: VerificationMap): string {
  // Only fully empty maps produce no output — coverage warnings still
  // matter even when there are no explicit steps.
  if (map.steps.length === 0 && map.uncoveredSymbols.length === 0) return ""

  const lines: string[] = []
  if (map.steps.length > 0) {
    lines.push("[Verification Map]")
  }

  // Required steps first
  const required = map.steps.filter(s => s.priority === "required")
  const recommended = map.steps.filter(s => s.priority === "recommended")
  const optional = map.steps.filter(s => s.priority === "optional")

  if (required.length > 0) {
    lines.push("Required:")
    for (const s of required) {
      lines.push(`  ${s.label} → \`${s.command}\``)
    }
  }

  if (recommended.length > 0) {
    lines.push("Recommended:")
    for (const s of recommended) {
      lines.push(`  ${s.label} → \`${s.command}\``)
    }
  }

  if (optional.length > 0) {
    lines.push("Optional:")
    for (const s of optional) {
      lines.push(`  ${s.label} → \`${s.command}\``)
    }
  }

  // Coverage note
  if (map.coverage < 1.0 && map.uncoveredSymbols.length > 0) {
    const symList = map.uncoveredSymbols.slice(0, 5).join(", ")
    const more = map.uncoveredSymbols.length > 5 ? ` (+${map.uncoveredSymbols.length - 5} more)` : ""
    lines.push(`⚠ ${Math.round(map.coverage * 100)}% test coverage on changed symbols.`)
    lines.push(`  Uncovered: ${symList}${more}`)
  }

  return lines.join("\n")
}

/**
 * Minimal one-liner: the single most important verification command.
 */
export function primaryVerificationCommand(map: VerificationMap): string {
  const required = map.steps.filter(s => s.priority === "required")
  if (required.length > 0) return required[0]!.command
  return map.steps[0]?.command ?? "bun run typecheck"
}

// ── Merging ───────────────────────────────────────────────────────────

/**
 * Merge multiple verification maps (e.g., when ripple runs on multiple files).
 */
export function mergeVerificationMaps(maps: VerificationMap[]): VerificationMap {
  if (maps.length === 0) {
    return { targetFile: "", steps: [], affectedTestFiles: [], uncoveredSymbols: [], coverage: 0 }
  }
  if (maps.length === 1) return maps[0]!

  const allTestFiles = new Set<string>()
  const allSteps: VerificationStep[] = []
  const allUncovered = new Set<string>()
  let totalCoverage = 0

  for (const m of maps) {
    for (const tf of m.affectedTestFiles) allTestFiles.add(tf)
    for (const s of m.steps) allSteps.push(s)
    for (const us of m.uncoveredSymbols) allUncovered.add(us)
    totalCoverage += m.coverage
  }

  return {
    targetFile: maps.map(m => m.targetFile).join(", "),
    steps: deduplicateSteps(allSteps),
    affectedTestFiles: [...allTestFiles],
    uncoveredSymbols: [...allUncovered],
    coverage: totalCoverage / maps.length,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function baseNameNoExt(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/")
  const fileName = parts[parts.length - 1] ?? ""
  return fileName.replace(/\.(ts|tsx|js|jsx)$/, "")
}

function deduplicateSteps(steps: VerificationStep[]): VerificationStep[] {
  const seen = new Set<string>()
  const result: VerificationStep[] = []
  for (const s of steps) {
    const key = `${s.type}:${s.command}:${s.label}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push(s)
    }
  }
  return result
}

/**
 * Estimate whether a change is "shallow" — unlikely to cause runtime issues.
 * Used by engine.ts to adjust verification strictness.
 */
export function isShallowChange(apiChanges: ApiChange[]): boolean {
  if (apiChanges.length === 0) return true
  const shallowKinds: readonly ApiChangeKind[] = ["export_added", "interface_field_added"]
  return apiChanges.every(c => (shallowKinds as string[]).includes(c.kind))
}

/**
 * Estimate whether verification should be strict (more required steps).
 * Deep changes (async, signature, removal) demand strict verification.
 */
export function verificationStrictness(apiChanges: ApiChange[]): "strict" | "normal" | "relaxed" {
  if (apiChanges.length === 0) return "relaxed"
  const strictKinds: readonly ApiChangeKind[] = ["async_boundary_changed", "export_removed", "interface_field_removed", "signature_changed"]
  const hasStrict = apiChanges.some(c => (strictKinds as string[]).includes(c.kind))
  if (hasStrict) return "strict"
  if (isShallowChange(apiChanges)) return "relaxed"
  return "normal"
}
