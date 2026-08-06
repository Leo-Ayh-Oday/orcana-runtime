/** LNXF-1.0: process supervisor (LF-2) — 统一进程执行核心.
 *
 *  POSIX process group + explicit environment + output limits + unified
 *  timeout/cancel. Orphan detection (double-fork / background daemon) is
 *  measured at exit: the process group is re-scanned after the direct child
 *  closes — survivors belong to the group but escaped the parent chain.
 *  This is the ONLY place in the Linux runtime that spawns processes
 *  (DIRECT_LINUX_PROCESS_BYPASS = 0).
 */

import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { openSync, closeSync } from "node:fs"
import { createOutputLimiter, finalizeOutput, type OutputLimits } from "./output-limiter"
import { countProcessGroup, terminateTree } from "./termination"

export interface SupervisorOptions {
  executable: string
  args: string[]
  cwd: string
  /** 显式构造的完整环境（禁止宿主 env 继承 —— environment.ts）。 */
  env: Record<string, string>
  stdin?: "closed" | "pipe"
  limits: OutputLimits
  wallTimeMs: number
  abortSignal?: AbortSignal
  /** 退出后扫描进程组，统计逃逸后代（后台 daemon / double-fork）。 */
  detectDaemon?: boolean
  /** 实时输出回调（流式消费者用；数据到达即调用，已截断）。 */
  onOutput?: (stream: "stdout" | "stderr", data: Buffer) => void
  /** spawn 完成回调（cgroup attach 用）。 */
  onSpawn?: (pid: number) => void
  /** bwrap seccomp BPF 文件：以 FD 3 打开传给子进程（bwrap --seccomp 3）。
   *  PR-4：bwrap --seccomp 协议要求 FD 数字，不是文件路径。 */
  seccompFdPath?: string
}

export interface SupervisorResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  cancelled: boolean
  outputLimitHit: boolean
  /** 进程组内仍存活的后代进程数（daemon 检测；0 = 干净）。 */
  orphanProcesses: number
}

export interface SpawnedProcess {
  proc: ChildProcess
  pid: number
}

export function spawnSupervised(options: SupervisorOptions): SpawnedProcess {
  const detached = process.platform !== "win32"
  const stdinMode = options.stdin === "pipe" ? "pipe" : "ignore"
  // PR-4：bwrap --seccomp 需要已打开的文件描述符（数字 FD）。
  // 约定 FD 3 为 seccomp 专用槽位：父进程打开 BPF 文件 → stdio[3] 继承。
  let seccompFd: number | undefined
  const stdio: Array<string | number> = [stdinMode, "pipe", "pipe"]
  if (options.seccompFdPath) {
    seccompFd = openSync(options.seccompFdPath, "r")
    stdio[3] = seccompFd
  }
  const proc = spawn(options.executable, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: stdio as import("node:child_process").StdioOptions,
    detached,
    windowsHide: true,
  })
  if (seccompFd !== undefined) closeSync(seccompFd)
  return { proc, pid: proc.pid ?? 0 }
}

export async function runSupervised(options: SupervisorOptions): Promise<SupervisorResult> {
  const startedAt = Date.now()
  const limiter = createOutputLimiter(options.limits)
  const { proc, pid } = spawnSupervised(options)
  options.onSpawn?.(pid)
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  // PR-3：超限即杀 —— 一旦累计输出触及上限，立即终止进程树（不再等到
  // wall timeout，也不再让超限进程持续向内存/上游灌数据）。
  let killedForOutput = false
  const onData = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    // 先截断再入队/回调：队列内永远不会出现未截断的完整 Chunk。
    const sliced = limiter.absorb(stream, chunk)
    ;(stream === "stdout" ? stdoutChunks : stderrChunks).push(sliced.toString("utf-8"))
    options.onOutput?.(stream, sliced)
    if (!killedForOutput && limiter.exceeded()) {
      killedForOutput = true
      terminateTree(pid)
    }
  }
  proc.stdout?.on("data", (chunk: Buffer) => onData("stdout", chunk))
  proc.stderr?.on("data", (chunk: Buffer) => onData("stderr", chunk))

  return new Promise<SupervisorResult>((resolve) => {
    let settled = false
    let timedOut = false
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    const finish = (exitCode: number | null, signal: string | null, orphans: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.abortSignal?.removeEventListener("abort", onAbort)
      resolve({
        exitCode,
        signal,
        stdout: stdoutChunks.join("") + finalizeOutput(limiter.state, "stdout"),
        stderr: stderrChunks.join("") + finalizeOutput(limiter.state, "stderr"),
        durationMs: Date.now() - startedAt,
        timedOut,
        cancelled,
        outputLimitHit: limiter.exceeded(),
        orphanProcesses: orphans,
      })
    }

    const onAbort = () => {
      cancelled = true
      terminateTree(pid)
      finish(null, "aborted", 0)
    }
    options.abortSignal?.addEventListener("abort", onAbort, { once: true })
    if (options.abortSignal?.aborted) onAbort()

    proc.on("error", () => {
      finish(null, "error", 0)
    })
    proc.on("close", (code, signal) => {
      // daemon 检测：父退出后进程组内的幸存者。
      const orphans = options.detectDaemon && pid > 0 ? countProcessGroup(pid) : 0
      finish(code ?? null, signal ?? null, orphans)
    })

    timer = setTimeout(() => {
      timedOut = true
      terminateTree(pid)
      finish(null, "timeout", 0)
    }, options.wallTimeMs)
  })
}

export type StreamedSupervisorEvent =
  | { type: "stdout"; data: string; at: number }
  | { type: "stderr"; data: string; at: number }
  | { type: "exit"; result: SupervisorResult; at: number }

/** 流式队列上限（PR-3）：consumer 消费慢/挂起时队列不得无界增长。
 *  数据本身已由 limiter 截断（总字节 ≤ limits 之和），此处只约束事件数。 */
export const MAX_STREAM_BUFFERED_CHUNKS = 20_000

/** 流式版监督执行：stdout/stderr 数据到达即产出（真实流式，非退出后批处理）。
 *  PR-3：onOutput 数据在入队前已截断；队列有事件数上限，超限丢最旧并
 *  在 exit 结果中标记 outputLimitHit（不允许无界 Chunk 数组）。 */
export async function* streamSupervised(options: SupervisorOptions): AsyncGenerator<StreamedSupervisorEvent> {
  const chunks: Array<{ stream: "stdout" | "stderr"; data: string; at: number }> = []
  let queueDropped = false
  const resultPromise = runSupervised({
    ...options,
    onOutput: (stream, data) => {
      chunks.push({ stream, data: data.toString("utf-8"), at: Date.now() })
      if (chunks.length > MAX_STREAM_BUFFERED_CHUNKS) {
        chunks.shift()
        queueDropped = true
      }
    },
  })
  let result: SupervisorResult | null = null
  let lastIndex = 0
  const settled = resultPromise.then(r => { result = r })
  while (true) {
    if (chunks.length > lastIndex) {
      while (chunks.length > lastIndex) {
        const chunk = chunks[lastIndex++]!
        yield { type: chunk.stream, data: chunk.data, at: chunk.at }
      }
      continue
    }
    if (result) break
    await Promise.race([settled, new Promise(r => setTimeout(r, 15))])
  }
  void queueDropped
  yield { type: "exit", result, at: Date.now() }
}
