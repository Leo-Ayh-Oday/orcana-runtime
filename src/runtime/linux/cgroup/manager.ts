/** LNXF-1.0: cgroup v2 hierarchy + manager (LF-4, plan §11.1–11.4).
 *
 *  Hierarchy: base → orcana.scope → run-<runId> → {agent-<id>, system} → cell-<id>.
 *  Cell-level controllers: cpu.max, cpu.weight, memory.high/max,
 *  memory.swap.max, memory.oom.group, pids.max, io.weight. Cancellation =
 *  cgroup.kill (tree). The filesystem layer is injectable so the full
 *  lifecycle is testable without a delegated cgroup.
 *
 *  PR-5：移除协议 = cgroupfs 生命周期（kill → 验证 populated=0 → rmdir），
 *  禁止用普通递归文件删除代替；子层 controller 由父层 subtree_control 授权
 *  （v2 语义），或cana.scope 在委托点显式创建。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { sleep } from "../process/termination"

export interface CgroupFs {
  exists(path: string): boolean
  read(path: string): string
  write(path: string, content: string): void
  mkdir(path: string): void
  /** 非递归 rmdir —— cgroup 生命周期协议；目录必须已空且无进程。 */
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
    rmdir(path)
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
function rmdir(path: string): void {
  rmdirSync(path)
}
function readdir(path: string): string[] {
  return readdirSync(path)
}

/** populated=0 等待上限（kill 后进程退出轮询；默认最多 500ms）。 */
export const POPULATED_WAIT_ATTEMPTS = 20
export const POPULATED_WAIT_MS = 25

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
  readonly fs: CgroupFs
  readonly base: string
  private readonly created: string[] = []

  constructor(options: CgroupManagerOptions) {
    this.base = options.base
    this.fs = options.fs ?? REAL_CGROUP_FS
    // PR-5：委托点显式创建 orcana.scope 并授权父级 subtree_control。
    this.ensureScope()
  }

  /** LNXF-R2 10.4：scope 授权失败的降级标记（真实委托下不应发生；
   *  createRun 等会 fail loudly）。 */
  private delegationBroken = false

  /** 委托点创建 orcana.scope + 启用 base 的 subtree_control（v2 授权）。
   *  LNXF-R2 10.4：base/scope 授权失败不抛（构造器不可抛，避免 broker
   *  整体起不来）—— 标记降级，后续 createRun 等经 requireControllers
   *  fail loudly。 */
  private ensureScope(): void {
    const scope = join(this.base, "orcana.scope")
    const baseResult = this.enableControllers(this.base, ["cpu", "memory", "pids"])
    this.ensure(scope)
    const scopeResult = this.enableControllers(scope, ["cpu", "memory", "pids"])
    if (baseResult.failed.length > 0 || scopeResult.failed.length > 0) {
      this.delegationBroken = true
    }
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

  /** 创建 Run 层（全局取消点 + 树级取消；聚合预算由上层 AgentDomain 提供）。 */
  createRun(runId: string, limits: Partial<CellLimits> = {}): string {
    if (this.delegationBroken) {
      throw new Error("CGROUP_DELEGATION_UNAVAILABLE: scope delegation failed at construction")
    }
    const { run } = hierarchyPaths(this.base, runId, undefined, "x")
    this.ensure(run)
    // PR-5：controller 在父层（scope）授权后，run 层再授权给 agent 层。
    this.requireControllers(run, ["cpu", "memory", "pids"], "run")
    if (limits.memoryMaxBytes) this.writeAttr(run, "memory.max", String(limits.memoryMaxBytes))
    if (limits.pidsMax) this.writeAttr(run, "pids.max", String(limits.pidsMax))
    if (limits.cpuQuotaMicros && limits.cpuPeriodMicros) {
      this.writeAttr(run, "cpu.max", `${limits.cpuQuotaMicros} ${limits.cpuPeriodMicros}`)
    }
    return run
  }

  /** 创建 Agent 层（Domain 聚合预算；无预算时不设限）。 */
  createAgent(runId: string, agentId: string, limits: Partial<CellLimits> = {}): string {
    if (this.delegationBroken) {
      throw new Error("CGROUP_DELEGATION_UNAVAILABLE: scope delegation failed at construction")
    }
    const { agent } = hierarchyPaths(this.base, runId, agentId, "x")
    this.ensure(agent)
    // PR-5：agent 层授权 cell 层使用 controller。
    this.requireControllers(agent, ["cpu", "memory", "pids"], "agent")
    if (limits.memoryMaxBytes) this.writeAttr(agent, "memory.max", String(limits.memoryMaxBytes))
    if (limits.pidsMax) this.writeAttr(agent, "pids.max", String(limits.pidsMax))
    if (limits.cpuWeight) this.writeAttr(agent, "cpu.weight", String(limits.cpuWeight))
    return agent
  }

  /** 创建 Cell 层（完整限制；叶子目录无需 subtree_control）。
   *  agentId=undefined 时 cell 挂在 system 层 —— 必须先授权 system 的
   *  subtree_control，真实内核下 cell 才会带 memory/pids 属性
   *  （mock fs 自动补全掩盖此路径；2026-08-07 委托根修复后实测暴露）。
   *  agentId 已由 createAgent 授权时此处幂等。 */
  createCell(runId: string, agentId: string | undefined, cellId: string, limits: CellLimits): string {
    const paths = hierarchyPaths(this.base, runId, agentId, cellId)
    this.ensure(paths.agent)
    // LNXF-R2 10.4：授权失败立即暴露（独立调用 createCell 而未先
    // createRun/createAgent 时，agent 层 enable 因父层未授权 EINVAL
    // → CGROUP_CONTROLLER_UNAVAILABLE，不再静默吞错）。
    this.requireControllers(paths.agent, ["cpu", "memory", "pids"], "cell.agent")
    this.ensure(paths.cell)
    const cell = paths.cell
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

  /** 在父目录启用 controller 授权（v2：子目录使用某 controller 需父目录授权）。
   *  LNXF-R2 10.4：不再静默吞错 —— 返回每个控制器的启用结果，调用方
   *  fail loudly（此前 EINVAL 被 catch 吞掉，cell 层 memory.max 属性缺失
   *  只报误导性的 "attribute missing"；token 精确匹配消除 cpuset 误判）。 */
  private enableControllers(path: string, controllers: string[]): { enabled: string[]; failed: string[] } {
    const controlFile = join(path, "cgroup.subtree_control")
    if (!this.fs.exists(controlFile)) {
      // 非真实 cgroupfs（mock/未委托）—— 调用方按上下文处理
      return { enabled: [], failed: [] }
    }
    let current = ""
    try {
      current = this.fs.read(controlFile)
    } catch {
      return { enabled: [], failed: [...controllers] }
    }
    const tokens = current.split(/\s+/).filter(Boolean)
    const enabled: string[] = []
    const failed: string[] = []
    for (const controller of controllers) {
      if (tokens.includes(controller)) {
        enabled.push(controller)
        continue
      }
      try {
        this.fs.write(controlFile, `+${controller}`)
        enabled.push(controller)
      } catch {
        failed.push(controller)
      }
    }
    return { enabled, failed }
  }

  /** 授权失败即抛（LNXF-R2 10.4 fail-loud：中间层未授权/控制器不可用
   *  立即暴露，不再等 cell 属性缺失才报错）。 */
  private requireControllers(path: string, controllers: string[], stage: string): void {
    const result = this.enableControllers(path, controllers)
    if (result.failed.length > 0) {
      throw new Error(`CGROUP_CONTROLLER_UNAVAILABLE: ${stage} enable failed on ${path}: ${result.failed.join(",")}`)
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

  /** 等待 populated=0（kill 后进程退出；超时返回 false）。 */
  waitEmpty(path: string): boolean {
    for (let i = 0; i < POPULATED_WAIT_ATTEMPTS; i++) {
      const current = this.pidsCurrent(path)
      if (current === 0) return true
      if (current < 0) return false
      sleep(POPULATED_WAIT_MS)
    }
    return this.pidsCurrent(path) === 0
  }

  /** 枚举 cgroup 子树目录（cgroup 目录 = 含 cgroup.procs 的路径）。 */
  private collectSubtreeDirs(root: string): string[] {
    const dirs: string[] = [root]
    const walk = (dir: string): void => {
      let children: string[] = []
      try {
        children = this.fs.readdir(dir)
      } catch {
        return
      }
      for (const name of children) {
        const child = join(dir, name)
        if (this.fs.exists(join(child, "cgroup.procs"))) {
          dirs.push(child)
          walk(child)
        }
      }
    }
    walk(root)
    return dirs
  }

  /** 移除 Cell：kill → populated=0 → rmdir（PR-5 生命周期协议）。 */
  removeCell(cellPath: string): boolean {
    try {
      this.kill(cellPath)
      if (!this.waitEmpty(cellPath)) return false
      this.fs.rm(cellPath)
      return true
    } catch {
      return false
    }
  }

  /** 移除整个 run 子树：树级 kill → 自底向上 populated=0 + rmdir。 */
  removeRun(runPath: string): boolean {
    try {
      this.kill(runPath)
      // 自底向上：先删最深目录（必须等待各级 populated=0）。
      const dirs = this.collectSubtreeDirs(runPath).sort((a, b) => b.length - a.length)
      for (const dir of dirs) {
        if (!this.waitEmpty(dir)) return false
        this.fs.rm(dir)
      }
      return true
    } catch {
      return false
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

  /** 本次实例创建的所有路径（泄漏检测/清理）。 */
  createdPaths(): string[] {
    return [...this.created]
  }
}
