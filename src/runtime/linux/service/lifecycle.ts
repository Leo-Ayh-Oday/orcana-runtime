/** LR2-5（P5-C）：ServiceManager —— 生命周期（启动/探活/健康/重启/停止）。
 *
 *  服务是长驻进程（非短任务完成语义）：DECLARED → 启动（显式环境，不
 *  继承宿主 env）→ readiness 探活 → READY → health 周期监测 → DEGRADED
 *  /RESTARTING（restartPolicy + maxRestarts）→ 优雅停止（shutdownContract）。
 *
 *  端口：portRequests 在启动前检查占用（PORT_CONFLICT_UNCHECKED = 0）。
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
  const timeoutMs = probe.timeoutMs ?? 1000
  if (probe.kind === "http") {
    return new Promise(resolve => {
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort(); resolve({ ok: false, detail: "timeout" }) }, timeoutMs)
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
}

export class ServiceManager {
  readonly state: ServiceStateMachine
  private proc?: ChildProcess
  private healthTimer?: ReturnType<typeof setInterval>
  private restarts = 0
  private readonly env: Record<string, string>

  constructor(private readonly opts: ServiceManagerOptions) {
    const validation = validateServiceSpec(opts.spec)
    if (!validation.ok) throw new Error(`invalid service spec: ${validation.errors.join("; ")}`)
    this.state = new ServiceStateMachine(opts.spec.serviceId, opts.now ?? Date.now)
    this.env = { PATH: "/usr/bin:/bin", HOME: "/home/orcana", ...opts.env }
  }

  get pid(): number | undefined {
    return this.proc?.pid
  }

  /** DECLARED → STARTING → 端口检查 → spawn → PROCESS_RUNNING → 探活。 */
  async start(): Promise<void> {
    this.state.transition("STARTING", "start requested")
    // 端口冲突检查（全部 portRequests）
    for (const p of this.opts.spec.portRequests) {
      const available = await portAvailable(p.port)
      if (!available) {
        this.state.force("PORT_CONFLICT", `port ${p.port} already in use`)
        throw new Error(`PORT_CONFLICT: port ${p.port} in use`)
      }
    }
    this.spawnProcess()
    this.state.transition("PROCESS_RUNNING", "spawned")
    await this.waitReadiness()
  }

  private spawnProcess(): void {
    const spec = this.opts.spec
    this.proc = spawn(spec.command.executable, spec.command.args, {
      cwd: spec.command.cwdRef,
      env: this.env, // 显式环境（不继承宿主 env —— 安全约束）
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
    this.proc.stdout?.resume()
    this.proc.stderr?.resume()
    this.proc.on("exit", (code, signal) => {
      if (this.state.current === "READY" || this.state.current === "DEGRADED") {
        this.handleCrash(code, signal)
      }
    })
  }

  /** READINESS_PENDING：轮询 readiness 探活直到通过。 */
  private async waitReadiness(): Promise<void> {
    const spec = this.opts.spec
    if (!spec.readinessProbe) {
      this.state.transition("READINESS_PENDING", "no probe")
      this.state.transition("READY", "no readiness probe required")
      this.startHealthMonitoring()
      return
    }
    this.state.transition("READINESS_PENDING", "probing")
    const interval = this.opts.probeIntervalMs ?? 200
    const deadline = Date.now() + 30_000
    for (;;) {
      const result = await runProbe(spec, "readinessProbe")
      if (result.ok) {
        this.state.transition("READY", "readiness passed")
        this.startHealthMonitoring()
        return
      }
      if (Date.now() > deadline) {
        this.state.force("HEALTH_FAILED", "readiness timeout")
        this.stopProcess()
        return
      }
      await new Promise(r => setTimeout(r, interval))
    }
  }

  private startHealthMonitoring(): void {
    const spec = this.opts.spec
    if (!spec.healthProbe) return
    const interval = spec.healthIntervalMs ?? 5_000
    this.healthTimer = setInterval(async () => {
      if (this.state.current !== "READY" && this.state.current !== "DEGRADED") return
      const result = await runProbe(spec, "healthProbe")
      if (!result.ok) {
        this.state.transition("DEGRADED", `health failed: ${result.detail ?? ""}`)
        this.handleCrash(null, null) // 健康失败 → 重启决策
      }
    }, interval)
  }

  private handleCrash(_code: number | null, _signal: string | null): void {
    const spec = this.opts.spec
    if (spec.restartPolicy === "none") {
      this.state.force("HEALTH_FAILED", "process exited (restart none)")
      return
    }
    this.restarts += 1
    if (this.restarts > spec.maxRestarts) {
      this.state.force("RESTART_EXHAUSTED", `restarts ${this.restarts} > max ${spec.maxRestarts}`)
      return
    }
    this.state.transition("RESTARTING", `crash restart ${this.restarts}`)
    this.spawnProcess()
    this.state.transition("PROCESS_RUNNING", "restarted")
    void this.waitReadiness()
  }

  /** 优雅停止（shutdownContract：SIGTERM → grace → SIGKILL）。 */
  async stop(): Promise<void> {
    if (this.healthTimer) clearInterval(this.healthTimer)
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
