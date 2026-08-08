/** LR2-3（P3-D）：公平性扩展 —— Run-level WFQ + Evolution 硬配额 +
 *  Interactive 保留槽位（叠加 FairQueue 的 agent 公平）。
 *
 *  不变量（计划 §7.6）：
 *  - 不能让一个大型测试 Run 占满所有 Cell slot（STARVATION_BY_RUN）；
 *  - Evolution 实验硬配额（EVOLUTION_QUOTA_EXCEEDED = 0）；
 *  - 交互任务始终有保留槽位。
 */

import { FairQueue, PRIORITY_WEIGHT, type QueueItem, type QueuePriority } from "./queue"

export interface FairnessConfig {
  /** 总并发槽位。 */
  totalSlots: number
  /** 单 Run 最大占用槽位比例（≤1）。 */
  maxRunShare: number
  /** Evolution 硬配额（同时运行上限）。 */
  evolutionQuota: number
  /** 交互保留槽位（始终可用）。 */
  interactiveReserved: number
}

export const DEFAULT_FAIRNESS: FairnessConfig = {
  totalSlots: 6,
  maxRunShare: 0.5,
  evolutionQuota: 1,
  interactiveReserved: 1,
}

export interface FairnessDecision {
  /** 允许启动的候选（按优先级排序）。 */
  allowed: QueueItem | undefined
  denied: QueueItem | undefined
  /** 拒绝原因（决策日志）。 */
  reason?: string
}

export class RunFairnessScheduler {
  private readonly queue = new FairQueue()
  /** 当前运行的 cell（runId → 数量 + 优先级分布）。 */
  private readonly running = new Map<string, { count: number; evolution: number; interactive: number }>()

  constructor(private readonly config: FairnessConfig = DEFAULT_FAIRNESS) {}

  enqueue(item: Omit<QueueItem, "enqueuedAt">): void {
    this.queue.enqueue(item)
  }

  /** 标记 cell 开始运行。 */
  markRunning(item: QueueItem): void {
    const entry = this.running.get(item.runId) ?? { count: 0, evolution: 0, interactive: 0 }
    entry.count += 1
    if (item.priority === "evolution") entry.evolution += 1
    if (item.priority === "interactive") entry.interactive += 1
    this.running.set(item.runId, entry)
    this.queue.remove(item.id)
  }

  /** 标记 cell 结束。 */
  markFinished(runId: string): void {
    const entry = this.running.get(runId)
    if (!entry) return
    entry.count -= 1
    if (entry.count <= 0) this.running.delete(runId)
    else this.running.set(runId, entry)
  }

  get runningCount(): number {
    return [...this.running.values()].reduce((a, b) => a + b.count, 0)
  }

  /** 下一次调度决策（可解释拒绝原因）。
   *  B1 修复（LR2-3 审核）：按优先级遍历队列，返回**第一个全部门禁通过**
   *  的项 —— 队首被拒（份额/配额/保留槽）时越过它继续扫描，不再阻塞
   *  其后可调度的项（STARVATION_BY_RUN 真正生效）。 */
  next(): FairnessDecision {
    const runningTotal = this.runningCount
    if (runningTotal >= this.config.totalSlots) {
      const head = this.queue.peek()
      return { allowed: undefined, denied: head, reason: `total slots full (${runningTotal}/${this.config.totalSlots})` }
    }
    const remaining = this.config.totalSlots - runningTotal
    const evolutionRunning = [...this.running.values()].reduce((a, b) => a + b.evolution, 0)
    const shareCap = Math.max(1, Math.floor(this.config.totalSlots * this.config.maxRunShare))

    for (let i = 0; i < this.queue.size(); i++) {
      const candidate = this.queue.at(i)
      if (!candidate) break
      const runEntry = this.running.get(candidate.runId)

      // 2. 交互保留：剩余槽位 ≤ reserved 时只允许 interactive
      if (remaining <= this.config.interactiveReserved && candidate.priority !== "interactive") {
        continue
      }
      // 3. Evolution 硬配额
      if (candidate.priority === "evolution" && evolutionRunning >= this.config.evolutionQuota) {
        continue
      }
      // 4. Run 级公平（maxRunShare）
      if (runEntry && runEntry.count >= shareCap) {
        continue
      }
      // 通过全部闸门 → 调度（dequeue 该 id）
      const allowed = this.queue.remove(candidate.id) ? candidate : undefined
      if (allowed) return { allowed, denied: undefined }
      continue
    }
    // 全部被拒：返回队首 + 首个拒绝原因（决策日志）
    const head = this.queue.peek()
    if (!head) return { allowed: undefined, denied: undefined }
    const headEntry = this.running.get(head.runId)
    let reason = "no schedulable item passed all gates"
    if (remaining <= this.config.interactiveReserved && head.priority !== "interactive") reason = `interactive reserved slots (${remaining} left)`
    else if (head.priority === "evolution" && evolutionRunning >= this.config.evolutionQuota) reason = `evolution quota (${evolutionRunning}/${this.config.evolutionQuota})`
    else if (headEntry && headEntry.count >= shareCap) reason = `run ${head.runId} at share cap (${headEntry.count})`
    return { allowed: undefined, denied: head, reason }
  }

  /** 当前运行统计（决策日志）。 */
  snapshot(): { running: Array<{ runId: string; count: number }>; total: number } {
    return {
      running: [...this.running.entries()].map(([runId, e]) => ({ runId, count: e.count })),
      total: this.runningCount,
    }
  }

  /** Evolution 优先级权重（与 queue.ts 一致）。 */
  static priorityWeight(priority: QueuePriority): number {
    return PRIORITY_WEIGHT[priority]
  }
}
