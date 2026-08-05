/** LNXF-1.0: runtime state store + boot identity + startup janitor (LF-7, plan §20).
 *
 *  Host runtime state lives in ~/.orcana/runtime/linux (capabilities.json,
 *  runs/<runId>/{run.json,domains,cells,receipts,cleanup.json}, locks).
 *  The janitor runs at startup: boot-id based leftover detection — never
 *  PID-based guessing (PID reuse safety); cleans cgroups, worktrees, port
 *  leases, containers (via labels) that provably belong to an old Orcana
 *  run of a previous boot.
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

  /** 进程启动时清理：仅清理 lastBoot ≠ 当前 bootId 的 run 状态。 */
  staleRunsForCleanup(currentBootId: string): string[] {
    const last = this.lastBoot()
    if (last === currentBootId) return []
    const runsDir = join(this.root, "runs")
    if (!existsSync(runsDir)) return []
    return readdirSync(runsDir).filter(name => existsSync(join(runsDir, name, "run.json")))
  }
}

export interface RecoveryReceipt {
  runId: string
  cleaned: {
    cgroups: string[]
    worktrees: string[]
    ports: number
    containers: string[]
    stateRemoved: boolean
  }
  skipped: string[]
  at: number
}

/** 启动 Janitor：清理属于旧 boot 的残留（不按 PID 猜）。 */
export async function startupJanitor(options: {
  store: RuntimeStateStore
  currentBootId: string
  cleanupRun?: (runId: string) => Promise<RecoveryReceipt["cleaned"]>
}): Promise<RecoveryReceipt[]> {
  const bootStore = new BootIdentityStore(options.store)
  const stale = bootStore.staleRunsForCleanup(options.currentBootId)
  const receipts: RecoveryReceipt[] = []
  for (const runId of stale) {
    const cleaned = options.cleanupRun
      ? await options.cleanupRun(runId)
      : { cgroups: [], worktrees: [], ports: 0, containers: [], stateRemoved: false }
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
