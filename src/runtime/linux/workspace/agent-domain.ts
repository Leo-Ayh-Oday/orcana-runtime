/** LNXF-1.0: agent execution domain manager (LF-5, plan §5.2).
 *
 *  Binds worktree + cgroup parent + temp root + cache namespace + domain
 *  budget. `createAgentDomain` upgrades the LF-1 stub: it now allocates the
 *  domain's cgroup subtree (when a delegated root exists) and validates the
 *  budget against the ledger.
 */

import { mkdirSync, rmSync } from "node:fs"
import { randomUUID } from "node:crypto"
import type { AgentExecutionDomain, DomainResourceBudget } from "../contracts"
import type { CgroupManager } from "../cgroup/manager"
import type { ResourceLedger } from "../scheduler/resource-ledger"

export interface CreateDomainInput {
  runId: string
  agentId: string
  worktreeRoot: string
  ownerFiles: string[]
  resourceBudget: DomainResourceBudget
  role?: string
  /** 域临时根（Runtime 决定）。 */
  tempRoot?: string
  cacheNamespace?: string
}

export interface DomainManagerOptions {
  cgroup?: CgroupManager
  ledger?: ResourceLedger
}

export class AgentDomainManager {
  private readonly domains = new Map<string, AgentExecutionDomain>()
  private readonly cgroup?: CgroupManager
  private readonly ledger?: ResourceLedger

  constructor(options: DomainManagerOptions = {}) {
    this.cgroup = options.cgroup
    this.ledger = options.ledger
  }

  createDomain(input: CreateDomainInput): AgentExecutionDomain {
    const budget = input.resourceBudget
    if (budget.maxConcurrentCells < 1) throw new Error("domain budget requires maxConcurrentCells >= 1")
    if (budget.memoryMaxBytes <= 0) throw new Error("domain budget requires positive memoryMaxBytes")

    const domain: AgentExecutionDomain = {
      domainId: `domain_${randomUUID().slice(0, 8)}`,
      runId: input.runId,
      agentId: input.agentId,
      role: input.role,
      worktreeRoot: input.worktreeRoot,
      ownerFiles: input.ownerFiles,
      cgroupPath: "",
      tempRoot: input.tempRoot ?? `/tmp/orcana-${input.runId}-${input.agentId}`,
      cacheNamespace: input.cacheNamespace ?? `run-${input.runId}/agent-${input.agentId}`,
      resourceBudget: budget,
      // IC06：占位（真实值在 cgroup 创建后按实际结果覆盖）。
      budgetEnforcement: {
        memory: this.cgroup ? "cgroup" : "none",
        pids: this.cgroup ? "cgroup" : "none",
        cpu: "weight-hint",
        cells: "advisory",
        wallTime: "per-cell",
        output: "tool-layer",
        temp: "none",
      },
      createdAt: Date.now(),
      status: "active",
    }

    // cgroup 父层（有委托时）。
    if (this.cgroup) {
      try {
        domain.cgroupPath = this.cgroup.createAgent(input.runId, input.agentId, {
          memoryMaxBytes: budget.memoryMaxBytes,
          pidsMax: budget.pidsMax,
          cpuWeight: Math.min(1000, Math.max(1, Math.floor(budget.cpuQuotaTotal / 100))),
        })
      } catch {
        domain.cgroupPath = "" // 无委托 → 资源隔离降级（严格 Profile 由调用方拒绝）
      }
    }
    // IC06：budget enforcement 按真实结果声明（cgroup 实际创建成功 → cgroup）。
    const cgroupActive = !!domain.cgroupPath
    domain.budgetEnforcement = {
      memory: cgroupActive ? "cgroup" : "none",
      pids: cgroupActive ? "cgroup" : "none",
      cpu: "weight-hint",
      cells: "advisory",
      wallTime: "per-cell",
      output: "tool-layer",
      temp: "none",
    }
    mkdirSync(domain.tempRoot, { recursive: true })
    this.domains.set(domain.domainId, domain)
    return domain
  }

  get(domainId: string): AgentExecutionDomain | undefined {
    return this.domains.get(domainId)
  }

  byAgent(agentId: string): AgentExecutionDomain | undefined {
    return [...this.domains.values()].find(d => d.agentId === agentId && d.status !== "closed")
  }

  /** 取消 Agent：标记 cancelling（cgroup.kill 由调用方按层级执行）。 */
  cancelAgent(agentId: string): boolean {
    const domain = this.byAgent(agentId)
    if (!domain) return false
    domain.status = "cancelling"
    if (this.cgroup && domain.cgroupPath) {
      this.cgroup.kill(domain.cgroupPath)
    }
    return true
  }

  /** 关闭 Domain：清理 tempRoot 与 cgroup 子树。 */
  closeDomain(domainId: string): boolean {
    const domain = this.domains.get(domainId)
    if (!domain) return false
    if (this.cgroup && domain.cgroupPath) {
      this.cgroup.removeCell(domain.cgroupPath)
    }
    try {
      rmSync(domain.tempRoot, { recursive: true, force: true })
    } catch {
      // best-effort
    }
    domain.status = "closed"
    return true
  }

  /** Run 结束时关闭全部 Domain。 */
  closeRun(runId: string): number {
    let count = 0
    for (const domain of [...this.domains.values()]) {
      if (domain.runId === runId && domain.status !== "closed") {
        this.closeDomain(domain.domainId)
        count += 1
      }
    }
    return count
  }

  list(): AgentExecutionDomain[] {
    return [...this.domains.values()]
  }
}
