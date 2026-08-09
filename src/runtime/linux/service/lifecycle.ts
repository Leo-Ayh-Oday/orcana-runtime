/** LR2-5（P5-C）：ServiceManager —— 生命周期（启动/探活/健康/重启/停止）。
 *
 *  服务是长驻进程（非短任务完成语义）：DECLARED → 启动（显式环境，不
 *  继承宿主 env）→ readiness 探活 → READY → health 周期监测 → DEGRADED
 *  /RESTARTING（restartPolicy + maxRestarts）→ 优雅停止（shutdownContract）。
 *
 *  LR2-5 审核修复：
 *  - B1：epoch 代数取消 —— stop() 递增 generation，所有异步续体（端口
 *    检查/探活循环/健康回调）在副作用前校验 epoch 与状态（停止后不得
 *    再 spawn）；
 *  - M2：重启先终止旧进程（健康失败的重启不产生孤儿 + 端口死锁）；
 *  - M3：on-failure 仅非零退出码重启（exit 0 不重启）；
 *  - M4：exit 覆盖 READINESS_PENDING（重启或 START_FAILED，不卡探测）；
 *  - M5：handleCrash 互斥（restarting 中不重复进入）；
 *  - M6：spawn error → START_FAILED（ENOENT 不卡死）；
 *  - M12：readiness deadline 可配置。
 */

import { spawn, type ChildProcess } from "node:child_process"
import net from "node:net"
import { ServiceStateMachine } from "./state-machine"
import type { ServiceCellSpec } from "./spec"
import { validateServiceSpec } from "./spec"

export interface ProbeResult {
  ok: boolean
  detail?: string
}

export async function runProbe(spec: ServiceCellSpec, kind: "readinessProbe" | "healthProbe"): Promise<ProbeResult> {
  const probe = spec[kind]
  if (!probe) return { ok: true } // 无探活 = 通过（调用方决定是否需要）
  const timeoutMs = Math.max(1, probe.timeoutMs ?? 1000)
  if (probe.kind === "http") {
    return new Promise(resolve => {
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort(); resolve({ ok: false, detail: "timeout" }) }, timeoutMs)
      // m14：本地探活默认直连（Bun fetch 不挂全局代理 dispatcher ——
      // 127.0.0.1 流量经代理转发会误报健康状态）。
      fetch(probe.url, { signal: controller.signal, redirect: "manual" })
        .then(res => {
          clearTimeout(timer)
          const expected = probe.expectedStatus ?? 200
          resolve({ ok: res.status === expected, detail: `http ${res.status}` })
        })
        .catch(() => { clearTimeout(timer); resolve({ ok: false, detail: "connection failed" }) })
    })
  }
  // tcp
  return new Promise(resolve => {
    const socket = net.createConnection({ host: probe.host, port: probe.port })
    const timer = setTimeout(() => { socket.destroy(); resolve({ ok: false, detail: "timeout" }) }, timeoutMs)
    socket.on("connect", () => { clearTimeout(timer); socket.destroy(); resolve({ ok: true }) })
    socket.on("error", () => { clearTimeout(timer); resolve({ ok: false, detail: "connection refused" }) })
  })
}

/** 端口占用检查（loopback 绑定冲突检测）。 */
export function portAvailable(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.listen(port, host, () => server.close(() => resolve(true)))
  })
}

export interface ServiceManagerOptions {
  spec: ServiceCellSpec
  now?: () => number
  /** 显式环境（默认：仅 PATH/HOME —— 不继承宿主 env）。 */
  env?: Record<string, string>
  /** 探活间隔（readiness 轮询）。 */
  probeIntervalMs?: number
  /** readiness 超时（m12：可配置，默认 30s）。 */
  readinessTimeoutMs?: number
}

export class ServiceManager {
  readonly state: ServiceStateMachine
  private proc?: ChildProcess
  private healthTimer?: ReturnType<typeof setInterval>
  private restarts = 0
  private readonly env: Record<string, string>
  /** B1：代数计数 —— stop() 递增；异步续体副作用前校验。 */
  private epoch = 0

  constructor(private readonly opts: ServiceManagerOptions) {
    const validation = validateServiceSpec(opts.spec)
    if (!validation.ok) throw new Error(`invalid service spec: ${validation.errors.join("; ")}`)
    this.state = new ServiceStateMachine(opts.spec.serviceId, opts.now ?? Date.now)
    this.env = { PATH: "/usr/bin:/bin", HOME: "/home/orcana", ...opts.env }
  }

  get pid(): number | undefined {
    return this.proc?.pid
  }

  /** 进程是否仍在运行（bun 的 exitCode 在 exit 后保持 null —— 用
   *  signalCode 联合判断；node 语义两者其一非 null 即已退出）。 */
  get isRunning(): boolean {
    return this.proc ? this.proc.exitCode === null && this.proc.signalCode === null : false
  }

  /** DECLARED → STARTING → 端口检查 → spawn → PROCESS_RUNNING → 探活。 */
  async start(): Promise<void> {
    const myEpoch = this.epoch
    this.state.transition("STARTING", "start requested")
    // 端口冲突检查（全部 portRequests）
    for (const p of this.opts.spec.portRequests) {
      const available = await portAvailable(p.port, p.bind === "all" ? "0.0.0.0" : "127.0.0.1")
      // B1：检查期间 stop() 可能已发生 —— 副作用前校验 epoch
      if (this.epoch !== myEpoch || this.state.isTerminal) return
      if (!available) {
        this.state.force("PORT_CONFLICT", `port ${p.port} already in use`)
        throw new Error(`PORT_CONFLICT: port ${p.port} in use`)
      }
    }
    this.spawnProcess(myEpoch)
    if (this.epoch !== myEpoch) return
    this.state.transition("PROCESS_RUNNING", "spawned")
    await this.waitReadiness(myEpoch)
  }

  private spawnProcess(epoch: number): void {
    const spec = this.opts.spec
    try {
      this.proc = spawn(spec.command.executable, spec.command.args, {
        cwd: spec.command.cwdRef,
        env: this.env, // 显式环境（不继承宿主 env —— 安全约束）
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      })
    } catch (error) {
      // M6：spawn 同步抛错（ENOENT 等）→ START_FAILED
      this.state.force("START_FAILED", `spawn failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.proc.stdout?.resume()
    this.proc.stderr?.resume()
    this.proc.on("error", (error) => {
      // M6：异步 error（ENOENT/EACCES）→ START_FAILED（不卡死）
      this.state.force("START_FAILED", `spawn error: ${error.message}`)
    })
    this.proc.on("exit", (code, signal) => {
      if (this.epoch !== epoch) return // 旧代进程退出：忽略
      // M4：exit 覆盖 READINESS_PENDING（不卡探测）
      const current = this.state.current
      if (current === "READY" || current === "DEGRADED" || current === "READINESS_PENDING" || current === "PROCESS_RUNNING") {
        this.handleExit(code, signal)
      }
    })
  }

  /** READINESS_PENDING：轮询 readiness 探活直到通过（M12 deadline 可配置）。 */
  private async waitReadiness(epoch: number): Promise<void> {
    const spec = this.opts.spec
    if (!spec.readinessProbe) {
      if (this.epoch !== epoch || this.state.isTerminal) return
      this.state.transition("READINESS_PENDING", "no probe")
      this.state.transition("READY", "no readiness probe required")
      this.startHealthMonitoring(epoch)
      return
    }
    this.state.transition("READINESS_PENDING", "probing")
    const interval = this.opts.probeIntervalMs ?? 200
    const deadline = (this.opts.now?.() ?? Date.now()) + (this.opts.readinessTimeoutMs ?? 30_000)
    for (;;) {
      // M4：探活期间进程死亡 → 立即走崩溃路径（不轮询死端口）
      if (this.proc?.exitCode !== null && this.proc?.exitCode !== undefined) {
        this.handleExit(this.proc.exitCode, this.proc.signalCode)
        return
      }
      if (this.epoch !== epoch || this.state.isTerminal) return
      const result = await runProbe(spec, "readinessProbe")
      if (this.epoch !== epoch || this.state.isTerminal) return
      if (result.ok) {
        this.state.transition("READY", "readiness passed")
        this.startHealthMonitoring(epoch)
        return
      }
      if ((this.opts.now?.() ?? Date.now()) > deadline) {
        this.state.force("HEALTH_FAILED", "readiness timeout")
        await this.stopProcess()
        return
      }
      await new Promise(r => setTimeout(r, interval))
    }
  }

  private startHealthMonitoring(epoch: number): void {
    const spec = this.opts.spec
    if (!spec.healthProbe) return
    // M5：先清理旧计时器（重启后重建不翻倍）
    if (this.healthTimer) clearInterval(this.healthTimer)
    const interval = spec.healthIntervalMs ?? 5_000
    this.healthTimer = setInterval(async () => {
      if (this.epoch !== epoch) return
      if (this.state.current !== "READY" && this.state.current !== "DEGRADED") return
      const result = await runProbe(spec, "healthProbe")
      if (this.epoch !== epoch) return
      if (result.ok) {
        // m15：健康恢复 → READY（不整体重启）
        if (this.state.current === "DEGRADED") this.state.transition("READY", "health recovered")
        return
      }
      if (this.state.current === "READY" || this.state.current === "DEGRADED") {
        this.state.transition("DEGRADED", `health failed: ${result.detail ?? ""}`)
        this.handleExit(null, null) // 健康失败 → 重启决策（M5 互斥在 handleExit）
      }
    }, interval)
  }

  /** 崩溃/健康失败入口（M3/M5 语义）。 */
  private handleExit(code: number | null, signal: string | null): void {
    const spec = this.opts.spec
    // M5 互斥：已在重启流程/终态 → 不重复进入
    if (this.state.current === "RESTARTING" || this.state.isTerminal) return
    // M3：on-failure 仅非零退出码（或异常信号）重启
    const cleanExit = code === 0 && signal === null
    if (spec.restartPolicy === "none" || (spec.restartPolicy === "on-failure" && cleanExit)) {
      this.state.force("HEALTH_FAILED", `process exited (code=${code} signal=${signal}, restart ${spec.restartPolicy})`)
      return
    }
    this.restarts += 1
    if (this.restarts > spec.maxRestarts) {
      this.state.force("RESTART_EXHAUSTED", `restarts ${this.restarts} > max ${spec.maxRestarts}`)
      return
    }
    this.state.transition("RESTARTING", `crash restart ${this.restarts}`)
    const myEpoch = this.epoch
    // M2：重启先终止旧进程（防孤儿 + 端口死锁）
    void this.stopProcess().then(() => {
      if (this.epoch !== myEpoch || this.state.isTerminal) return
      this.spawnProcess(myEpoch)
      if (this.epoch !== myEpoch) return
      this.state.transition("PROCESS_RUNNING", "restarted")
      void this.waitReadiness(myEpoch)
    })
  }

  /** 优雅停止（shutdownContract：SIGTERM → grace → SIGKILL）。
   *  B1：递增 epoch（所有在途异步续体失效）。 */
  async stop(): Promise<void> {
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.epoch += 1
    if (this.state.current === "STOPPED" || this.state.current === "STOPPING") return
    this.state.transition("STOPPING", "stop requested")
    await this.stopProcess()
    this.state.transition("STOPPED", "stopped")
  }

  private stopProcess(): Promise<void> {
    const proc = this.proc
    if (!proc?.pid) return Promise.resolve()
    // 已退出（exitCode 已置）→ 立即返回（once("exit") 不会再触发 —— 死等）
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()
    const graceMs = this.opts.spec.shutdownContract.graceMs
    return new Promise<void>(resolve => {
      const force = setTimeout(() => {
        try { proc.kill("SIGKILL") } catch { /* gone */ }
      }, graceMs)
      proc.once("exit", () => { clearTimeout(force); resolve() })
      try { proc.kill("SIGTERM") } catch { clearTimeout(force); resolve() }
    })
  }
}
