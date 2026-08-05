/** R1: 跨平台统一进程执行入口（Linux Production Integration Closure）。
 *
 *  Linux → LinuxExecutionBroker（enabled 模式）→ Backend → Receipt。
 *  Windows → 保留 legacy spawn（Job Object 后端待后续）。
 *  src/ 中任何工具不得再直接使用 node:child_process —— 静态 AST 门禁强制。
 *
 *  环境语义（P1-7 修复）：请求的环境只作为 requestedValues 进入
 *  buildExplicitEnvironment；allowedHostKeys 是唯一宿主键显式批准通道；
 *  Backend 不再 `...spec.environment.variables` 合并 —— 最终环境唯一来源
 *  是 Environment Compiler 输出。
 */

import { spawn } from "node:child_process"
import type { LinuxExecutionBroker } from "./linux/broker"
import { createLinuxBroker } from "./linux/broker"
import { selectBackend } from "./linux/backend-router"
import type { ExecutionProfile, NetworkMode } from "./linux/contracts"
import type { ExecutionCellSpec } from "./linux/contracts"

export type ProcessEvent =
  | { type: "status"; state: string; at: number }
  | { type: "stdout"; data: string; at: number }
  | { type: "stderr"; data: string; at: number }
  | { type: "exit"; exitCode: number | null; signal: string | null; at: number }

export interface ProcessRequest {
  command: string
  args: string[]
  cwd?: string
  /** 显式声明的环境变量（进入 requestedValues，受拒绝规则约束）。 */
  env?: Record<string, string>
  /** 显式批准的宿主环境键（唯一宿主继承通道；拒绝集内的键会被拒）。 */
  allowedHostKeys?: string[]
  timeoutMs?: number
  abortSignal?: AbortSignal
  profile?: ExecutionProfile
  network?: NetworkMode
  stdoutMaxBytes?: number
  stderrMaxBytes?: number
}

export interface ProcessOutcome {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  aborted: boolean
}

/** 审计级（Host Audit）允许从宿主复制的安全变量 —— 仅限低风险键。
 *  密钥类键（后缀 _API_KEY / _TOKEN / AWS_* / GITHUB_TOKEN 等）在任何层级都拒绝。 */
export const AUDIT_HOST_ALLOW_KEYS = [
  "ORCANA_*", "USER", "LOGNAME", "TMPDIR", "LANG", "LANGUAGE", "LC_ALL",
  "LC_CTYPE", "TERM", "CI", "BUN_*", "NPM_CONFIG_*", "YARN_*", "PNPM_*",
  "NODE_OPTIONS", "EDITOR", "VISUAL", "HOME", "PATH",
]

const DEFAULT_STDOUT_MAX = 4 * 1024 * 1024
const DEFAULT_STDERR_MAX = 4 * 1024 * 1024

function cellSpecFromRequest(request: ProcessRequest, allowedHostKeys: string[]): ExecutionCellSpec {
  const timeoutMs = request.timeoutMs ?? 120_000
  return {
    schemaVersion: "1.0",
    identity: { cellId: `tool-${Date.now().toString(36)}`, runId: "tool-run", nodeRunId: "tool:n", attempt: 1 },
    command: { executable: request.command, args: request.args, cwd: request.cwd ?? process.cwd(), stdin: "closed" },
    profile: request.profile ?? "build",
    // 工具执行语义：首选 Bubblewrap（有则真沙盒），无则降级 Host Audit。
    // 显式指定 preferredBackend 避免 profile 默认（如 dependency→podman）误锁。
    isolation: { minimum: "audit", preferredBackend: "bubblewrap", allowDegradation: true },
    filesystem: { readonlyMounts: [], writableMounts: [], tmpfsMounts: [], hiddenPaths: [], emptyHome: true },
    network: { mode: request.network ?? "none" },
    environment: { variables: request.env ?? {}, allowedHostKeys, inheritHost: false, locale: "C.UTF-8", pathEntries: ["/usr/local/bin"] },
    secrets: [],
    resources: {
      memoryMaxBytes: 512 * 1024 * 1024,
      pidsMax: 512,
      wallTimeMs: timeoutMs,
      stdoutMaxBytes: request.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX,
      stderrMaxBytes: request.stderrMaxBytes ?? DEFAULT_STDERR_MAX,
      tmpfsMaxBytes: 1024 * 1024 * 1024,
    },
    cache: [],
    lifecycle: { killOnParentExit: true, cleanupOnExit: true, retainOnFailure: false, serviceMode: false },
    policyDigest: "",
  }
}

// ── Windows legacy 后端（Job Object 改造前） ──

async function* runWindowsLegacy(request: ProcessRequest): AsyncGenerator<ProcessEvent> {
  if (request.abortSignal?.aborted) {
    yield { type: "exit", exitCode: null, signal: "aborted", at: Date.now() }
    return
  }
  const { command, args } = request
  const timeoutMs = request.timeoutMs ?? 120_000
  const startedAt = Date.now()
  const proc = spawn(command, args, {
    cwd: request.cwd,
    env: request.env ? { ...process.env, ...request.env } : process.env,
    stdio: ["ignore", "pipe", "pipe"] as const,
    detached: true,
    windowsHide: true,
  })
  yield { type: "status", state: "running", at: Date.now() }

  const queue: ProcessEvent[] = []
  proc.stdout?.on("data", (chunk: Buffer) => {
    queue.push({ type: "stdout", data: chunk.toString("utf-8"), at: Date.now() })
  })
  proc.stderr?.on("data", (chunk: Buffer) => {
    queue.push({ type: "stderr", data: chunk.toString("utf-8"), at: Date.now() })
  })

  let settled = false
  let timedOut = false
  let aborted = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const closed = new Promise<void>((resolve) => {
    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      request.abortSignal?.removeEventListener("abort", onAbort)
      resolve()
    }
    const onAbort = () => {
      aborted = true
      terminateWindowsTree(proc)
      queue.push({ type: "exit", exitCode: null, signal: "aborted", at: Date.now() })
      finish()
    }
    request.abortSignal?.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(() => {
      timedOut = true
      terminateWindowsTree(proc)
    }, timeoutMs)
    proc.on("error", () => {
      queue.push({ type: "exit", exitCode: null, signal: "error", at: Date.now() })
      finish()
    })
    proc.on("close", (code, signal) => {
      queue.push({ type: "exit", exitCode: code ?? null, signal: signal ?? null, at: Date.now() })
      finish()
    })
  })

  while (!settled || queue.length > 0) {
    if (queue.length > 0) {
      yield queue.shift()!
      continue
    }
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 20))])
  }
  void startedAt
  void timedOut
  void aborted
}

function terminateWindowsTree(proc: { pid?: number }): void {
  if (!proc.pid) return
  try {
    const killer = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    killer.unref()
  } catch {
    // best effort
  }
}

// ── 统一执行入口 ──

let linuxBroker: LinuxExecutionBroker | null = null

function broker(): LinuxExecutionBroker {
  if (!linuxBroker) linuxBroker = createLinuxBroker({ mode: "enabled" })
  return linuxBroker
}

export async function* executeProcess(request: ProcessRequest): AsyncGenerator<ProcessEvent> {
  if (request.abortSignal?.aborted) {
    yield { type: "exit", exitCode: null, signal: "aborted", at: Date.now() }
    return
  }
  if (process.platform !== "linux") {
    yield* runWindowsLegacy(request)
    return
  }

  // 审计级默认：允许安全宿主键；命名空间级后端（bwrap/podman）不继承宿主环境。
  const spec = cellSpecFromRequest(request, AUDIT_HOST_ALLOW_KEYS)
  let backendId: string
  try {
    backendId = selectBackend(spec, broker().probe()).backend
  } catch {
    backendId = "host-audit"
  }
  const effectiveSpec = backendId === "host-audit"
    ? spec
    : cellSpecFromRequest(request, [])

  yield* fromBrokerEvents(broker().execute(effectiveSpec, request.abortSignal ? { abortSignal: request.abortSignal } : undefined))
}

/** Broker 的 ExecutionCellEvent → 平台无关 ProcessEvent。 */
export async function* fromBrokerEvents(events: AsyncIterable<{
  type: string
  cellId?: string
  state?: string
  data?: string
  exitCode?: number | null
  signal?: string | null
  at: number
}>): AsyncGenerator<ProcessEvent> {
  for await (const event of events) {
    switch (event.type) {
      case "cell.status":
        yield { type: "status", state: event.state ?? "running", at: event.at }
        break
      case "cell.stdout":
        yield { type: "stdout", data: event.data ?? "", at: event.at }
        break
      case "cell.stderr":
        yield { type: "stderr", data: event.data ?? "", at: event.at }
        break
      case "cell.exit":
        yield { type: "exit", exitCode: event.exitCode ?? null, signal: event.signal ?? null, at: event.at }
        break
      default:
        break
    }
  }
}

/** 收集全部事件为一个结果（run_process/run_shell_script 等批量工具用）。 */
export async function collectProcessRun(request: ProcessRequest): Promise<ProcessOutcome> {
  const startedAt = Date.now()
  let exitCode: number | null = null
  let signal: string | null = null
  let timedOut = false
  let aborted = false
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  for await (const event of executeProcess(request)) {
    switch (event.type) {
      case "stdout": stdoutChunks.push(event.data); break
      case "stderr": stderrChunks.push(event.data); break
      case "exit":
        exitCode = event.exitCode
        signal = event.signal
        timedOut = event.signal === "timeout"
        aborted = event.signal === "aborted"
        break
    }
  }
  return {
    exitCode,
    signal,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    durationMs: Date.now() - startedAt,
    timedOut,
    aborted,
  }
}
