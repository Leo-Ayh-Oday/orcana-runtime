import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { ToolDef, ToolResult } from "./registry"
import { Result } from "./registry"
import { collectProcessRun } from "../runtime/process-executor"

const TYPECHECK_RESULT_MAX_CHARS = 2000

// ── VerificationStatus 契约（RC-01）──
// 六态取代 boolean passed：passed/failed/unavailable/error/timed_out/cancelled。
// 唯一进入"通过证据"的条件：isPassingEvidence() 成立。

export type VerificationStatus =
  | "passed"
  | "failed"
  | "unavailable"
  | "error"
  | "timed_out"
  | "cancelled"

export interface TypeScriptCheckResult {
  /** 权威状态。passed 之外均不构成通过证据。 */
  status: VerificationStatus
  /** 派生视图（兼容旧调用方）：status === "passed"。 */
  passed: boolean
  /** 派生视图：验证器真实存在且可运行（unavailable 之外）。 */
  available: boolean
  issues: number
  output: string
  exitCode: number | null
  signal: string | null
}

export function isPassingEvidence(
  r: Pick<TypeScriptCheckResult, "status" | "available" | "exitCode">,
): boolean {
  return r.status === "passed" && r.available && r.exitCode === 0
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
  return /not recognized|command not found|not found|no such file|enoent|failed to spawn|spawn .* enoent/i.test(output)
}

function countIssues(output: string): number {
  const matches = output.match(/\berror TS\d+/g)
  return matches?.length ?? (output.trim() ? 1 : 0)
}

export async function runTypeScriptNoEmit(cwd = process.cwd()): Promise<TypeScriptCheckResult> {
  const command = getTscCommand(cwd)
  try {
    const r = await collectProcessRun({ command, args: ["--noEmit", "--pretty", "false"], cwd, timeoutMs: 15000 })
    if (r.timedOut) {
      return {
        status: "timed_out",
        passed: false,
        available: true,
        issues: 0,
        output: (r.stdout + "\n" + r.stderr).trim() || "tsc timed out",
        exitCode: r.exitCode,
        signal: r.signal,
      }
    }
    if (r.aborted) {
      return {
        status: "cancelled",
        passed: false,
        available: true,
        issues: 0,
        output: (r.stdout + "\n" + r.stderr).trim() || "tsc cancelled",
        exitCode: r.exitCode,
        signal: r.signal,
      }
    }
    // spawn 失败：supervisor 以 exitCode=null + signal="error" 结束，不抛异常。
    if (r.exitCode === null && r.signal === "error") {
      return {
        status: "unavailable",
        passed: false,
        available: false,
        issues: 0,
        output: `failed to spawn ${command}`,
        exitCode: null,
        signal: "error",
      }
    }
    if (r.exitCode === 0) {
      // tsc 以 0 退出：通过。stderr 有内容不改变通过判定（只随 output 透出）。
      return { status: "passed", passed: true, available: true, issues: 0, output: (r.stdout + "\n" + r.stderr).trim(), exitCode: 0, signal: r.signal }
    }
    // 非零退出（tsc --noEmit 报类型错误时 exit 1/2）：失败，绝不等于通过。
    const combined = (r.stdout + "\n" + r.stderr).trim()
    return {
      status: "failed",
      passed: false,
      available: true,
      issues: countIssues(combined),
      output: combined,
      exitCode: r.exitCode,
      signal: r.signal,
    }
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error)
    return {
      status: looksUnavailable(output) ? "unavailable" : "error",
      passed: false,
      available: !looksUnavailable(output),
      issues: 0,
      output,
      exitCode: null,
      signal: null,
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
      status: result.status,
      passed: result.passed,
      issues: result.issues,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      summary: result.output.slice(0, 1000) || `typecheck ${result.status}`,
    }
    // 工具执行成功 ≠ 验证通过：状态在 verification.status，工具层永远 ok。
    if (result.passed) return Result.ok("typecheck passed", { verification })
    return Result.ok(`typecheck ${result.status} (${result.issues} issue(s)):\n${result.output.slice(0, TYPECHECK_RESULT_MAX_CHARS)}`, { verification })
  },
}
