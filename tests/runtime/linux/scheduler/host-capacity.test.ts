/** IC06: HostCapacityAuthority 单测 —— idempotency / token custody / restart
 *  rekey / release reality / reconcile / double-acquire。 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHostCapacityAuthority, type ClientPrincipal, type CapacityClaimView, type ClaimReality } from "../../../../src/runtime/linux/scheduler/host-capacity"

function tmpDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "ic06-capacity-"))
  return { dir, dbPath: join(dir, "capacity.db") }
}

function principal(seed: number, instance = "cli-a"): ClientPrincipal {
  return { uid: 1000, pid: 1000 + seed, startticks: 100 + seed, clientInstanceId: instance }
}

const req = { request: { cpuQuota: 100, memoryBytes: 64 * 1024, pids: 8, ioWeight: 0, networkSlots: 0, tempBytes: 1024 }, runId: "r1", cellId: "c1", agentId: "a1", backendId: "host-audit" }

function liveReality(): (c: CapacityClaimView) => Promise<ClaimReality> {
  return async () => ({ state: "live", evidence: "fake-live" })
}
function provenReality(): (c: CapacityClaimView) => Promise<ClaimReality> {
  return async () => ({ state: "proven", evidence: "fake-proven" })
}

describe("IC06 host capacity authority", () => {
  test("R65/R66: reserve idempotent — same key returns same claim (rekey), no second claim", async () => {
    const { dir, dbPath } = tmpDb()
    try {
      const auth = createHostCapacityAuthority({ dbPath, capacityOverride: { cpuQuota: 1000, memoryBytes: 10 * 1024 * 1024 }, reality: liveReality() })
      const p = principal(1)
      const a = await auth.reserve(req, "key-1", p)
      expect(a.ok).toBe(true)
      if (!a.ok) return
      const b = await auth.reserve(req, "key-1", p)
      expect(b.ok).toBe(true)
      if (!b.ok) return
      expect(b.claimId).toBe(a.claimId) // same claim
      expect(b.ownerToken).not.toBe(a.ownerToken) // token rekey
      const st = await auth.status(p)
      expect(st.charged).toBe(1) // 无第二 claim
      await auth.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("R80: execd restart — same logical retry returns same claimId + rekeyed token", async () => {
    const { dir, dbPath } = tmpDb()
    try {
      const auth1 = createHostCapacityAuthority({ dbPath, capacityOverride: { cpuQuota: 1000, memoryBytes: 10 * 1024 * 1024 }, reality: liveReality() })
      const p = principal(2)
      const a = await auth1.reserve(req, "key-2", p)
      expect(a.ok).toBe(true)
      if (!a.ok) return
      await auth1.close() // crash 等价：进程退出，内存 token 丢失

      const auth2 = createHostCapacityAuthority({ dbPath, capacityOverride: { cpuQuota: 1000, memoryBytes: 10 * 1024 * 1024 }, reality: liveReality() })
      const b = await auth2.reserve(req, "key-2", p)
      expect(b.ok).toBe(true)
      if (!b.ok) return
      expect(b.claimId).toBe(a.claimId) // LOST_RESPONSE_RESTART_DOUBLE_CLAIM=0
      expect(b.ownerToken).not.toBe(a.ownerToken) // 新 token 合法（hash rekey）
      // 旧 token 失效：restart 前 token 无法 release
      const old = await auth2.releaseRequested(a.claimId, a.ownerToken)
      expect(old.state).toBe("REJECTED")
      // 新 token + spawn identity + live reality → QUARANTINED（REVERSE_GHOST 不 free）
      await auth2.updatePhase(a.claimId, b.ownerToken, "EXECUTING", { pid: 4241, startticks: 111 })
      const rel = await auth2.releaseRequested(a.claimId, b.ownerToken)
      expect(rel.state).toBe("QUARANTINED")
      const st = await auth2.status(p)
      expect(st.charged).toBe(1) // live resource → 保持 charged
      await auth2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("R81: idempotency cross-client — B using A's key never receives A's claim/token", async () => {
    const { dir, dbPath } = tmpDb()
    try {
      const auth = createHostCapacityAuthority({ dbPath, capacityOverride: { cpuQuota: 1000, memoryBytes: 10 * 1024 * 1024 }, reality: liveReality() })
      const pA = principal(3, "client-a")
      const pB = principal(4, "client-b")
      const a = await auth.reserve(req, "key-3", pA)
      expect(a.ok).toBe(true)
      if (!a.ok) return
      // B 用 A 的 key：principal 不同 → 不命中 A 的幂等记录；同 (run/cell)
      // 有 active claim → 拒绝（B 绝不拿到 A 的 claim/token）
      const b = await auth.reserve(req, "key-3", pB)
      expect(b.ok).toBe(false)
      if (!b.ok) expect(b.reason).toContain("RESOURCE_DOUBLE_ACQUIRE")
      // B 不能 release A 的 claim（无 A token）
      const rel = await auth.releaseRequested(a.claimId, "b-token")
      expect(rel.state).toBe("REJECTED")
      await auth.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("R82: same key + different request digest → IDEMPOTENCY_MISMATCH (fail closed)", async () => {
    const { dir, dbPath } = tmpDb()
    try {
      const auth = createHostCapacityAuthority({ dbPath, capacityOverride: { cpuQuota: 1000, memoryBytes: 10 * 1024 * 1024 }, reality: liveReality() })
      const p = principal(5)
      const a = await auth.reserve(req, "key-4", p)
      expect(a.ok).toBe(true)
      if (!a.ok) return
      const b = await auth.reserve({ ...req, request: { ...req.request, cpuQuota: 999 } }, "key-4", p)
      expect(b.ok).toBe(false)
      if (!b.ok) expect(b.reason).toContain("IDEMPOTENCY_MISMATCH")
      await auth.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("R69: owner token custody — wrong token rejected; token never in status view", async () => {
    const { dir, dbPath } = tmpDb()
    try {
      const auth = createHostCapacityAuthority({ dbPath, capacityOverride: { cpuQuota: 1000, memoryBytes: 10 * 1024 * 1024 }, reality: liveReality() })
      const p = principal(6)
      const a = await auth.reserve(req, "key-5", p)
      expect(a.ok).toBe(true)
      if (!a.ok) return
      const rel = await auth.releaseRequested(a.claimId, "forged-token")
      expect(rel.state).toBe("REJECTED")
      const st = await auth.status(p)
      const serialized = JSON.stringify(st)
      expect(serialized).not.toContain(a.ownerToken) // token 不出现在状态视图
      expect(serialized).not.toContain("tok_")
      await auth.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("R75: REVERSE GHOST — release request with live resource → QUARANTINED, capacity stays charged", async () => {
    const { dir, dbPath } = tmpDb()
    try {
      const auth = createHostCapacityAuthority({ dbPath, capacityOverride: { cpuQuota: 1000, memoryBytes: 10 * 1024 * 1024 }, reality: liveReality() })
      const p = principal(7)
      const a = await auth.reserve(req, "key-6", p)
      expect(a.ok).toBe(true)
      if (!a.ok) return
      await auth.updatePhase(a.claimId, a.ownerToken, "SPAWN_IDENTITY_COMMITTED", { pid: 4242, startticks: 123 })
      const rel = await auth.releaseRequested(a.claimId, a.ownerToken)
      expect(rel.state).toBe("QUARANTINED") // 进程仍活 → 不 free
      const st = await auth.status(p)
      expect(st.charged).toBe(1)
      await auth.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("R71: reconcile — server-side reality (proven) frees; client cannot forge", async () => {
    const { dir, dbPath } = tmpDb()
    try {
      const auth = createHostCapacityAuthority({ dbPath, capacityOverride: { cpuQuota: 1000, memoryBytes: 10 * 1024 * 1024 }, reality: provenReality() })
      const p = principal(8)
      const a = await auth.reserve(req, "key-7", p)
      expect(a.ok).toBe(true)
      if (!a.ok) return
      await auth.updatePhase(a.claimId, a.ownerToken, "EXECUTING", { pid: 4243, startticks: 456 })
      const report = await auth.reconcile(p)
      expect(report.freed).toBe(1)
      const st = await auth.status(p)
      expect(st.charged).toBe(0) // proven → RELEASED → free
      await auth.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("R83: double acquire — second reserve for same run/cell rejected (authority-side dedup)", async () => {
    const { dir, dbPath } = tmpDb()
    try {
      const auth = createHostCapacityAuthority({ dbPath, capacityOverride: { cpuQuota: 1000, memoryBytes: 10 * 1024 * 1024 }, reality: provenReality() })
      const p = principal(9)
      const a = await auth.reserve(req, "key-8", p)
      expect(a.ok).toBe(true)
      if (!a.ok) return
      // 模拟 scheduler claim + broker second claim（不同 key，同 run/cell）
      const b = await auth.reserve(req, "key-8-broker", p)
      expect(b.ok).toBe(false)
      if (!b.ok) expect(b.reason).toContain("RESOURCE_DOUBLE_ACQUIRE")
      await auth.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("R70: restart — QUARANTINED claim survives restart, no automatic free", async () => {
    const { dir, dbPath } = tmpDb()
    try {
      const auth1 = createHostCapacityAuthority({ dbPath, capacityOverride: { cpuQuota: 1000, memoryBytes: 10 * 1024 * 1024 }, reality: liveReality() })
      const p = principal(10)
      const a = await auth1.reserve(req, "key-9", p)
      expect(a.ok).toBe(true)
      if (!a.ok) return
      await auth1.updatePhase(a.claimId, a.ownerToken, "EXECUTING", { pid: 4244, startticks: 789 })
      await auth1.releaseRequested(a.claimId, a.ownerToken)
      await auth1.close()

      const auth2 = createHostCapacityAuthority({ dbPath, capacityOverride: { cpuQuota: 1000, memoryBytes: 10 * 1024 * 1024 }, reality: liveReality() })
      const st = await auth2.status(p)
      expect(st.charged).toBe(1) // 不自动 free（OWNER_TOKEN_RESTART_UNDERCOUNT=0）
      const c = st.claims[0]!
      expect(c.phase).toBe("QUARANTINED")
      await auth2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("R73: fake authority socket — verifyAuthoritySocket rejects when no orcana-execd owner", async () => {
    const { verifyAuthoritySocket } = await import("../../../../src/runtime/linux/scheduler/host-capacity")
    const res = verifyAuthoritySocket(join(tmpdir(), "ic06-nonexistent.sock"))
    expect(res.ok).toBe(false)
  })
})
