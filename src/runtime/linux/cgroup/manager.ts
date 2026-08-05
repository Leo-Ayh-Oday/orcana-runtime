/** LNXF-1.0: cgroup v2 hierarchy + manager (LF-4, plan §11.1–11.4).
 *
 *  Hierarchy: orcana.scope → run-<runId> → {agent-<id>, system} → cell-<id>.
 *  Cell-level controllers: cpu.max, cpu.weight, memory.high/max,
 *  memory.swap.max, memory.oom.group, pids.max, io.weight. Cancellation =
 *  cgroup.kill (tree). The filesystem layer is injectable so the full
 *  lifecycle is testable without a delegated cgroup.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs"
import { join } from "node:path"

export interface CgroupFs {
  exists(path: string): boolean
  read(path: string): string
  write(path: string, content: string): void
  mkdir(path: string): void
  rm(path: string): void
  readdir(path: string): string[]
}

export const REAL_CGROUP_FS: CgroupFs = {
  exists: existsSync,
  read(path) {
    return readFile(path)
  },
  write(path, content) {
    writeFile(path, content)
  },
  mkdir(path) {
    mkdir(path)
  },
  rm(path) {
    rm(path)
  },
  readdir(path) {
    return readdir(path)
  },
}

function readFile(path: string): string {
  return readFileSync(path, "utf8")
}
function writeFile(path: string, content: string): void {
  writeFileSync(path, content)
}
function mkdir(path: string): void {
  mkdirSync(path, { recursive: true })
}
function rm(path: string): void {
  rmSync(path, { recursive: true, force: true })
}
function readdir(path: string): string[] {
  return readdirSync(path)
}

export interface CellLimits {
  cpuQuotaMicros?: number
  cpuPeriodMicros?: number
  cpuWeight?: number
  memoryHighBytes?: number
  memoryMaxBytes: number
  swapMaxBytes?: number
  pidsMax: number
  ioWeight?: number
  oomGroup?: boolean
}

/** 路径布局（hierarchy.ts 职责）。 */
export function hierarchyPaths(base: string, runId: string, agentId: string | undefined, cellId: string): {
  run: string
  agent: string
  cell: string
} {
  const ns = join(base, "orcana.scope")
  const run = join(ns, `run-${runId}`)
  const agent = agentId ? join(run, `agent-${agentId}`) : join(run, "system")
  const cell = join(agent, `cell-${cellId}`)
  return { run, agent, cell }
}

export interface CgroupManagerOptions {
  /** 委托根 base（delegation.ts detectDelegatedRoot().base）。 */
  base: string
  fs?: CgroupFs
}

export class CgroupManager {
  private readonly fs: CgroupFs
  private readonly base: string
  private readonly created: string[] = []

  constructor(options: CgroupManagerOptions) {
    this.base = options.base
    this.fs = options.fs ?? REAL_CGROUP_FS
  }

  private ensure(path: string): void {
    if (!this.fs.exists(path)) {
      this.fs.mkdir(path)
      this.created.push(path)
    }
  }

  private writeAttr(path: string, file: string, value: string): void {
    const full = join(path, file)
    if (!this.fs.exists(full)) throw new Error(`cgroup attribute missing: ${full}`)
    this.fs.write(full, value)
  }

  /** 创建 Run 层（总资源 + 全局取消点）。 */
  createRun(runId: string, limits: Partial<CellLimits> = {}): string {
    const { run } = hierarchyPaths(this.base, runId, undefined, "x")
    this.ensure(run)
    this.enableControllers(run, ["cpu", "memory", "pids"])
    if (limits.memoryMaxBytes) this.writeAttr(run, "memory.max", String(limits.memoryMaxBytes))
    if (limits.pidsMax) this.writeAttr(run, "pids.max", String(limits.pidsMax))
    if (limits.cpuQuotaMicros && limits.cpuPeriodMicros) {
      this.writeAttr(run, "cpu.max", `${limits.cpuQuotaMicros} ${limits.cpuPeriodMicros}`)
    }
    return run
  }

  /** 创建 Agent 层。 */
  createAgent(runId: string, agentId: string, limits: Partial<CellLimits> = {}): string {
    const { agent } = hierarchyPaths(this.base, runId, agentId, "x")
    this.ensure(agent)
    this.enableControllers(agent, ["cpu", "memory", "pids"])
    if (limits.memoryMaxBytes) this.writeAttr(agent, "memory.max", String(limits.memoryMaxBytes))
    if (limits.pidsMax) this.writeAttr(agent, "pids.max", String(limits.pidsMax))
    if (limits.cpuWeight) this.writeAttr(agent, "cpu.weight", String(limits.cpuWeight))
    return agent
  }

  /** 创建 Cell 层（完整限制）。 */
  createCell(runId: string, agentId: string | undefined, cellId: string, limits: CellLimits): string {
    const { cell } = hierarchyPaths(this.base, runId, agentId, cellId)
    this.ensure(cell)
    this.enableControllers(cell, ["cpu", "memory", "pids", "io"])
    if (limits.cpuQuotaMicros && limits.cpuPeriodMicros) {
      this.writeAttr(cell, "cpu.max", `${limits.cpuQuotaMicros} ${limits.cpuPeriodMicros}`)
    }
    if (limits.cpuWeight) this.writeAttr(cell, "cpu.weight", String(limits.cpuWeight))
    if (limits.memoryHighBytes) this.writeAttr(cell, "memory.high", String(limits.memoryHighBytes))
    this.writeAttr(cell, "memory.max", String(limits.memoryMaxBytes))
    if (limits.swapMaxBytes !== undefined) this.writeAttr(cell, "memory.swap.max", String(limits.swapMaxBytes))
    this.writeAttr(cell, "pids.max", String(limits.pidsMax))
    if (limits.ioWeight) this.writeAttr(cell, "io.weight", String(limits.ioWeight))
    if (limits.oomGroup !== false) {
      try {
        this.writeAttr(cell, "memory.oom.group", "1")
      } catch {
        // oom.group 不存在时降级（不失败）
      }
    }
    return cell
  }

  private enableControllers(path: string, controllers: string[]): void {
    const controlFile = join(path, "cgroup.subtree_control")
    if (!this.fs.exists(controlFile)) return
    let current = ""
    try {
      current = this.fs.read(controlFile)
    } catch {
      return
    }
    for (const controller of controllers) {
      if (current.includes(controller)) continue
      try {
        this.fs.write(controlFile, `+${controller}`)
      } catch {
        // controller 不可用 —— 降级（调用方按需 fail-closed）
      }
    }
  }

  /** 把进程放入 Cell。 */
  attach(pid: number, cellPath: string): void {
    this.writeAttr(cellPath, "cgroup.procs", String(pid))
  }

  /** 树级终止（plan §13.3：取消 Cell/Agent/Run = cgroup.kill）。 */
  kill(path: string): { killed: boolean } {
    const killFile = join(path, "cgroup.kill")
    if (!this.fs.exists(killFile)) return { killed: false }
    try {
      this.fs.write(killFile, "1")
      return { killed: true }
    } catch {
      return { killed: false }
    }
  }

  /** 进程计数。 */
  pidsCurrent(path: string): number {
    try {
      return Number(this.fs.read(join(path, "pids.current")).trim() || 0)
    } catch {
      return -1
    }
  }

  /** 内存当前用量。 */
  memoryCurrent(path: string): number {
    try {
      return Number(this.fs.read(join(path, "memory.current")).trim() || 0)
    } catch {
      return -1
    }
  }

  /** memory.events 关键事件（oom/oom_kill/watermark 达到）。 */
  memoryEvents(path: string): Record<string, number> {
    try {
      const out: Record<string, number> = {}
      for (const line of this.fs.read(join(path, "memory.events")).trim().split("\n")) {
        const [key, value] = line.split(/\s+/)
        if (key) out[key] = Number(value ?? 0)
      }
      return out
    } catch {
      return {}
    }
  }

  /** 移除 Cell（先 kill）。 */
  removeCell(cellPath: string): boolean {
    try {
      this.kill(cellPath)
      this.fs.rm(cellPath)
      return true
    } catch {
      return false
    }
  }

  /** 移除整个 run 子树（cleanup.ts 职责之一）。 */
  removeRun(runPath: string): boolean {
    try {
      this.kill(runPath)
      this.fs.rm(runPath)
      return true
    } catch {
      return false
    }
  }

  /** 本次实例创建的所有路径（泄漏检测/清理）。 */
  createdPaths(): string[] {
    return [...this.created]
  }
}
