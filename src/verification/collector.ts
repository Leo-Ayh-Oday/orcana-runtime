/** Verification Collector — runs all verification kinds (typecheck, test, build, lint, smoke)
 *  and returns structured VerificationResult objects.
 *
 *  Timeouts: typecheck/test 3min, build 2min, lint 1min, smoke 30s
 */

import { execShellLegacy } from "../runtime/legacy-process"
const execSync = execShellLegacy
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { VerificationKind, VerificationResult } from "./result"

export interface CollectorOptions {
  projectRoot?: string
  timeout?: number
}

const KIND_TIMEOUTS: Record<VerificationKind, number> = {
  typecheck: 180_000,
  test: 180_000,
  build: 120_000,
  lint: 60_000,
  smoke: 30_000,
  unknown: 30_000,
}

/** Determine which verification kinds are available for this project. */
export function detectAvailableKinds(projectRoot: string): VerificationKind[] {
  const kinds: VerificationKind[] = []

  // typecheck: always available if tsconfig.json exists
  if (existsSync(join(projectRoot, "tsconfig.json"))) {
    kinds.push("typecheck")
  }

  // test: bun test
  const pkgPath = join(projectRoot, "package.json")
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
      if (pkg.scripts?.test) kinds.push("test")
      if (pkg.scripts?.build) kinds.push("build")
      if (pkg.scripts?.lint) kinds.push("lint")
    } catch { /* ignore */ }
  }

  // lint: check for common config files
  if (existsSync(join(projectRoot, ".eslintrc.json")) ||
      existsSync(join(projectRoot, ".eslintrc.js")) ||
      existsSync(join(projectRoot, "eslint.config.js")) ||
      existsSync(join(projectRoot, "oxlintrc.json"))) {
    if (!kinds.includes("lint")) kinds.push("lint")
  }

  // build: if tsconfig and package.json with build script
  if (!kinds.includes("build") && existsSync(join(projectRoot, "tsconfig.json"))) {
    // Fallback: try tsc --noEmit as build check
    kinds.push("build")
  }

  return kinds
}

/** Run a single verification. */
export async function runVerification(
  kind: VerificationKind,
  projectRoot: string,
): Promise<VerificationResult> {
  const start = Date.now()
  const timeout = KIND_TIMEOUTS[kind] ?? 30_000
  let command = ""
  let passed = false
  let issues = 0
  let summary = ""
  let exitCode: number | undefined

  try {
    switch (kind) {
      case "typecheck":
        command = "bun run typecheck"
        execSync(command, { cwd: projectRoot, timeout, stdio: "pipe" })
        passed = true
        summary = "ok"
        break

      case "test":
        command = "bun test"
        execSync(command, { cwd: projectRoot, timeout, stdio: "pipe" })
        passed = true
        summary = "tests passed"
        break

      case "build":
        command = "bun run build"
        execSync(command, { cwd: projectRoot, timeout, stdio: "pipe" })
        passed = true
        summary = "build succeeded"
        break

      case "lint":
        if (existsSync(join(projectRoot, "node_modules", ".bin", "eslint"))) {
          command = "npx eslint --quiet src/"
        } else if (existsSync(join(projectRoot, "oxlintrc.json"))) {
          command = "npx oxlint src/"
        } else {
          command = "bun run lint"
        }
        execSync(command, { cwd: projectRoot, timeout, stdio: "pipe" })
        passed = true
        summary = "lint passed"
        break

      case "smoke":
        command = "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000 || echo 'not listening'"
        const result = execSync(command, { cwd: projectRoot, timeout, stdio: "pipe", encoding: "utf-8" })
        passed = result.trim().startsWith("2") || result.trim().startsWith("3")
        summary = passed ? `HTTP ${result.trim()}` : "not responding"
        if (!passed) issues = 1
        break

      default:
        command = "unknown"
        passed = false
        summary = "unknown verification kind"
    }
  } catch (e: any) {
    passed = false
    exitCode = e.status ?? 1
    summary = e.stderr?.slice(0, 500) ?? e.message?.slice(0, 500) ?? "failed"
    issues = 1
  }

  const durationMs = Date.now() - start

  return {
    kind,
    command: command || "none",
    passed,
    exitCode,
    issues,
    durationMs,
    summary: summary.slice(0, 1000),
  }
}

/** Run all available verifications for a project. */
export async function runAllVerifications(projectRoot: string): Promise<VerificationResult[]> {
  const kinds = detectAvailableKinds(projectRoot)
  if (kinds.length === 0) return []

  const results: VerificationResult[] = []
  for (const kind of kinds) {
    try {
      results.push(await runVerification(kind, projectRoot))
    } catch {
      results.push({
        kind,
        command: "auto-detect failed",
        passed: false,
        issues: 1,
        durationMs: 0,
        summary: "verification runner failed to execute",
      })
    }
  }
  return results
}
