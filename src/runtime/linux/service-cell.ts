/** LNXF-GATE-02 (B12+B13)：ServiceCell —— 长期进程的统一执行单元。
 *
 *  合同（GATES-CONTROL-PLANE-PLAN.md §十九）：service/mcp/lsp 必须离开
 *  spawnLegacy 旁路，进入 ServiceCell：
 *
 *    ServiceCell
 *     ├─ lease          （durable 记录，janitor 恢复依据）
 *     ├─ owner          （pid + starttime 双校验，不误杀）
 *     ├─ readiness      （URL 探活，启动失败如实上报）
 *     ├─ resource budget（预留：cgroup/内存上限由 broker 侧接入）
 *     ├─ explicit env   （minimalHostEnv 白名单 + 拒绝集过滤）
 *     ├─ restart policy （"none" —— 不自动重启，终止如实上报）
 *     ├─ health         （proc exit / 探活失败更新 status）
 *     └─ durable cleanup（release() 删记录 + 停进程树）
 *
 *  设计约束：本单元不依赖 broker/cgroup（service/mcp/lsp 目前不在 broker
 *  管辖）；lease 持久化经 ServiceLeaseStore（RuntimeStateStore 实现）。
 */

import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { minimalHostEnv } from "./environment"
import { procStartTicksOf, type ServiceLeaseRecord, type ServiceLeaseStore } from "./recovery/state-store"

export type ServiceCellKind = ServiceLeaseRecord["kind"]

export interface CreateServiceCellInput {
  kind: ServiceCellKind
  command: string
  args: string[]
  cwd: string
  /** 可选的 readiness 探活目标（http(s) URL）。 */
  url?: string
  port?: number
  runId?: string
  cleanupPolicy: "manual" | "run-end"
  logPath: string
  /** 额外显式环境（经拒绝集过滤，与 minimalHostEnv 合并）。 */
  env?: Record<string, string>
  /** stdio 配置（默认 ["ignore","pipe","pipe"] —— service 仅日志；MCP/LSP
   *  协议进程必须传 ["pipe","pipe","pipe"] 走 stdin 请求）。 */
  stdio?: Array<"ignore" | "pipe" | "inherit">
  detached?: boolean
  /** 终止回调（exit code/signal；status 更新后调用）。 */
  onExit?: (info: { code: number | null; signal: string | null; id: string }) => void
  /** durable 存储（缺省不持久化 —— 兼容 legacy 直调）。 */
  store?: ServiceLeaseStore
  /** 探活实现（默认 http(s) GET；测试注入）。 */
  probe?: (url: string) => Promise<boolean>
}

export interface ServiceCell {
  proc: ChildProcess
  lease: ServiceLeaseRecord
  /** 标记 ready（探活成功）；失败路径置 failed 并清理。 */
  markReady(): void
  markFailed(): void
  /** 停止进程树 + 释放 lease 记录（幂等）。 */
  release(): void
}

/** 默认探活：http(s) GET，2xx 即 ready。 */
export async function probeHttpUrl(url: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const parsed = new URL(url)
      const client: typeof httpRequest = parsed.protocol === "https:" ? httpsRequest : httpRequest
      const req = client({
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        timeout: 2_000,
      }, (res) => {
        const code = res.statusCode ?? 0
        res.resume()
        resolve(code >= 200 && code < 300)
      })
      req.on("timeout", () => {
        req.destroy()
        resolve(false)
      })
      req.on("error", () => resolve(false))
      req.end()
    } catch {
      resolve(false)
    }
  })
}

/** 创建并登记一个 ServiceCell。调用方负责后续探活 + markReady/markFailed。 */
export function createServiceCell(input: CreateServiceCellInput): ServiceCell {
  const id = `cell-${randomUUID().slice(0, 8)}`
  const startedAt = Date.now()
  const proc: ChildProcess = spawn(input.command, input.args, {
    cwd: input.cwd,
    shell: false,
    detached: input.detached ?? true,
    stdio: input.stdio ?? ["ignore", "pipe", "pipe"],
    // explicit env：白名单 + 显式 extra 经拒绝集过滤 —— 宿主 API key/
    // 代理/SSH 凭据零泄露（E1.2 语义，ServiceCell 化后保持）。
    env: minimalHostEnv(input.env),
    windowsHide: true,
  })

  const lease: ServiceLeaseRecord = {
    id,
    kind: input.kind,
    runId: input.runId,
    pid: proc.pid,
    ownerProcStartTicks: proc.pid ? procStartTicksOf(proc.pid) : 0,
    url: input.url,
    port: input.port,
    command: input.command,
    cwd: input.cwd,
    startedAt,
    status: "starting",
    cleanupPolicy: input.cleanupPolicy,
    logPath: input.logPath,
    restartPolicy: "none",
  }

  const persist = () => input.store?.writeServiceLease(lease)
  const removeRecord = () => input.store?.removeServiceLease(id)
  persist()

  let released = false
  const release = () => {
    if (released) return
    released = true
    if (lease.status !== "failed") lease.status = "stopped"
    lease.stoppedAt = Date.now()
    try {
      if (proc.pid) process.kill(-proc.pid, "SIGTERM")
    } catch {
      // 进程组已退出或无权 —— best-effort
    }
    removeRecord()
  }

  proc.on("exit", (code, signal) => {
    if (!released) lease.status = "stopped"
    lease.stoppedAt = Date.now()
    removeRecord()
    input.onExit?.({ code, signal, id })
  })
  proc.on("error", () => {
    lease.status = "failed"
    removeRecord()
    input.onExit?.({ code: null, signal: null, id })
  })

  return {
    proc,
    lease,
    markReady() {
      lease.status = "ready"
      persist()
    },
    markFailed() {
      lease.status = "failed"
      removeRecord()
    },
    release,
  }
}
