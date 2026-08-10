/** Tool Runtime 2.0 (RT-7): parameterized process execution.
 *
 *  run_process       — spawn(executable, args, { shell: false }): no command
 *                      strings, no string concatenation, args as arrays.
 *  run_shell_script  — explicit shell type (bash/sh/cmd/powershell) via the
 *                      shell executable + args, never shell:true.
 *
 *  R1: 进程执行统一走 ProcessExecutor（Linux → Broker/Backend；Windows →
 *  legacy）。环境由 Environment Compiler 构造，禁止宿主环境继承（密钥类
 *  键任何层级都拒绝）。Legacy shell 保留在 src/tools/shell.ts（待迁移）。
 */

import { spawn } from "node:child_process"
import type { ToolDef, ToolResult } from "./registry"
import { Result } from "./registry"
import { collectProcessRun } from "../runtime/process-executor"
import { getExecutionGateway } from "../runtime/execution/execution-gateway"
import type { ExecutionIntent } from "../runtime/execution/execution-intent"
import type { ExecutionResult } from "../runtime/execution/execution-result"
import { currentExecutionAuthority } from "../runtime/execution/execution-context"

export interface RunProcessParams {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  /** Detached = own process group → tree-kill on timeout/cancel. */
  detached?: boolean
  abortSignal?: AbortSignal
}

export interface RunProcessResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  aborted: boolean
}

/** Parameterized process execution — never shell:true.
 *
 *  LR2-0D：存在受信执行权威时经 ExecutionGateway（统一入口 → Broker →
 *  Receipt）；无权威（Windows/测试/legacy 环境）保留旧路径 —— 渐进迁移，
 *  shadow → enabled → enforced。 */
export function runProcess(params: RunProcessParams): Promise<RunProcessResult> {
  const authority = currentExecutionAuthority()
  if (authority) {
    const intent: ExecutionIntent = {
      requestId: `rp-${params.command}-${params.args[0] ?? ""}-${Date.now().toString(36)}`,
      tool: {
        capabilityId: "run_process",
        executable: params.command,
        args: params.args,
        cwdRef: params.cwd,
      },
      workload: { kind: "build", readonly: false },
      timeoutMs: params.timeoutMs ?? 120_000,
      env: params.env,
      abortSignal: params.abortSignal,
    }
    return getExecutionGateway()
      .collect(intent, { approvedCapabilityId: "run_process", sideEffectClass: "write", authority })
      .then(adaptResult)
  }
  return collectProcessRun({
    command: params.command,
    args: params.args,
    cwd: params.cwd,
    env: params.env,
    timeoutMs: params.timeoutMs ?? 120_000,
    abortSignal: params.abortSignal,
  })
}

function adaptResult(r: ExecutionResult): RunProcessResult {
  return {
    exitCode: r.exitCode,
    signal: r.signal,
    stdout: r.stdout,
    stderr: r.stderr,
    durationMs: r.durationMs,
    timedOut: r.timedOut,
    aborted: r.aborted,
  }
}

/** Kill the whole process tree (taskkill /T on Windows, SIGTERM→SIGKILL
 *  escalation on POSIX). Detached children form their own process group, so
 *  the negative pid kills every descendant — no orphans. */
export function terminateTree(proc: ReturnType<typeof spawn>): void {
  if (proc.pid && process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    killer.unref()
    return
  }
  const pid = proc.pid
  if (pid) {
    try { process.kill(-pid, "SIGTERM") } catch { /* group may be gone */ }
    try { proc.kill("SIGTERM") } catch { /* already exited */ }
  }
  setTimeout(() => {
    if (proc.exitCode === null && pid) {
      try { process.kill(-pid, "SIGKILL") } catch { /* group may be gone */ }
      try { proc.kill("SIGKILL") } catch { /* already exited */ }
    }
  }, 2000).unref?.()
}

function formatProcessResult(r: RunProcessResult, command: string): string {
  if (r.timedOut) return `Command timed out after ${r.durationMs}ms (process tree killed)`
  if (r.aborted) return "Command cancelled (process tree killed)"
  if (r.exitCode !== 0) return `Command failed with exit code ${r.exitCode}${r.signal ? ` (${r.signal})` : ""}`
  return `Command succeeded (exit 0) in ${r.durationMs}ms`
}

function parseTimeoutMs(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

// ── run_process ──

const RUN_PROCESS_SCHEMA = {
  type: "object",
  properties: {
    executable: { type: "string", description: "Executable path or command name" },
    args: { type: "array", items: { type: "string" }, description: "Arguments as an array — never a command string" },
    cwd: { type: "string" },
    env: { type: "object", description: "Extra environment variables" },
    timeoutMs: { type: "number" },
  },
  required: ["executable", "args"],
} as const

export const RUN_PROCESS_TOOL: ToolDef = {
  name: "run_process",
  description: "Execute an executable with a parameter array (shell:false — no command strings, no injection surface). Kills the process tree on timeout/cancel. Structured exitCode/signal output.",
  isReadonly: false,
  category: "shell",
  requiresConfirmation: true,
  inputSchema: RUN_PROCESS_SCHEMA as unknown as Record<string, unknown>,
  async execute(params) {
    const executable = String(params["executable"] ?? "")
    const args = Array.isArray(params["args"]) ? (params["args"] as unknown[]).map(String) : []
    const cwd = typeof params["cwd"] === "string" ? params["cwd"] : undefined
    const env = params["env"] as Record<string, string> | undefined
    const timeoutMs = parseTimeoutMs(params["timeoutMs"])
    if (!executable) return Result.fail("run_process requires executable")

    const result = await runProcess({ command: executable, args, cwd, env, timeoutMs })
    const content = [
      formatProcessResult(result, executable),
      "",
      result.stdout.trim() ? `stdout:\n${result.stdout.slice(0, 8000)}` : "",
      result.stderr.trim() ? `stderr:\n${result.stderr.slice(0, 2000)}` : "",
    ].filter(Boolean).join("\n")
    if (result.exitCode !== 0 || result.timedOut || result.aborted) {
      return Result.failWithMetadata(content, {
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
      })
    }
    return Result.ok(content, {
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
    })
  },
}

// ── run_shell_script ──

const SHELL_BY_TYPE: Record<string, { path: string; args: (script: string) => string[] }> = {
  bash: { path: "bash", args: (s) => ["-c", s] },
  sh: { path: "sh", args: (s) => ["-c", s] },
  zsh: { path: "zsh", args: (s) => ["-c", s] },
  cmd: { path: "cmd.exe", args: (s) => ["/c", s] },
  powershell: { path: "powershell.exe", args: (s) => ["-Command", s] },
}

/** Declarative side-effect plan for a script (best-effort static scan). */
export function scriptSideEffectPlan(script: string): string[] {
  const effects: string[] = []
  if (/(^|\s)(rm|mv|cp|dd|mkfs|>|>>)\b/.test(script)) effects.push("write")
  if (/(^|\s)(curl|wget|nc|ssh)\b/.test(script)) effects.push("network")
  if (/(^|\s)(sudo|chmod|chown)\b/.test(script)) effects.push("privilege")
  return effects.length > 0 ? effects : ["read"]
}

const RUN_SHELL_SCRIPT_SCHEMA = {
  type: "object",
  properties: {
    script: { type: "string", description: "Shell script text (pipes/redirects/composite commands only)" },
    shellType: { type: "string", enum: ["bash", "sh", "zsh", "cmd", "powershell"], description: "Explicit shell (default: bash on POSIX, cmd on Windows)" },
    cwd: { type: "string" },
    timeoutMs: { type: "number" },
  },
  required: ["script"],
} as const

export const RUN_SHELL_SCRIPT_TOOL: ToolDef = {
  name: "run_shell_script",
  description: "Run a script through an EXPLICIT shell (bash/sh/zsh/cmd/powershell) with an auto-generated side-effect plan. Higher risk than run_process — prefer run_process for simple commands.",
  isReadonly: false,
  category: "shell",
  requiresConfirmation: true,
  inputSchema: RUN_SHELL_SCRIPT_SCHEMA as unknown as Record<string, unknown>,
  async execute(params) {
    const script = String(params["script"] ?? "")
    if (!script) return Result.fail("run_shell_script requires script")
    const defaultType = process.platform === "win32" ? "cmd" : "bash"
    const shellType = typeof params["shellType"] === "string" && params["shellType"] in SHELL_BY_TYPE
      ? String(params["shellType"])
      : defaultType
    const shell = SHELL_BY_TYPE[shellType]!
    const sideEffects = scriptSideEffectPlan(script)

    const result = await runProcess({
      command: shell.path,
      args: shell.args(script),
      cwd: typeof params["cwd"] === "string" ? params["cwd"] : undefined,
      timeoutMs: parseTimeoutMs(params["timeoutMs"]),
    })
    const content = [
      formatProcessResult(result, script.slice(0, 60)),
      "",
      `sideEffectPlan: ${sideEffects.join(", ")}`,
      "",
      result.stdout.trim() ? `stdout:\n${result.stdout.slice(0, 8000)}` : "",
      result.stderr.trim() ? `stderr:\n${result.stderr.slice(0, 2000)}` : "",
    ].filter(Boolean).join("\n")
    const meta = {
      shellType,
      sideEffects,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    }
    if (result.exitCode !== 0 || result.timedOut || result.aborted) return Result.failWithMetadata(content, meta)
    return Result.ok(content, meta)
  },
}
