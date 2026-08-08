/** LR2-1（L1-E）：LeaseManager —— 运行租约（Acquire/Renew/Release/过期）。
 *
 *  - 租约持有期间 Run 不被回收（客户端心跳）；
 *  - 过期扫描：超时未续期 → 标记过期（Run 可回收）；
 *  - Lease 到期 ≠ 立即盲杀（LR2-5 原则）：v1 只标记过期并广播事件，
 *    回收策略由上层（Run Manager/Service Cell）决定。
 */

import { StateStore } from "./state/store"

export interface LeaseManagerOptions {
  state: StateStore
  /** 过期广播（server.publishEvent）。 */
  onExpired: (leaseId: string, runId: string) => void
  now?: () => number
}

export interface AcquiredLease {
  leaseId: string
  runId: string
  expiresAt: number
}

export class LeaseManager {
  constructor(private readonly opts: LeaseManagerOptions) {}

  private get now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  acquire(runId: string, ttlMs: number): AcquiredLease {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error(`invalid ttlMs: ${ttlMs}`)
    const leaseId = `lease-${this.now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const expiresAt = this.now + ttlMs
    this.opts.state.insertLease({ leaseId, runId, holder: "client", ttlMs, expiresAt, createdAt: this.now })
    return { leaseId, runId, expiresAt }
  }

  renew(leaseId: string, ttlMs: number): { expiresAt: number } | undefined {
    const lease = this.opts.state.getLease(leaseId)
    if (!lease || lease.releasedAt !== null) return undefined
    const expiresAt = this.now + ttlMs
    this.opts.state.updateLeaseExpiry(leaseId, expiresAt)
    return { expiresAt }
  }

  release(leaseId: string): void {
    this.opts.state.releaseLease(leaseId, this.now)
  }

  /** 扫描并标记过期租约（返回本次过期的）。
   *  过期即失效：广播后释放（不再 active）—— sweep 幂等，重复扫描不重复
   *  广播；过期后的 renew 返回 undefined。Lease 到期 ≠ 立即盲杀：回收
   *  策略由上层（Run Manager/Service Cell）决定（LR2-5 原则）。 */
  sweepExpired(): Array<{ leaseId: string; runId: string }> {
    const expired: Array<{ leaseId: string; runId: string }> = []
    for (const lease of this.opts.state.listActiveLeases()) {
      if (lease.expiresAt <= this.now) {
        expired.push({ leaseId: lease.leaseId, runId: lease.runId })
        this.opts.onExpired(lease.leaseId, lease.runId)
        this.opts.state.releaseLease(lease.leaseId, this.now)
      }
    }
    return expired
  }
}
