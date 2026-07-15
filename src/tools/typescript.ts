import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { ToolDef, ToolResult } from "./registry"
import { Result } from "./registry"

const TYPECHECK_RESULT_MAX_CHARS = 2000

export interface TypeScriptCheckResult {
  passed: boolean
  available: boolean
  issues: number
  output: string
}

export function getTscCommand(cwd = process.cwd()): string {
  const names = process.platform === "win32"
    ? ["tsc.cmd", "tsc.exe", "tsc.ps1", "tsc"]
    : ["tsc"]
  for (const name of names) {
    const local = resolve(cwd, "node_modules", ".bin", name)
    if (existsSync(local)) return `"${local}"`
  }
  return "tsc"
}

function looksUnavailable(output: string): boolean {
  return /not recognized|command not found|not found|enoent|failed to spawn/i.test(output)
}

function countIssues(output: string): number {
  const matches = output.match(/\berror TS\d+/g)
  return matches?.length ?? (output.trim() ? 1 : 0)
}

export function runTypeScriptNoEmit(cwd = process.cwd()): TypeScriptCheckResult {
  const command = getTscCommand(cwd)
  try {
    const out = execSync(`${command} --noEmit --pretty false 2>&1`, {
      encoding: "utf-8",
      timeout: 15000,
      cwd,
    })
    return { passed: true, available: true, issues: 0, output: out.trim() }
  } catch (e) {
    const err = e as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string }
    const output = String(err.stdout ?? err.stderr ?? err.message ?? "").trim()
    return {
      passed: false,
      available: !looksUnavailable(output),
      issues: countIssues(output),
      output,
    }
  }
}

// ── typecheck tool — exposes runTypeScriptNoEmit without shell confirmation ──

export const TYPECHECK_TOOL: ToolDef = {
  name: "typecheck",
  description: "Run TypeScript type-check (tsc --noEmit). Always available, no shell confirmation needed.",
  isReadonly: true,
  isConcurrencySafe: false,
  category: "safe",
  contract: {
    stateUpdates: ["evidence"],
    resultBudget: { maxChars: TYPECHECK_RESULT_MAX_CHARS, overflow: "clip" },
  },
  inputSchema: {
    type: "object",
    properties: {},
  },
  execute: async (): Promise<ToolResult> => {
    const result = runTypeScriptNoEmit()
    if (result.passed) return Result.ok("typecheck passed", { verification: { kind: "typecheck", command: "tsc --noEmit", passed: true, issues: 0 } })
    return Result.ok(`typecheck found ${result.issues} issue(s):\n${result.output.slice(0, TYPECHECK_RESULT_MAX_CHARS)}`, { verification: { kind: "typecheck", command: "tsc --noEmit", passed: false, issues: result.issues } })
  },
}
