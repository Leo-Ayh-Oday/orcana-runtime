/** LNXF-1.0: runtime state store + boot identity + startup janitor (LF-7, plan §20).
 *
 *  Host runtime state lives in ~/.orcana/runtime/linux (capabilities.json,
 *  runs/<runId>/{run.json,domains,cells,receipts,cleanup.json}, locks,
 *  services/<id>.json, ports/<port>.json).
 *  The janitor runs at startup: boot-id based leftover detection — never
 *  PID-based guessing (PID reuse safety); cleans cgroups, worktrees, port
 *  leases, containers (via labels) that provably belong to an old Orcana
 *  run of a previous boot.
 *
 *  LNXF-GATE-02 (A7/B10): durable resource ownership — ServiceCell leases
 *  and port leases are persisted here so recovery is record-driven, never
 *  empty-Broker guesswork.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export interface RuntimeStateStoreOptions {
  root?: string
}

export class RuntimeStateStore {
  private readonly root: string

  constructor(options: RuntimeStateStoreOptions = {}) {
    this.root = options.root ?? join(homedir(), ".orcana", "runtime", "linux")
  }

  capabilitiesPath(): string {
    return join(this.root, "capabilities.json")
  }

  runDir(runId: string): string {
    return join(this.root, "runs", runId)
  }

  writeRun(runId: string, state: Record<string, unknown>): void {
    const dir = this.runDir(runId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "run.json"), JSON.stringify(state, null, 2), "utf8")
  }

  readRun(runId: string): Record<string, unknown> | undefined {
    try {
      return JSON.parse(readFileSync(join(this.runDir(runId), "run.json"), "utf8")) as Record<string, unknown>
    } catch {
      return undefined
    }
  }

  listRuns(): string[] {
    const runsDir = join(this.root, "runs")
    if (!existsSync(runsDir)) return []
    return readdirSync(runsDir).filter(name => existsSync(join(runsDir, name, "run.json")))
  }

  appendReceipt(runId: string, receipt: unknown): void {
    const dir = join(this.runDir(runId), "receipts")
    mkdirSync(dir, { recursive: true })
    const id = (receipt as { cellId?: string }).cellId ?? Date.now().toString()
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(receipt, null, 2), "utf8")
  }

  writeCleanup(runId: string, report: unknown): void {
    const dir = this.runDir(runId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "cleanup.json"), JSON.stringify(report, null, 2), "utf8")
  }

  removeRun(runId: string): void {
    rmSync(this.runDir(runId), { recursive: true, force: true })
  }

  lockPath(name: string): string {
    const dir = join(this.root, "locks")
    mkdirSync(dir, { recursive: true })
    return join(dir, `${name}.lock`)
  }

  // ── LNXF-GATE-02：durable service / port lease records ──

  /** 服务长期进程的持久化租赁记录（janitor 恢复依据）。 */
  writeServiceLease(lease: ServiceLeaseRecord): void {
    const dir = join(this.root, "services")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${lease.id}.json`), JSON.stringify(lease, null, 2), "utf8")
  }

  readServiceLeases(): ServiceLeaseRecord[] {
    const dir = join(this.root, "services")
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter(name => name.endsWith(".json"))
      .map(name => {
        try {
          return JSON.parse(readFileSync(join(dir, name), "utf8")) as ServiceLeaseRecord
        } catch {
          return undefined
        }
      })
      .filter((lease): lease is ServiceLeaseRecord => lease !== undefined)
  }

  removeServiceLease(id: string): void {
    rmSync(join(this.root, "services", `${id}.json`), { force: true })
  }

  /** 端口租赁记录（同一端口并发服务冲突检测 + 恢复释放）。 */
  writePortLease(lease: PortLease): void {
    const dir = join(this.root, "ports")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${lease.port}.json`), JSON.stringify(lease, null, 2), "utf8")
  }

  readPortLeases(): PortLease[] {
    const dir = join(this.root, "ports")
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter(name => name.endsWith(".json"))
      .map(name => {
        try {
          return JSON.parse(readFileSync(join(dir, name), "utf8")) as PortLease
        } catch {
          return undefined
        }
      })
      .filter((lease): lease is PortLease => lease !== undefined)
  }

  removePortLease(port: number): void {
    rmSync(join(this.root, "ports", `${port}.json`), { force: true })
  }
}

/** LNXF-GATE-02：ServiceCell 的 durable 租赁记录（不含进程句柄）。
 *  owner 判定用 pid + ownerProcStartTicks 双校验（PID 复用安全）。 */
export interface ServiceLeaseRecord {
  id: string
  kind: "service" | "mcp" | "lsp"
  runId?: string
  pid: number | undefined
  ownerProcStartTicks: number
  url?: string
  port?: number
  command: string
  cwd: string
  startedAt: number
  status: "starting" | "ready" | "stopped" | "failed"
  cleanupPolicy: "manual" | "run-end"
  logPath: string
  restartPolicy: "none"
  stoppedAt?: number
}

/** LNXF-GATE-02：端口租赁记录。 */
export interface PortLease {
  port: number
  serviceId: string
  runId?: string
  pid: number | undefined
  ownerProcStartTicks: number
  startedAt: number
  releasedAt?: number
}

/** LNXF-GATE-02：ServiceCell 集成方的 durable 存储抽象。 */
export interface ServiceLeaseStore {
  writeServiceLease(lease: ServiceLeaseRecord): void
  readServiceLeases(): ServiceLeaseRecord[]
  removeServiceLease(id: string): void
  writePortLease(lease: PortLease): void
  readPortLeases(): PortLease[]
  removePortLease(port: number): void
}

/** 进程已死判定（PID 复用安全）：pid 无效或 starttime 不匹配 → 死。 */
export function processDead(pid: number | undefined, ownerProcStartTicks: number): boolean {
  if (!pid || pid <= 0) return true
  if (!ownerProcStartTicks) return true
  const current = procStartTicksOf(pid)
  return current <= 0 || current !== ownerProcStartTicks
}

export interface BootIdentity {
  bootId: string
  /** 本次进程启动时刻（用于残留判定）。 */
  processStartedAt: number
}

export function readBootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
  } catch {
    return "unknown-boot"
  }
}

/** PR-7：读取 /proc/<pid>/stat 的进程启动时钟 tick（第 22 字段）。
 *  PID 复用安全：同 boot 内 PID 被回收后，新进程的 starttime 必然不同。
 *  comm 可能含空格/括号 —— 从最后一个 ')' 后按空白切分再计数。 */
export function procStartTicksOf(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const closeParen = stat.lastIndexOf(")")
    if (closeParen < 0) return 0
    const fields = stat.slice(closeParen + 1).trim().split(/\s+/)
    // 字段 1=pid 2=comm 3=state 4=ppid ... 22=starttime
    // fields[0]=state（字段3）→ starttime = fields[19]
    return Number(fields[19] ?? 0)
  } catch {
    return 0
  }
}

/** 判断 run 的 owner 进程是否存活（PID + starttime 双重校验）。 */
export function runOwnedByLiveProcess(run: Record<string, unknown>): boolean {
  const pid = Number(run.ownerPid ?? 0)
  const startTicks = Number(run.ownerProcStartTicks ?? 0)
  if (!pid || pid <= 0) return false
  if (!startTicks) return false
  const current = procStartTicksOf(pid)
  return current > 0 && current === startTicks
}

export class BootIdentityStore {
  private readonly root: string
  constructor(store: RuntimeStateStore) {
    this.root = store.capabilitiesPath().replace(/capabilities\.json$/, "")
  }

  /** 记录当前 bootId（每次进程启动刷新）。 */
  recordBoot(bootId: string): void {
    mkdirSync(this.root, { recursive: true })
    writeFileSync(join(this.root, "boot.json"), JSON.stringify({ bootId, recordedAt: Date.now() }, null, 2), "utf8")
  }

  lastBoot(): string | undefined {
    try {
      const data = JSON.parse(readFileSync(join(this.root, "boot.json"), "utf8")) as { bootId?: string }
      return data.bootId
    } catch {
      return undefined
    }
  }
}

/** 进程启动时清理：清理 lastBoot ≠ 当前 bootId 的 run 状态；
 *  PR-7：同 boot 内通过 owner PID + starttime 识别已崩溃进程的 run（PID 复用安全）。 */
export function staleRunsForCleanup(store: RuntimeStateStore, currentBootId: string): string[] {
  const last = new BootIdentityStore(store).lastBoot()
  const runsDir = store.runDir(".")
  if (!existsSync(runsDir)) return []
  const names = readdirSync(runsDir).filter(name => existsSync(join(runsDir, name, "run.json")))
  if (last !== currentBootId) return names
  // 同 boot：只有 owner 进程已死的 run 才算 stale（存活 owner 的 run 不误杀）。
  return names.filter(name => {
    const run = store.readRun(name)
    return run ? !runOwnedByLiveProcess(run) : true
  })
}

export interface RecoveryReceipt {
  runId: string
  cleaned: {
    cgroups: string[]
    worktrees: string[]
    ports: number
    services: number
    containers: string[]
    stateRemoved: boolean
  }
  skipped: string[]
  at: number
}

/** 启动 Janitor：清理 stale run（跨 boot 全部 + 同 boot 仅 owner 已死；PR-7）。 */
export async function startupJanitor(options: {
  store: RuntimeStateStore
  currentBootId: string
  cleanupRun?: (runId: string) => Promise<RecoveryReceipt["cleaned"]>
}): Promise<RecoveryReceipt[]> {
  const bootStore = new BootIdentityStore(options.store)
  const stale = staleRunsForCleanup(options.store, options.currentBootId)
  const receipts: RecoveryReceipt[] = []
  for (const runId of stale) {
    const cleaned = options.cleanupRun
      ? await options.cleanupRun(runId)
      : { cgroups: [], worktrees: [], ports: 0, services: 0, containers: [], stateRemoved: false }
    const receipt: RecoveryReceipt = {
      runId,
      cleaned,
      skipped: [],
      at: Date.now(),
    }
    receipts.push(receipt)
    options.store.writeCleanup(runId, receipt)
  }
  bootStore.recordBoot(options.currentBootId)
  return receipts
}
