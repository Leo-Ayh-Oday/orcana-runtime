/** Shell tool — execute commands with streaming progress. */

import { spawn } from "node:child_process"
import type { ToolDef, ToolResult } from "./registry"
import { Result, isNonInteractive } from "./registry"
import { buildVerificationResult } from "../verification/result"
import type { SandboxManager } from "../sandbox/sandbox"
import { recordRuntimeObservedWrites } from "../file-state"
import { getRuntimeContextValue, setRuntimeContextValue } from "../runtime/execution-context"

// ── Sandbox injection (set by loop.ts at startup) ──

const SHELL_SANDBOX = Symbol("shell-sandbox")

export function setShellSandbox(sandbox: SandboxManager | null) {
  setRuntimeContextValue(SHELL_SANDBOX, sandbox)
}

export function getShellSandbox(): SandboxManager | null {
  return getRuntimeContextValue<SandboxManager | null>(SHELL_SANDBOX, null)
}

const BLOCKLIST = new Set([
  "format", "diskpart", "fdisk", "mkfs", "shutdown", "reboot", "bcdedit", "reg", "regedit",
  "del", "rmdir", "rd", "mount", "umount", "netsh", "takeown", "chmod", "cipher",
])
const DANGEROUS_SUBCOMMANDS = [
  /\brm\s+-rf?\b/i, /\bdel\s+\/[fsq]/i, /\bformat\b/i,
  /\bshutdown\b/i, /\breboot\b/i, /\bcipher\s+\/w/i,
  /\bicacls\s+\/deny/i, /\btakeown\s+\/f/i,
  /\bRemove-Item\s+-/i, /\bgoto\s+\/f/i,
]

function longRunningCommandReason(command: string): string {
  const normalized = command.replace(/\\/g, "/").replace(/\s+/g, " ").trim().toLowerCase()
  if (!normalized) return ""
  if (/\b(?:bun|npm|pnpm|yarn)\s+run\s+(?:dev|start|serve|preview)(?:\b|:)/.test(normalized)) {
    return "检测到 dev/start/serve/preview 常驻服务命令"
  }
  if (/\b(?:vite|next|nuxt|astro)\s+(?:dev|preview)\b/.test(normalized)) {
    return "检测到前端开发服务器命令"
  }
  if (/\b--watch\b/.test(normalized)) {
    return "检测到 watch 常驻监听命令"
  }
  if (/\b(?:bun|node|tsx|ts-node)\s+(?:run\s+)?(?:server|src\/server|app|src\/app)\/index\.(?:ts|js)\b/.test(normalized)) {
    return "检测到直接启动后端服务入口"
  }
  return ""
}

async function shell(params: Record<string, unknown>, onProgress?: (chunk: string) => void): Promise<ToolResult> {
  const command = String(params.command ?? "")
  const timeoutSec = Number(params.timeout ?? 120)

  if (!command.trim()) return Result.fail("Empty command")

  const baseCmd = command.trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  if (BLOCKLIST.has(baseCmd)) {
    return Result.fail(`Command '${baseCmd}' is blocked`)
  }
  // Check full command for dangerous subcommand patterns (cmd /c del *, etc.)
  for (const pattern of DANGEROUS_SUBCOMMANDS) {
    if (pattern.test(command)) {
      return Result.fail(`Command contains dangerous pattern: ${pattern.source.slice(1, 40)}`)
    }
  }
  const longRunningReason = longRunningCommandReason(command)
  if (longRunningReason) {
    return Result.blocked(`${longRunningReason}，为避免任务卡住已阻止执行。请改用可结束的验证命令，例如 bun test、bun run check、bun run build 或 tsc --noEmit。如果测试需要服务，请修改测试让它在测试进程内启动并关闭服务。`)
  }

  const sandbox = getShellSandbox()
  const verdict = sandbox?.check(command) ?? { allowed: true }
  if (!verdict.allowed) {
    return Result.blocked(verdict.reason ?? "沙箱阻止")
  }
  const sandboxed = sandbox?.needsSandbox(command) ?? false
  const effectiveTimeout = sandboxed
    ? verdict.timeoutOverride ?? Math.min(timeoutSec, Number(process.env.DEEPSEEK_SANDBOX_TIMEOUT_SEC) || 30)
    : timeoutSec
  sandbox?.snapshotWorkspace()

  return new Promise(resolve => {
    const startedAt = Date.now()
    const childEnv = sandboxed && verdict.injectedEnv
      ? verdict.injectedEnv
      : process.env
    const proc = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"] as const,
      windowsHide: sandboxed,
      env: childEnv as Record<string, string | undefined>,
    })
    if (sandboxed && proc.pid && sandbox) sandbox.track(proc.pid)
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill("SIGTERM")
      setTimeout(() => proc.kill("SIGKILL"), 2000)
    }, effectiveTimeout * 1000)

    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString()
      stdoutChunks.push(text)
      onProgress?.(text)
    })

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString()
      stderrChunks.push(text)
      onProgress?.(text)
    })

    proc.on("error", (err) => {
      clearTimeout(timer)
      resolve(Result.fail(`Failed to spawn: ${err.message}`))
    })

    proc.on("close", (code) => {
      clearTimeout(timer)
      const sandboxReport = observeWorkspaceWrites(sandbox)
      if (timedOut) {
        resolve(shellResult({
          command,
          success: false,
          error: `Command timed out after ${effectiveTimeout}s${sandboxed ? " (sandbox)" : ""}`,
          content: `Command timed out after ${effectiveTimeout}s${sandboxed ? " (sandbox)" : ""}${sandboxReport}`,
          durationMs: Date.now() - startedAt,
        }))
        return
      }
      let output = stdoutChunks.join("").trim() || "(empty output)"
      if (stderrChunks.length) output += `\n[stderr]\n${stderrChunks.join("").trim()}`
      if (sandboxReport) output += sandboxReport
      const exitCode = code ?? 0
      if (exitCode !== 0) {
        resolve(shellResult({
          command,
          success: false,
          error: `Command exited with code ${exitCode}`,
          content: output.slice(0, 8000),
          exitCode,
          durationMs: Date.now() - startedAt,
        }))
        return
      }
      resolve(shellResult({
        command,
        success: true,
        content: output.slice(0, 8000),
        exitCode,
        durationMs: Date.now() - startedAt,
      }))
    })
  })
}

export async function* shellStream(params: Record<string, unknown>): AsyncGenerator<{ type: "progress"; data: string } | { type: "done"; data: ToolResult }> {
  const command = String(params.command ?? "")
  const timeoutSec = Number(params.timeout ?? 120)

  // Non-interactive mode: caller already signalled intent via prompt arg. Skip confirm.
  if (params.confirm !== true && !isNonInteractive()) {
    yield { type: "done", data: Result.blocked("Shell requires confirmation — set confirm: true") }
    return
  }

  if (!command.trim()) {
    yield { type: "done", data: Result.fail("Empty command") }
    return
  }

  const baseCmd = command.trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  if (BLOCKLIST.has(baseCmd)) {
    yield { type: "done", data: Result.fail(`Command '${baseCmd}' is blocked`) }
    return
  }
  const longRunningReason = longRunningCommandReason(command)
  if (longRunningReason) {
    yield { type: "done", data: Result.blocked(`${longRunningReason}，为避免任务卡住已阻止执行。请改用可结束的验证命令，例如 bun test、bun run check、bun run build 或 tsc --noEmit。如果测试需要服务，请修改测试让它在测试进程内启动并关闭服务。`) }
    return
  }

  const sandbox = getShellSandbox()
  const verdict = sandbox?.check(command) ?? { allowed: true }
  if (!verdict.allowed) {
    yield { type: "done", data: Result.blocked(verdict.reason ?? "沙箱阻止") }
    return
  }
  const sandboxed = sandbox?.needsSandbox(command) ?? false
  const childEnv = sandboxed && verdict.injectedEnv
    ? verdict.injectedEnv
    : process.env
  sandbox?.snapshotWorkspace()

  const proc = spawn(command, {
    shell: true,
    stdio: ["ignore", "pipe", "pipe"] as const,
    windowsHide: sandboxed,
    env: childEnv as Record<string, string | undefined>,
  })
  if (sandboxed && proc.pid && sandbox) sandbox.track(proc.pid)
  const startedAt = Date.now()
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  let timedOut = false
  let finished = false
  let spawnError = ""

  const timer = setTimeout(() => {
    timedOut = true
    proc.kill("SIGTERM")
    setTimeout(() => {
      if (!finished) proc.kill("SIGKILL")
    }, 2000).unref?.()
  }, timeoutSec * 1000)

  const closed = new Promise<void>((resolve) => {
    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString()
      stdoutChunks.push(text)
    })

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString()
      stderrChunks.push(text)
    })

    proc.on("error", (err) => {
      spawnError = err.message
      finished = true
      clearTimeout(timer)
      resolve()
    })
    proc.on("close", () => {
      finished = true
      clearTimeout(timer)
      resolve()
    })
  })

  // Yield progress chunks while process is running
  let lastStdoutLen = 0
  let lastStderrLen = 0
  while (!finished && !timedOut) {
    await Promise.race([closed, new Promise(r => setTimeout(r, 100))])

    const newStdout = stdoutChunks.slice(lastStdoutLen)
    const newStderr = stderrChunks.slice(lastStderrLen)
    lastStdoutLen = stdoutChunks.length
    lastStderrLen = stderrChunks.length

    const combined = [...newStdout, ...(newStderr.length ? ["\n[stderr]"] : []), ...newStderr].join("")
    if (combined) yield { type: "progress", data: combined }
  }

  if (timedOut) {
    const sandboxReport = observeWorkspaceWrites(sandbox)
    yield { type: "done", data: shellResult({
      command,
      success: false,
      error: `Command timed out after ${timeoutSec}s`,
      content: `Command timed out after ${timeoutSec}s${sandboxReport}`,
      durationMs: Date.now() - startedAt,
    }) }
    return
  }

  if (spawnError) {
    yield { type: "done", data: Result.fail(`Failed to spawn: ${spawnError}`) }
    return
  }

  let output = stdoutChunks.join("").trim() || "(empty output)"
  if (stderrChunks.length) output += `\n[stderr]\n${stderrChunks.join("").trim()}`
  output += observeWorkspaceWrites(sandbox)
  const MAX_SHELL_OUTPUT = 8000
  const truncated = output.length > MAX_SHELL_OUTPUT
  const display = truncated
    ? output.slice(0, MAX_SHELL_OUTPUT) + `\n\n… [shell 输出被截断：${output.length} 字符，仅显示前 ${MAX_SHELL_OUTPUT}。用 timeout 参数缩短命令输出，或用 findstr/grep 过滤。]`
    : output

  const exitCode = proc.exitCode ?? 0
  if (exitCode !== 0) {
    yield { type: "done", data: shellResult({
      command,
      success: false,
      error: `Command exited with code ${exitCode}`,
      content: display,
      exitCode,
      durationMs: Date.now() - startedAt,
      truncated: truncated ? output.length : undefined,
    }) }
    return
  }
  yield { type: "done", data: shellResult({
    command,
    success: true,
    content: display,
    exitCode,
    durationMs: Date.now() - startedAt,
    truncated: truncated ? output.length : undefined,
  }) }
}

function observeWorkspaceWrites(sandbox: SandboxManager | null): string {
  if (!sandbox) return ""
  const report = sandbox.diff()
  if (report.violations.length === 0) return ""
  recordRuntimeObservedWrites(report.violations.map(change => change.path))
  return `\n\n[沙箱文件守护]\n${report.violations.map(change => `  ${change.kind}: ${change.path}`).join("\n")}`
}

function shellResult(input: {
  command: string
  success: boolean
  content: string
  durationMs: number
  error?: string
  exitCode?: number
  truncated?: number
}): ToolResult {
  const metadata: Record<string, unknown> = {}
  if (input.exitCode !== undefined) metadata.exitCode = input.exitCode
  if (input.truncated !== undefined) metadata.truncated = input.truncated
  const verification = buildVerificationResult({
    command: input.command,
    passed: input.success,
    exitCode: input.exitCode,
    durationMs: input.durationMs,
    output: input.content,
  })
  if (verification) metadata.verification = verification
  if (input.success) return Result.ok(input.content, metadata)
  return { success: false, content: input.content, error: input.error ?? input.content, metadata }
}

export const SHELL_TOOL: ToolDef = {
  name: "shell",
  description: "Execute a shell command. Pass timeout in seconds. Long-running commands stream progress.",
  isReadonly: false,
  category: "shell" as const,
  requiresConfirmation: true,
  userFacingName: "Shell",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: { type: "integer", description: "Timeout in seconds (default 120)" },
    },
    required: ["command"],
  },
  execute: shell,

  executeStream: shellStream,
}
