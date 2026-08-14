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

  // ── IC06 审核修复回归（P1-1 / P1-3 / P1-4）──

  test("P1-1: reconcile reclaims orphaned RESERVED/PRE_SPAWN claims (crash between reserve and spawn)", async () => {
    const { dir, dbPath } = tmpDb()
    try {
      const auth = createHostCapacityAuthority({ dbPath, capacityOverride: { cpuQuota: 1000, memoryBytes: 10 * 1024 * 1024 }, reality: liveReality() })
      const p = principal(11)
      // 模拟 broker 崩溃于 reserve ACK 后（claim 停在 RESERVED，无 spawn identity）。
      const a = await auth.reserve(req, "key-p11", p)
      expect(a.ok).toBe(true)
      if (!a.ok) return
      const report = await auth.reconcile(p)
      expect(report.freed).toBe(1)
      const st = await auth.status(p)
      expect(st.charged).toBe(0) // 崩溃孤儿被回收，容量不再永久泄漏
      await auth.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("P1-1b: reconcile keeps SPAWN_ATTEMPTING without identity as SUSPECT (conservative, stays charged)", async () => {
    const { dir, dbPath } = tmpDb()
    try {
      const auth = createHostCapacityAuthority({ dbPath, capacityOverride: { cpuQuota: 1000, memoryBytes: 10 * 1024 * 1024 }, reality: liveReality() })
      const p = principal(12)
      const a = await auth.reserve(req, "key-p12", p)
      expect(a.ok).toBe(true)
      if (!a.ok) return
      await auth.updatePhase(a.claimId, a.ownerToken, "SPAWN_ATTEMPTING")
      const report = await auth.reconcile(p)
      expect(report.freed).toBe(0) // 无法证明进程不存在 → 不释放
      const st = await auth.status(p)
      expect(st.charged).toBe(1)
      expect(st.claims[0]!.phase).toBe("SUSPECT")
      await auth.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("P1-3: idempotent reserve after release — fresh claim, capacity re-accounted, no revival", async () => {
    const { dir, dbPath } = tmpDb()
    try {
      const auth = createHostCapacityAuthority({ dbPath, capacityOverride: { cpuQuota: 1000, memoryBytes: 10 * 1024 * 1024 }, reality: provenReality() })
      const p = principal(13)
      const a = await auth.reserve(req, "key-p13", p)
      expect(a.ok).toBe(true)
      if (!a.ok) return
      // 正常释放（reality proven → RELEASED）。
      await auth.updatePhase(a.claimId, a.ownerToken, "EXECUTING", { pid: 5555, startticks: 777 })
      const rel = await auth.releaseRequested(a.claimId, a.ownerToken)
      expect(rel.state).toBe("RELEASED")
      // 同 key 重试（崩溃恢复 / 重跑场景）→ 全新 claim + 全新 token，容量重新记账。
      const b = await auth.reserve(req, "key-p13", p)
      expect(b.ok).toBe(true)
      if (!b.ok) return
      expect(b.claimId).not.toBe(a.claimId) // 不复活旧 claim
      expect(b.ownerToken).not.toBe(a.ownerToken)
      const st = await auth.status(p)
      expect(st.charged).toBe(1) // 新 claim 记账（无超卖窗口）
      // 旧 token 不能释放新 claim（token 托管仍然有效）。
      const forged = await auth.releaseRequested(b.claimId, a.ownerToken)
      expect(forged.state).toBe("REJECTED")
      // 新 token 正常释放。
      const rel2 = await auth.releaseRequested(b.claimId, b.ownerToken)
      expect(rel2.state).toBe("RELEASED")
      await auth.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("P1-4: new idempotency key after release — same run/cell re-reserve succeeds (no SQLITE_CONSTRAINT)", async () => {
    const { dir, dbPath } = tmpDb()
    try {
      const auth = createHostCapacityAuthority({ dbPath, capacityOverride: { cpuQuota: 1000, memoryBytes: 10 * 1024 * 1024 }, reality: provenReality() })
      const p = principal(14)
      const a = await auth.reserve(req, "key-p14a", p)
      expect(a.ok).toBe(true)
      if (!a.ok) return
      await auth.updatePhase(a.claimId, a.ownerToken, "EXECUTING", { pid: 5556, startticks: 778 })
      const rel = await auth.releaseRequested(a.claimId, a.ownerToken)
      expect(rel.state).toBe("RELEASED")
      // 新 key 同 (runId, cellId) → 必须成功（RELEASED 不占部分唯一索引）。
      const b = await auth.reserve(req, "key-p14b", p)
      expect(b.ok).toBe(true)
      if (!b.ok) return
      expect(b.claimId).not.toBe(a.claimId)
      await auth.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("P1-4b: concurrent active claim — second reserve fails cleanly, no throw", async () => {
    const { dir, dbPath } = tmpDb()
    try {
      const auth = createHostCapacityAuthority({ dbPath, capacityOverride: { cpuQuota: 1000, memoryBytes: 10 * 1024 * 1024 }, reality: provenReality() })
      const p = principal(15)
      const a = await auth.reserve(req, "key-p15a", p)
      expect(a.ok).toBe(true)
      if (!a.ok) return
      // 同 run/cell 新 key 且 claim 仍 active → 明确失败（不抛约束异常）。
      const b = await auth.reserve(req, "key-p15b", p)
      expect(b.ok).toBe(false)
      if (!b.ok) expect(b.reason).toContain("RESOURCE_DOUBLE_ACQUIRE")
      await auth.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("P1-4c: legacy schema (table-level UNIQUE) auto-migrates to partial unique index", async () => {
    const { dir, dbPath } = tmpDb()
    try {
      // 手工构造旧结构库（表级 UNIQUE (run_id, cell_id) + 一条 RELEASED 历史）。
      const { Database } = await import("bun:sqlite")
      const legacy = new Database(dbPath)
      legacy.exec(
        "CREATE TABLE claims (" +
        "  claim_id TEXT PRIMARY KEY," +
        "  run_id TEXT NOT NULL, cell_id TEXT NOT NULL, agent_id TEXT, backend_id TEXT," +
        "  phase TEXT NOT NULL, requested_json TEXT NOT NULL, owner_token_hash TEXT NOT NULL," +
        "  principal TEXT NOT NULL, client_instance_id TEXT NOT NULL, idempotency_key TEXT NOT NULL," +
        "  request_digest TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL," +
        "  spawned_pid INTEGER, spawn_startticks INTEGER, cgroup_path TEXT," +
        "  UNIQUE (run_id, cell_id)" +
        ")"
      )
      legacy.exec("INSERT INTO claims VALUES ('legacy-1','r-legacy','c-legacy',NULL,NULL,'RELEASED','{}','h','p','i','k','d',0,0,NULL,NULL,NULL)")
      legacy.close()

      // 打开旧库 → 自动迁移（重建表 + 部分唯一索引）。
      const auth = createHostCapacityAuthority({ dbPath, capacityOverride: { cpuQuota: 1000, memoryBytes: 10 * 1024 * 1024 }, reality: provenReality() })
      const tp = { uid: 1, pid: 1, startticks: 1, clientInstanceId: "t" }
      // RELEASED 旧行保留（历史不丢）。
      const st = await auth.status(tp)
      expect(st.claims.some(c => c.claimId === "legacy-1")).toBe(true)
      // 同 (runId,cellId) 新 key reserve → 成功（RELEASED 不占唯一性）。
      const b = await auth.reserve({ ...req, runId: "r-legacy", cellId: "c-legacy" }, "key-p16", tp)
      expect(b.ok).toBe(true)
      if (!b.ok) return
      // 迁移后部分索引生效：再抢同 run/cell 新 key → 明确拒绝。
      const c = await auth.reserve({ ...req, runId: "r-legacy", cellId: "c-legacy" }, "key-p17", tp)
      expect(c.ok).toBe(false)
      if (!c.ok) expect(c.reason).toContain("RESOURCE_DOUBLE_ACQUIRE")
      await auth.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

})
