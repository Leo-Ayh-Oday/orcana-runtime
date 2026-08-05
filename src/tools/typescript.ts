import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { ToolDef, ToolResult } from "./registry"
import { Result } from "./registry"
import { collectProcessRun } from "../runtime/process-executor"

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
    if (existsSync(local)) return local
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

export async function runTypeScriptNoEmit(cwd = process.cwd()): Promise<TypeScriptCheckResult> {
  const command = getTscCommand(cwd)
  try {
    const r = await collectProcessRun({ command, args: ["--noEmit", "--pretty", "false"], cwd, timeoutMs: 15000 })
    return { passed: true, available: true, issues: 0, output: r.stdout.trim() }
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error)
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
    provenance: "local",
    stateUpdates: ["evidence"],
    resultBudget: { maxChars: TYPECHECK_RESULT_MAX_CHARS, overflow: "clip" },
  },
  inputSchema: {
    type: "object",
    properties: {},
  },
  execute: async (): Promise<ToolResult> => {
    const startedAt = Date.now()
    const result = await runTypeScriptNoEmit()
    const verification = {
      kind: "typecheck" as const,
      command: "tsc --noEmit",
      passed: result.passed,
      issues: result.issues,
      durationMs: Date.now() - startedAt,
      summary: result.output.slice(0, 1000) || (result.passed ? "typecheck passed" : "typecheck failed"),
    }
    if (result.passed) return Result.ok("typecheck passed", { verification })
    return Result.ok(`typecheck found ${result.issues} issue(s):\n${result.output.slice(0, TYPECHECK_RESULT_MAX_CHARS)}`, { verification })
  },
}
