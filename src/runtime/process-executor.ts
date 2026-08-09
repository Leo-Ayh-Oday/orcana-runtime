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
import { isAbsolute, relative } from "node:path"
import type { LinuxExecutionBroker } from "./linux/broker"
import { createLinuxBroker } from "./linux/broker"
import type { ExecutionProfile, NetworkMode, SandboxReceipt, TrustedExecutionAuthority, UntrustedCapabilityRequest } from "./linux/contracts"
import { requireExecutionAuthority } from "./execution-context"

export type ProcessEvent =
  | { type: "status"; state: string; at: number }
  | { type: "stdout"; data: string; at: number }
  | { type: "stderr"; data: string; at: number }
  | { type: "exit"; exitCode: number | null; signal: string | null; at: number }
  | { type: "receipt"; receipt: SandboxReceipt; at: number }

export interface ProcessRequest {
  command: string
  args: string[]
  /** Linux 下只能是 AuthorizedWorkspace 内的相对路径（R2 PR-9 INV-B）；
   *  Windows legacy 保留绝对 cwd 语义（与 Linux 路径显式分离）。 */
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
  /** PR-2：真实 SandboxReceipt（不再被丢弃）。 */
  receipt?: SandboxReceipt
}

/** 审计级（Host Audit）允许从宿主复制的安全变量 —— 仅限低风险键。
 *  密钥类键（后缀 _API_KEY / _TOKEN / AWS_* / GITHUB_TOKEN 等）在任何层级都拒绝。
 *  PATH/HOME 属于安全变量（HOST_ENV_SECRET_LEAK 语义排除），宿主工具链依赖。 */
export const AUDIT_HOST_ALLOW_KEYS = [
  "ORCANA_*", "USER", "LOGNAME", "LANG", "LANGUAGE", "LC_ALL",
  "LC_CTYPE", "TERM", "CI", "BUN_*", "NPM_CONFIG_*", "YARN_*", "PNPM_*",
  "NODE_OPTIONS", "EDITOR", "VISUAL",
]

const DEFAULT_STDOUT_MAX = 4 * 1024 * 1024
const DEFAULT_STDERR_MAX = 4 * 1024 * 1024

/** R2 PR-9：ProcessRequest（不可信）→ UntrustedCapabilityRequest。
 *  cwd 在 Linux 下只能是相对路径（解析为相对 workspace 的逻辑目录）；
 *  身份与工作区来自 requireExecutionAuthority()（INV-A/INV-B）。
 *  绝对 cwd 容错：typecheck 工具等传 process.cwd()（绝对）——在 workspace
 *  内则相对化，在 workspace 外相对化后含 .. 由 resolveAuthorizedCwd 的
 *  WORKSPACE_PATH_ESCAPE 拒绝（安全边界不破）。 */
function capabilityRequestFromRequest(request: ProcessRequest): { request: UntrustedCapabilityRequest; authority: TrustedExecutionAuthority } {
  const authority = requireExecutionAuthority()
  const rawCwd = request.cwd ?? "."
  const relativeCwd = isAbsolute(rawCwd)
    ? relative(authority.workspace.hostRoot, rawCwd)
    : rawCwd
  return {
    request: {
      command: {
        executable: request.command,
        args: request.args,
        relativeCwd,
        stdin: "closed",
      },
      profile: request.profile ?? "build",
      network: request.network ? { mode: request.network } : undefined,
      env: request.env,
      // 默认审计级宿主键集（B2 收窄在编译层按隔离执行：namespace/container
      // 只保留安全键，NPM_CONFIG_*/YARN_* 等 registry 凭据键被裁剪）。
      allowedHostKeys: request.allowedHostKeys ?? AUDIT_HOST_ALLOW_KEYS,
      timeoutMs: request.timeoutMs ?? 120_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX,
      stderrMaxBytes: request.stderrMaxBytes ?? DEFAULT_STDERR_MAX,
    },
    authority,
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

/** Test-only dependency injection. It keeps tool-contract tests independent
 *  from whichever optional Linux backends happen to be installed locally. */
export function setLinuxProcessBrokerForTests(value: LinuxExecutionBroker | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setLinuxProcessBrokerForTests requires NODE_ENV=test")
  }
  linuxBroker = value
}

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

  // R2 PR-9：工具只声明能力；权威（身份/工作区/宿主路径）来自 Runtime Context。
  // 无 Authority 时 requireExecutionAuthority 抛错（enabled 路径 fail-closed）。
  const { request: request0, authority } = capabilityRequestFromRequest(request)
  const spec = broker().compileRequest(request0, authority)

  // PR-6：domainId → Agent Domain 投影（cgroup 父层/预算绑定）。
  const domain = authority.domainId
    ? broker().runtimeContext().domainManager.get(authority.domainId)
    : undefined

  yield* fromBrokerEvents(broker().execute(spec, {
    ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
    ...(domain ? { domain } : {}),
    authority,
  }))
}

/** Broker 的 ExecutionCellEvent → 平台无关 ProcessEvent。
 *  PR-2：cell.receipt 不再被 default 分支丢弃 —— 每次执行的真实 Receipt
 *  必须到达调用方。 */
export async function* fromBrokerEvents(events: AsyncIterable<{
  type: string
  cellId?: string
  state?: string
  data?: string
  exitCode?: number | null
  signal?: string | null
  receipt?: SandboxReceipt
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
      case "cell.receipt":
        if (event.receipt) yield { type: "receipt", receipt: event.receipt, at: event.at }
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
  let receipt: SandboxReceipt | undefined
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  for await (const event of executeProcess(request)) {
    switch (event.type) {
      case "stdout": stdoutChunks.push(event.data); break
      case "stderr": stderrChunks.push(event.data); break
      case "receipt": receipt = event.receipt; break
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
    receipt,
  }
}
