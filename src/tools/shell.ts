/** Shell tool — execute commands with streaming progress. */

import { performance } from "node:perf_hooks"
import type { ToolDef, ToolExecutionContext, ToolResult } from "./registry"
import { Result, isNonInteractive } from "./registry"
import { buildVerificationResult } from "../verification/result"
import type { SandboxManager } from "../sandbox/sandbox"
import { recordRuntimeObservedWrites } from "../file-state"
import { createRuntimeContextKey, getRuntimeContextValue, setRuntimeContextValue } from "../runtime/execution-context"
import { executeProcess, type ProcessEvent, type ProcessRequest } from "../runtime/process-executor"
import { getExecutionGateway } from "../runtime/execution/execution-gateway"
import { currentExecutionAuthority } from "../runtime/execution/execution-context"
import type { ExecutionIntent } from "../runtime/execution/execution-intent"

const SHELL_RESULT_MAX_CHARS = 8000

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt))
}

/** LR2-0D：shell 执行路由 —— 存在受信权威时经 ExecutionGateway（统一
 *  入口 → Broker → Receipt），否则保留旧路径（Windows/测试/legacy）。 */
function executeShellRequest(request: ProcessRequest, capabilityId: string): AsyncGenerator<ProcessEvent> {
  const authority = currentExecutionAuthority()
  if (authority) {
    const intent: ExecutionIntent = {
      requestId: `sh-${capabilityId}-${Date.now().toString(36)}`,
      tool: {
        capabilityId,
        executable: request.command,
        args: request.args,
        cwdRef: request.cwd,
      },
      workload: { kind: "build", readonly: false },
      timeoutMs: request.timeoutMs,
      env: request.env,
      abortSignal: request.abortSignal,
    }
    return getExecutionGateway().execute(intent, {
      approvedCapabilityId: capabilityId,
      sideEffectClass: "write",
      authority,
    })
  }
  return executeProcess(request)
}

export function parseTimeoutSec(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// ── Sandbox injection (set by loop.ts at startup) ──

const SHELL_SANDBOX = createRuntimeContextKey<SandboxManager | null>(
  "shell-sandbox",
  () => null,
)

/** @deprecated Compatibility adapter; prefer the Sandbox owned by AgentRunScope. */
export function setShellSandbox(sandbox: SandboxManager | null) {
  setRuntimeContextValue(SHELL_SANDBOX, sandbox)
}

/** @deprecated Compatibility projection; prefer the Sandbox owned by AgentRunScope. */
export function getShellSandbox(): SandboxManager | null {
  return getRuntimeContextValue(SHELL_SANDBOX)
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

async function shell(
  params: Record<string, unknown>,
  onProgress?: (chunk: string) => void,
  context?: ToolExecutionContext,
): Promise<ToolResult> {
  const command = String(params.command ?? "")
  const timeoutSec = parseTimeoutSec(params.timeout, 120)

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
  if (context?.abortSignal?.aborted) return Result.fail("Command aborted before start")

  const sandbox = getShellSandbox()
  const verdict = sandbox?.check(command) ?? { allowed: true }
  if (!verdict.allowed) {
    return Result.blocked(verdict.reason ?? "沙箱阻止")
  }
  const sandboxed = sandbox?.needsSandbox(command) ?? false
  const effectiveTimeout = sandboxed
    ? verdict.timeoutOverride ?? Math.min(timeoutSec, Number(process.env.ORCANA_SANDBOX_TIMEOUT_SEC) || 30)
    : timeoutSec
  sandbox?.snapshotWorkspace()

  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  let timedOut = false
  let aborted = false
  let exitCode: number | null = null
  const startedAt = performance.now()
  for await (const event of executeShellRequest({
    command: shellExecutable(),
    args: shellArgs(command),
    env: sandboxed && verdict.injectedEnv ? (verdict.injectedEnv as Record<string, string>) : undefined,
    timeoutMs: effectiveTimeout * 1000,
    abortSignal: context?.abortSignal,
  }, "run_shell_script")) {
    switch (event.type) {
      case "stdout":
        stdoutChunks.push(event.data)
        onProgress?.(event.data)
        break
      case "stderr":
        stderrChunks.push(event.data)
        onProgress?.(event.data)
        break
      case "exit":
        exitCode = event.exitCode
        timedOut = event.signal === "timeout"
        aborted = event.signal === "aborted"
        break
    }
  }

  const sandboxReport = observeWorkspaceWrites(sandbox)
  if (aborted) {
    return Result.fail(`Command aborted${sandboxReport}`)
  }
  if (timedOut) {
    return shellResult({
      command,
      success: false,
      error: `Command timed out after ${effectiveTimeout}s${sandboxed ? " (sandbox)" : ""}`,
      content: `Command timed out after ${effectiveTimeout}s${sandboxed ? " (sandbox)" : ""}${sandboxReport}`,
      durationMs: elapsedMs(startedAt),
    })
  }
  let output = stdoutChunks.join("").trim() || "(empty output)"
  if (stderrChunks.length) output += `\n[stderr]\n${stderrChunks.join("").trim()}`
  if (sandboxReport) output += sandboxReport
  const code = exitCode ?? 0
  if (code !== 0) {
    return shellResult({
      command,
      success: false,
      error: `Command exited with code ${code}`,
      content: output.slice(0, 8000),
      exitCode: code,
      durationMs: elapsedMs(startedAt),
    })
  }
  return shellResult({
    command,
    success: true,
    content: output.slice(0, 8000),
    exitCode: code,
    durationMs: elapsedMs(startedAt),
  })
}

export async function* shellStream(
  params: Record<string, unknown>,
  context?: ToolExecutionContext,
): AsyncGenerator<{ type: "progress"; data: string } | { type: "done"; data: ToolResult }> {
  const command = String(params.command ?? "")
  const timeoutSec = parseTimeoutSec(params.timeout, 120)

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
  if (context?.abortSignal?.aborted) {
    yield { type: "done", data: Result.fail("Command aborted before start") }
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
    ? (verdict.injectedEnv as Record<string, string>)
    : undefined
  sandbox?.snapshotWorkspace()

  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  let timedOut = false
  let aborted = false
  let spawnError = ""
  let exitCode: number | null = null
  const startedAt = performance.now()
  for await (const event of executeShellRequest({
    command: shellExecutable(),
    args: shellArgs(command),
    env: childEnv,
    timeoutMs: timeoutSec * 1000,
    abortSignal: context?.abortSignal,
  }, "run_shell_script")) {
    if (event.type === "exit" && event.signal === "error") spawnError = "failed to spawn"

    switch (event.type) {
      case "stdout":
        stdoutChunks.push(event.data)
        yield { type: "progress", data: event.data }
        break
      case "stderr":
        stderrChunks.push(event.data)
        yield { type: "progress", data: `\n[stderr]\n${event.data}` }
        break
      case "exit":
        exitCode = event.exitCode
        timedOut = event.signal === "timeout"
        aborted = event.signal === "aborted"
        break
    }
  }

  if (aborted) {
    const sandboxReport = observeWorkspaceWrites(sandbox)
    yield { type: "done", data: Result.fail(`Command aborted${sandboxReport}`) }
    return
  }

  if (timedOut) {
    const sandboxReport = observeWorkspaceWrites(sandbox)
    yield { type: "done", data: shellResult({
      command,
      success: false,
      error: `Command timed out after ${timeoutSec}s`,
      content: `Command timed out after ${timeoutSec}s${sandboxReport}`,
      durationMs: elapsedMs(startedAt),
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
  const truncated = output.length > SHELL_RESULT_MAX_CHARS
  const display = truncated
    ? output.slice(0, SHELL_RESULT_MAX_CHARS) + `\n\n… [shell 输出被截断：${output.length} 字符，仅显示前 ${SHELL_RESULT_MAX_CHARS}。用 timeout 参数缩短命令输出，或用 findstr/grep 过滤。]`
    : output

  const code = exitCode ?? 0
  if (code !== 0) {
    yield { type: "done", data: shellResult({
      command,
      success: false,
      error: `Command exited with code ${code}`,
      content: display,
      exitCode: code,
      durationMs: elapsedMs(startedAt),
      truncated: truncated ? output.length : undefined,
    }) }
    return
  }
  yield { type: "done", data: shellResult({
    command,
    success: true,
    content: display,
    exitCode: code,
    durationMs: elapsedMs(startedAt),
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

/** shell:true 的等价显式调用（POSIX sh -c；Windows cmd /c）。 */
function shellExecutable(): string {
  return process.platform === "win32" ? "cmd.exe" : "/bin/sh"
}

function shellArgs(command: string): string[] {
  return process.platform === "win32" ? ["/c", command] : ["-c", command]
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
  // RC-16 G4：durationMs 始终暴露在顶层 metadata（verification 只对验证类
  // 命令生成——非验证命令的执行时长也必须可观测）。
  metadata.durationMs = input.durationMs
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
  contract: {
    provenance: "local",
    sideEffects: ["shell", "external_process", "workspace_write"],
    stateUpdates: ["file_state", "evidence"],
    resultBudget: { maxChars: SHELL_RESULT_MAX_CHARS, overflow: "clip" },
    cooperativeCancellation: true,
  },
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
