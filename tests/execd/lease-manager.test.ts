/** LR2-1（L1-E）：LeaseManager 验收 —— 获取/续期/释放/过期扫描。 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LeaseManager } from "../../src/execd/lease-manager"
import { StateStore } from "../../src/execd/state/store"

describe("LeaseManager (L1-E)", () => {
  test("acquire → renew → release lifecycle", () => {
    const dir = mkdtempSync(join(tmpdir(), "execd-lease-"))
    const state = new StateStore(join(dir, "execd.db"))
    const expired: string[] = []
    const mgr = new LeaseManager({ state, onExpired: (leaseId) => expired.push(leaseId) })
    try {
      const l = mgr.acquire("run-1", 1000)
      expect(l.leaseId).toContain("lease-")
      expect(state.getLease(l.leaseId)!.expiresAt).toBeGreaterThan(Date.now())
      const renewed = mgr.renew(l.leaseId, 5000)
      expect(renewed!.expiresAt).toBeGreaterThan(l.expiresAt)
      mgr.release(l.leaseId)
      expect(mgr.renew(l.leaseId, 1000)).toBeUndefined() // 已释放不可续
      expect(expired).toHaveLength(0)
    } finally {
      state.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("invalid ttl rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "execd-lease-"))
    const state = new StateStore(join(dir, "execd.db"))
    const mgr = new LeaseManager({ state, onExpired: () => {} })
    try {
      expect(() => mgr.acquire("r", 0)).toThrow(/ttlMs/)
    } finally {
      state.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("expired leases are swept exactly once", () => {
    const dir = mkdtempSync(join(tmpdir(), "execd-lease-"))
    const state = new StateStore(join(dir, "execd.db"))
    const expired: string[] = []
    let now = 1000
    const mgr = new LeaseManager({ state, onExpired: (leaseId) => expired.push(leaseId), now: () => now })
    try {
      const l = mgr.acquire("run-1", 1000) // expiresAt = 2000
      now = 1500
      expect(mgr.sweepExpired()).toHaveLength(0) // 未到期
      now = 2500
      const swept = mgr.sweepExpired()
      expect(swept.map(s => s.leaseId)).toEqual([l.leaseId])
      expect(expired).toEqual([l.leaseId])
      // 过期即失效：lease 已释放，sweep 幂等（重复扫描不再广播），renew 失败。
      expect(mgr.sweepExpired()).toHaveLength(0)
      expect(expired).toHaveLength(1)
      expect(mgr.renew(l.leaseId, 1000)).toBeUndefined()
    } finally {
      state.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
