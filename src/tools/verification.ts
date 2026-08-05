/** Tool Runtime 2.0 (RT-10): verification toolchain — the deterministic
 *  planner/runner replaces the model guessing verification commands.
 *
 *  discover_verification      — parse package.json scripts + tsconfig into a
 *                               verification command catalog.
 *  run_targeted_verification  — minimal verification set from modified files.
 *  classify_command_failure   — failure-signature classification (never raw
 *                               megabyte logs back to the model).
 *  verify_claim               — actually run the verification behind a
 *                               completion claim (tests/typecheck/build).
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ToolDef, ToolResult } from "./registry"
import { Result } from "./registry"
import { runProcess } from "./process"
import { recordVerificationCoverage } from "../file-state"

// ── discover_verification ──

export interface VerificationCommand {
  name: string
  script: string
  kind: "typecheck" | "test" | "build" | "lint" | "smoke" | "unknown"
}

export interface DiscoveredVerification {
  commands: VerificationCommand[]
  packages: string[]
  confidence: number
  sourceRefs: string[]
}

function classifyScript(name: string, script: string): VerificationCommand["kind"] {
  const text = `${name} ${script}`.toLowerCase()
  if (/tsc|typecheck|type-check/.test(text)) return "typecheck"
  if (/test|spec|jest|vitest|mocha/.test(text)) return "test"
  if (/build|compile/.test(text)) return "build"
  if (/lint|eslint|biome/.test(text)) return "lint"
  if (/smoke/.test(text)) return "smoke"
  return "unknown"
}

export function discoverVerification(projectRoot: string): DiscoveredVerification {
  const commands: VerificationCommand[] = []
  const packages: string[] = []
  const sourceRefs: string[] = []
  const pkgPath = join(projectRoot, "package.json")
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string>; name?: string; workspaces?: string[] }
      sourceRefs.push("package.json")
      if (pkg.name) packages.push(pkg.name)
      for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
        commands.push({ name, script, kind: classifyScript(name, script) })
      }
      for (const ws of pkg.workspaces ?? []) {
        const wsPkg = join(projectRoot, ws, "package.json")
        if (existsSync(wsPkg)) {
          packages.push(String(ws))
          sourceRefs.push(`${ws}/package.json`)
        }
      }
    } catch { /* malformed package.json → empty catalog */ }
  }
  if (existsSync(join(projectRoot, "tsconfig.json"))) sourceRefs.push("tsconfig.json")
  const confidence = commands.length > 0 ? Math.min(0.95, 0.5 + commands.length * 0.1) : 0.1
  return { commands, packages, confidence, sourceRefs }
}

// ── run_targeted_verification ──

export interface TargetedRun {
  kind: VerificationCommand["kind"]
  command: string
  passed: boolean
  exitCode: number | null
  issues: number
  summary: string
  durationMs: number
}

/** Minimal verification set for a set of modified files. */
export function targetedKinds(modifiedFiles: string[]): VerificationCommand["kind"][] {
  const kinds = new Set<VerificationCommand["kind"]>()
  for (const file of modifiedFiles) {
    if (/\.(ts|tsx)$/.test(file)) kinds.add("typecheck")
    if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(file)) kinds.add("test")
    if (/\.(js|jsx|mjs|cjs)$/.test(file)) kinds.add("test")
  }
  return kinds.size > 0 ? [...kinds] : ["typecheck"]
}

function kindCommands(catalog: DiscoveredVerification, kinds: VerificationCommand["kind"][]): VerificationCommand[] {
  return catalog.commands.filter((c) => kinds.includes(c.kind))
}

function countIssues(stdout: string, stderr: string, kind: VerificationCommand["kind"]): number {
  if (kind === "typecheck") {
    return (stdout.match(/error TS\d+/g) ?? []).length + (stderr.match(/error TS\d+/g) ?? []).length
  }
  if (kind === "test") {
    return (stdout.match(/\b(FAIL|failed|✗)\b/g) ?? []).length
  }
  return 0
}

// ── classify_command_failure ──

export interface FailureClassification {
  category: "typecheck" | "test_failure" | "compile" | "command_not_found" | "timeout" | "runtime" | "unknown"
  rootCauses: string[]
  failureSignature: string
  relatedFiles: string[]
}

const ANSI_RE = /\[[0-9;]*m/g

export function classifyCommandFailure(input: { command: string; stdout: string; stderr: string; timedOut?: boolean }): FailureClassification {
  const stdout = input.stdout.replace(ANSI_RE, "")
  const stderr = input.stderr.replace(ANSI_RE, "")
  const rootCauses: string[] = []
  const relatedFiles: string[] = []
  let category: FailureClassification["category"] = "unknown"
  let failureSignature = "unknown"

  if (input.timedOut) category = "timeout"
  const tsErrors = (stderr + "\n" + stdout).match(/(?:^|\n)\s*([^\n]+\.(?:ts|tsx|js|jsx))\((\d+),(\d+)\): error (TS\d+)/g)
  if (tsErrors && tsErrors.length > 0) {
    category = "typecheck"
    for (const err of tsErrors.slice(0, 5)) {
      const file = /([^\n]+\.(?:ts|tsx|js|jsx))\((\d+),(\d+)\)/.exec(err)?.[1]
      if (file) relatedFiles.push(file)
    }
    const codes = [...new Set(tsErrors.map((e) => /error (TS\d+)/.exec(e)?.[1]).filter(Boolean))]
    rootCauses.push(`TypeScript errors: ${codes.join(", ")}`)
    failureSignature = `tsc:${codes.join(",")}`
  }
  if (category === "unknown" && /command not found|not recognized|No such file/.test(stderr)) {
    category = "command_not_found"
    rootCauses.push(stderr.split("\n").find((l) => /not found|not recognized/.test(l)) ?? stderr.slice(0, 120))
    failureSignature = "command_not_found"
  }
  if (category === "unknown" && /AssertionError|FAIL|✗|failed \d+|Tests:.*failed/.test(stdout + stderr)) {
    category = "test_failure"
    const fails = (stdout + "\n" + stderr).split("\n").filter((l) => /FAIL|✗|AssertionError|failed/.test(l)).slice(0, 5)
    rootCauses.push(...fails)
    failureSignature = "tests_failed"
  }
  if (category === "unknown" && (stdout + stderr).length > 0) {
    category = "runtime"
    rootCauses.push((stderr.split("\n").filter(Boolean).slice(-3) ?? []).join("; ") || "non-zero exit with output")
    failureSignature = "runtime_failure"
  }
  if (rootCauses.length === 0) {
    rootCauses.push("non-zero exit code, no analyzable output")
    failureSignature = "non_zero_exit"
  }
  return { category, rootCauses: rootCauses.slice(0, 5), failureSignature, relatedFiles: [...new Set(relatedFiles)].slice(0, 10) }
}

// ── verify_claim ──

export type ClaimKind = "tests_passed" | "typecheck_passed" | "build_passed"

export function parseClaims(text: string): ClaimKind[] {
  const claims: ClaimKind[] = []
  if (/(typecheck|tsc|类型检查).*(通过|passed|success)/i.test(text)) claims.push("typecheck_passed")
  if (/(test|测试).*(通过|passed|all pass)/i.test(text)) claims.push("tests_passed")
  if (/(build|构建).*(通过|passed|succeeded)/i.test(text)) claims.push("build_passed")
  return claims
}

// ── Tool definitions ──

const DISCOVER_SCHEMA = {
  type: "object",
  properties: {
    cwd: { type: "string", description: "Project root (default: current directory)" },
  },
} as const

export const DISCOVER_VERIFICATION_TOOL: ToolDef = {
  name: "discover_verification",
  description: "Discover the project's verification commands from package.json scripts + tsconfig: typecheck/test/build/lint with confidence + source refs.",
  isReadonly: true,
  category: "safe",
  isConcurrencySafe: true,
  inputSchema: DISCOVER_SCHEMA as unknown as Record<string, unknown>,
  execute(params) {
    const projectRoot = typeof params["cwd"] === "string" ? String(params["cwd"]) : process.cwd()
    const found = discoverVerification(projectRoot)
    if (found.commands.length === 0) {
      return Result.ok("No verification commands discovered (no package.json scripts)", { discovered: found })
    }
    const lines = [
      `packages: ${found.packages.join(", ") || "(root)"}`,
      `confidence: ${found.confidence}`,
      `source: ${found.sourceRefs.join(", ")}`,
      "",
      ...found.commands.map((c) => `${c.kind.padEnd(10)} ${c.name} — ${c.script}`),
    ]
    return Result.ok(lines.join("\n"), { discovered: found })
  },
}

const TARGETED_SCHEMA = {
  type: "object",
  properties: {
    files: { type: "array", items: { type: "string" }, description: "Modified files" },
    cwd: { type: "string" },
  },
  required: ["files"],
} as const

export const RUN_TARGETED_VERIFICATION_TOOL: ToolDef = {
  name: "run_targeted_verification",
  description: "Compute the minimal verification set for modified files and run it (typecheck for TS edits, tests for test files). Structured passed/issues per command.",
  isReadonly: false,
  category: "shell",
  requiresConfirmation: true,
  inputSchema: TARGETED_SCHEMA as unknown as Record<string, unknown>,
  async execute(params) {
    const files = Array.isArray(params["files"]) ? (params["files"] as unknown[]).map(String) : []
    const projectRoot = typeof params["cwd"] === "string" ? String(params["cwd"]) : process.cwd()
    if (files.length === 0) return Result.fail("run_targeted_verification requires files")
    const kinds = targetedKinds(files)
    const catalog = discoverVerification(projectRoot)
    const commands = kindCommands(catalog, kinds)
    const runs: TargetedRun[] = []
    for (const cmd of commands) {
      const r = await runProcess({ command: "npm", args: ["run", cmd.name, "--silent"], cwd: projectRoot, timeoutMs: 180_000 })
      runs.push({
        kind: cmd.kind,
        command: `npm run ${cmd.name}`,
        passed: r.exitCode === 0 && !r.timedOut,
        exitCode: r.exitCode,
        issues: countIssues(r.stdout, r.stderr, cmd.kind),
        summary: r.timedOut ? "timed out" : r.exitCode === 0 ? "passed" : `${cmd.kind} failed`,
        durationMs: r.durationMs,
      })
    }
    if (runs.length === 0) {
      return Result.failWithMetadata("no verification commands found for the changed file kinds", { kinds })
    }
    const lines = runs.map((r) => `${r.passed ? "PASS" : "FAIL"} ${r.kind.padEnd(10)} ${r.command} (${r.durationMs}ms${r.issues ? `, ${r.issues} issues` : ""})`)
    const allPassed = runs.every((r) => r.passed)
    if (allPassed) {
      // [command-to-file] This verification ran against the CURRENT disk
      // state for the given files — record coverage of unmanaged (shell)
      // writes so the completion gate can relax the binding requirement.
      recordVerificationCoverage(files)
      return Result.ok(lines.join("\n"), { runs, allPassed })
    }
    return Result.failWithMetadata(lines.join("\n"), { runs, allPassed })
  },
}

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string" },
    stdout: { type: "string" },
    stderr: { type: "string" },
    timedOut: { type: "boolean" },
  },
  required: ["command", "stdout", "stderr"],
} as const

export const CLASSIFY_COMMAND_FAILURE_TOOL: ToolDef = {
  name: "classify_command_failure",
  description: "Classify a failed command's output into a failure signature: typecheck/test/compile/not-found/timeout categories, root causes, related files. ANSI cleaned.",
  isReadonly: true,
  category: "safe",
  isConcurrencySafe: true,
  inputSchema: CLASSIFY_SCHEMA as unknown as Record<string, unknown>,
  execute(params) {
    const cls = classifyCommandFailure({
      command: String(params["command"] ?? ""),
      stdout: String(params["stdout"] ?? ""),
      stderr: String(params["stderr"] ?? ""),
      timedOut: params["timedOut"] === true,
    })
    const lines = [
      `category: ${cls.category}`,
      `signature: ${cls.failureSignature}`,
      ...cls.relatedFiles.map((f) => `related: ${f}`),
      "",
      ...cls.rootCauses.map((c) => `- ${c}`),
    ]
    return Result.ok(lines.join("\n"), { classification: cls })
  },
}

const VERIFY_CLAIM_SCHEMA = {
  type: "object",
  properties: {
    claims: { type: "array", items: { type: "string", enum: ["tests_passed", "typecheck_passed", "build_passed"] }, description: "Claims to verify" },
    cwd: { type: "string" },
  },
  required: ["claims"],
} as const

export const VERIFY_CLAIM_TOOL: ToolDef = {
  name: "verify_claim",
  description: "Verify completion claims by actually running the project's verification (typecheck/test/build). Returns per-claim passed + evidence summary — a claim that cannot be run is FAILED, not assumed.",
  isReadonly: false,
  category: "shell",
  requiresConfirmation: true,
  inputSchema: VERIFY_CLAIM_SCHEMA as unknown as Record<string, unknown>,
  async execute(params) {
    const claims = Array.isArray(params["claims"]) ? (params["claims"] as unknown[]).map(String) : []
    const projectRoot = typeof params["cwd"] === "string" ? String(params["cwd"]) : process.cwd()
    const catalog = discoverVerification(projectRoot)
    const kindFor: Record<string, VerificationCommand["kind"]> = {
      tests_passed: "test",
      typecheck_passed: "typecheck",
      build_passed: "build",
    }
    const results: Array<{ claim: string; passed: boolean; ran: string | null; issues: number }> = []
    for (const claim of claims) {
      const kind = kindFor[claim]
      const cmd = catalog.commands.find((c) => c.kind === kind)
      if (!cmd) {
        results.push({ claim, passed: false, ran: null, issues: 0 })
        continue
      }
      const r = await runProcess({ command: "npm", args: ["run", cmd.name, "--silent"], cwd: projectRoot, timeoutMs: 240_000 })
      results.push({
        claim,
        passed: r.exitCode === 0 && !r.timedOut,
        ran: `npm run ${cmd.name}`,
        issues: countIssues(r.stdout, r.stderr, cmd.kind),
      })
    }
    const allPassed = results.every((r) => r.passed)
    const lines = results.map((r) => `${r.passed ? "VERIFIED" : "UNVERIFIED"} ${r.claim}${r.ran ? ` (${r.ran})` : " (no command found)"}`)
    if (allPassed) return Result.ok(lines.join("\n"), { results, allPassed })
    return Result.failWithMetadata(lines.join("\n"), { results, allPassed })
  },
}
