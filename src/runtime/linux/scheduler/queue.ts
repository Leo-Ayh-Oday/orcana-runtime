/** LNXF-1.0: fair queue (LF-5, plan §12 公平性).
 *
 *  Run/agent weighted fair queue: interactive runs before background
 *  experiments, verification above low-priority analysis, no single agent
 *  can starve the rest, evolution experiments default to low priority,
 *  runs waiting on humans hold no resources.
 */

export type QueuePriority = "interactive" | "normal" | "analysis" | "verification" | "evolution" | "low"

export const PRIORITY_WEIGHT: Record<QueuePriority, number> = {
  interactive: 100,
  verification: 80,
  normal: 50,
  analysis: 30,
  low: 20,
  evolution: 10,
}

export interface QueueItem {
  id: string
  runId: string
  agentId?: string
  priority: QueuePriority
  /** 权重（同一 priority 内按 agent 公平）。 */
  weight: number
  enqueuedAt: number
}

export class FairQueue {
  private readonly items: QueueItem[] = []
  private readonly running = new Map<string, number>() // agentId → 运行中 cell 数

  enqueue(item: Omit<QueueItem, "enqueuedAt">): void {
    this.items.push({ ...item, enqueuedAt: Date.now() })
    this.items.sort((a, b) => {
      const wa = PRIORITY_WEIGHT[a.priority]
      const wb = PRIORITY_WEIGHT[b.priority]
      if (wa !== wb) return wb - wa
      return a.enqueuedAt - b.enqueuedAt
    })
  }

  /** 取队首（不删除）。 */
  peek(): QueueItem | undefined {
    return this.items[0]
  }

  /** 取并删除队首。 */
  dequeue(): QueueItem | undefined {
    return this.items.shift()
  }

  remove(id: string): boolean {
    const index = this.items.findIndex(i => i.id === id)
    if (index < 0) return false
    this.items.splice(index, 1)
    return true
  }

  /** 同一 agent 已排队数量（公平性：防单个 agent 占满）。 */
  countForAgent(agentId: string): number {
    return this.items.filter(i => i.agentId === agentId).length
  }

  /** 某 run 的排队数量。 */
  countForRun(runId: string): number {
    return this.items.filter(i => i.runId === runId).length
  }

  /** 人工等待中的 Run 不占资源：移除其排队项。 */
  removeRun(runId: string): number {
    const before = this.items.length
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i]!.runId === runId) this.items.splice(i, 1)
    }
    return before - this.items.length
  }

  size(): number {
    return this.items.length
  }

  /** 记录一次执行开始（agent 运行中计数 +1）。 */
  begin(item: QueueItem): void {
    const agent = item.agentId ?? ""
    this.running.set(agent, (this.running.get(agent) ?? 0) + 1)
  }

  /** 记录一次执行结束（agent 运行中计数 -1）。 */
  finish(item: QueueItem): void {
    const agent = item.agentId ?? ""
    const current = (this.running.get(agent) ?? 0) - 1
    if (current <= 0) this.running.delete(agent)
    else this.running.set(agent, current)
  }

  /**
   * 下一个可执行项（公平性）：跳过运行中计数已达 maxPerAgent 的 agent，
   * 其余按优先级/入队序。全部超限时退回队首（不会死锁）。
   */
  nextWithinAgentLimit(maxPerAgent: number): QueueItem | undefined {
    for (const item of this.items) {
      const agent = item.agentId ?? ""
      if ((this.running.get(agent) ?? 0) < maxPerAgent) return item
    }
    return this.items[0]
  }

  /** 取出并移除下一个可执行项（nextWithinAgentLimit + remove）。 */
  takeWithinAgentLimit(maxPerAgent: number): QueueItem | undefined {
    const item = this.nextWithinAgentLimit(maxPerAgent)
    if (!item) return undefined
    this.remove(item.id)
    return item
  }

  /** 清空运行中计数（Run 结束）。 */
  resetRunning(): void {
    this.running.clear()
  }
}
