/** LNXF LF-5 acceptance: Agent Domain 与并发调度.
 *
 *  Gates: CROSS_WORKTREE_SERIALIZATION / MAIN_WORKSPACE_MULTI_WRITER /
 *  RESOURCE_OVERCOMMIT / CACHE_CORRUPTION_CROSS_AGENT / AGENT_CANCEL_ISOLATION.
 */

import { describe, expect, test } from "bun:test"
import { ResourceLedger, cpuQuotaFromCores } from "../../../src/runtime/linux/scheduler/resource-ledger"
import { FairQueue, PRIORITY_WEIGHT } from "../../../src/runtime/linux/scheduler/queue"
import { IsolationDomainLock } from "../../../src/runtime/linux/workspace/isolation-lock"
import { CacheManager, PortLeaseManager, validateBindAddress, SHARED_READONLY_KINDS } from "../../../src/runtime/linux/workspace/cache-port"
import { AgentDomainManager } from "../../../src/runtime/linux/workspace/agent-domain"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("LF-5: resource ledger", () => {
  test("reservation succeeds when capacity allows", () => {
    const ledger = new ResourceLedger({ capacity: { cpuQuota: 10_000, memoryBytes: 1024 * 1024 * 1024, pids: 1000, networkSlots: 2, tempBytes: 1024 * 1024, concurrentCells: 4 } })
    const result = ledger.reserve({ cpuQuota: 1000, memoryBytes: 256 * 1024 * 1024, pids: 100, ioWeight: 0, networkSlots: 1, tempBytes: 512 * 1024 }, "r1", "c1", "a1")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.reservation.granted.cpuQuota).toBe(1000)
      expect(ledger.outstanding()).toHaveLength(1)
    }
  })

  test("overcommit is rejected atomically (RESOURCE_OVERCOMMIT: 0)", () => {
    const ledger = new ResourceLedger({ capacity: { cpuQuota: 1000, memoryBytes: 1024, pids: 10, networkSlots: 1, tempBytes: 1024, concurrentCells: 2 } })
    const first = ledger.reserve({ cpuQuota: 900, memoryBytes: 800, pids: 5, ioWeight: 0, networkSlots: 1, tempBytes: 800, }, "r1", "c1")
    expect(first.ok).toBe(true)
    const second = ledger.reserve({ cpuQuota: 900, memoryBytes: 800, pids: 5, ioWeight: 0, networkSlots: 1, tempBytes: 800 }, "r1", "c2")
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.reason).toContain("cpu")
      expect(ledger.outstanding()).toHaveLength(1) // 无部分预留
    }
  })

  test("cell concurrency cap blocks beyond max", () => {
    const ledger = new ResourceLedger({ capacity: { cpuQuota: 100_000, memoryBytes: 1024 * 1024 * 1024, pids: 1000, networkSlots: 4, tempBytes: 1024, concurrentCells: 2 } })
    expect(ledger.reserve({ cpuQuota: 1, memoryBytes: 1, pids: 1, ioWeight: 0, networkSlots: 0, tempBytes: 1 }, "r1", "c1").ok).toBe(true)
    expect(ledger.reserve({ cpuQuota: 1, memoryBytes: 1, pids: 1, ioWeight: 0, networkSlots: 0, tempBytes: 1 }, "r1", "c2").ok).toBe(true)
    const third = ledger.reserve({ cpuQuota: 1, memoryBytes: 1, pids: 1, ioWeight: 0, networkSlots: 0, tempBytes: 1 }, "r1", "c3")
    expect(third.ok).toBe(false)
    expect(!third.ok && third.reason).toContain("cells")
  })

  test("release and run/agent release free capacity", () => {
    const ledger = new ResourceLedger({ capacity: { cpuQuota: 10_000, memoryBytes: 1024, pids: 100, networkSlots: 2, tempBytes: 1024, concurrentCells: 4 } })
    const a = ledger.reserve({ cpuQuota: 1000, memoryBytes: 100, pids: 10, ioWeight: 0, networkSlots: 0, tempBytes: 100 }, "r1", "c1", "a1")
    const b = ledger.reserve({ cpuQuota: 1000, memoryBytes: 100, pids: 10, ioWeight: 0, networkSlots: 0, tempBytes: 100 }, "r2", "c2", "a2")
    expect(a.ok && b.ok).toBe(true)
    if (a.ok) ledger.release(a.reservation.reservationId)
    expect(ledger.available().cpuQuota).toBe(9000)
    expect(ledger.releaseRun("r2")).toBe(1)
    expect(ledger.available().cpuQuota).toBe(10_000)
  })

  test("host reserve defaults protect the host", () => {
    const ledger = new ResourceLedger()
    const stats = ledger.stats()
    expect(stats.capacity.cpuQuota).toBeGreaterThan(0)
    expect(stats.capacity.memoryBytes).toBeGreaterThan(0)
    expect(cpuQuotaFromCores(8)).toBe(8_000) // LNXF-R2 10.2：单位统一为 cpuMillis（1000=1 核）
  })
})

describe("LF-5: fair queue", () => {
  test("priority ordering: interactive before evolution", () => {
    const queue = new FairQueue()
    queue.enqueue({ id: "e1", runId: "r1", priority: "evolution", weight: 1 })
    queue.enqueue({ id: "i1", runId: "r2", priority: "interactive", weight: 1 })
    queue.enqueue({ id: "v1", runId: "r3", priority: "verification", weight: 1 })
    expect(queue.dequeue()!.id).toBe("i1")
    expect(queue.dequeue()!.id).toBe("v1")
    expect(queue.dequeue()!.id).toBe("e1")
  })

  test("same-priority FIFO", () => {
    const queue = new FairQueue()
    queue.enqueue({ id: "a", runId: "r", priority: "normal", weight: 1 })
    queue.enqueue({ id: "b", runId: "r", priority: "normal", weight: 1 })
    expect(queue.dequeue()!.id).toBe("a")
    expect(queue.dequeue()!.id).toBe("b")
  })

  test("per-agent limit prevents starvation", () => {
    const queue = new FairQueue()
    for (let i = 0; i < 3; i++) queue.enqueue({ id: `a-${i}`, runId: "r", agentId: "a1", priority: "normal", weight: 1 })
    queue.enqueue({ id: "b-1", runId: "r", agentId: "b1", priority: "normal", weight: 1 })
    expect(queue.countForAgent("a1")).toBe(3)
    // a1 运行中 0 → 取 a-0、a-1
    const first = queue.takeWithinAgentLimit(2)!
    expect(first.id).toBe("a-0")
    queue.begin(first)
    const second = queue.takeWithinAgentLimit(2)!
    expect(second.id).toBe("a-1")
    queue.begin(second)
    // a1 运行中 2 = 上限 → 轮到 b1（防止 a1 占满）
    const third = queue.takeWithinAgentLimit(2)!
    expect(third.id).toBe("b-1")
    queue.begin(third)
    // b1 完成释放后 a1 继续
    queue.finish(third)
    const fourth = queue.takeWithinAgentLimit(2)!
    expect(fourth.id).toBe("a-2")
  })

  test("removeRun drains waiting runs (human-waiting holds no resources)", () => {
    const queue = new FairQueue()
    queue.enqueue({ id: "x", runId: "waiting", priority: "normal", weight: 1 })
    queue.enqueue({ id: "y", runId: "active", priority: "normal", weight: 1 })
    expect(queue.removeRun("waiting")).toBe(1)
    expect(queue.size()).toBe(1)
  })

  test("priority weights are monotonic", () => {
    expect(PRIORITY_WEIGHT.interactive).toBeGreaterThan(PRIORITY_WEIGHT.verification)
    expect(PRIORITY_WEIGHT.verification).toBeGreaterThan(PRIORITY_WEIGHT.normal)
    expect(PRIORITY_WEIGHT.normal).toBeGreaterThan(PRIORITY_WEIGHT.evolution)
  })
})

describe("LF-5: isolation-domain lock", () => {
  test("main workspace is exclusive (MAIN_WORKSPACE_MULTI_WRITER: 0)", () => {
    const lock = new IsolationDomainLock()
    const main = IsolationDomainLock.mainWorkspaceKey()
    expect(lock.acquire(main, "exclusive", "a1")).toBe(true)
    expect(lock.acquire(main, "exclusive", "a2")).toBe(false)
    expect(lock.acquire(main, "shared", "a3")).toBe(false)
    expect(lock.release(main, "a1")).toBe(true)
    expect(lock.acquire(main, "exclusive", "a2")).toBe(true)
  })

  test("different worktrees write in parallel (CROSS_WORKTREE_SERIALIZATION: 0)", () => {
    const lock = new IsolationDomainLock()
    const wta = IsolationDomainLock.worktreeKey("a1")
    const wtb = IsolationDomainLock.worktreeKey("a2")
    expect(lock.acquire(wta, "exclusive", "a1")).toBe(true)
    expect(lock.acquire(wtb, "exclusive", "a2")).toBe(true)
    expect(lock.canWriteInParallel("a1", "a2")).toBe(true)
    expect(lock.canWriteInParallel("a1", "a1")).toBe(false)
    // 同 worktree 串行
    expect(lock.acquire(wta, "exclusive", "a1-2")).toBe(false)
  })

  test("cache lock: rw-locked exclusive, ro shared", () => {
    const lock = new IsolationDomainLock()
    const key = IsolationDomainLock.cacheKey("bun", "cache-v1")
    expect(lock.acquire(key, "exclusive", "a1")).toBe(true)
    expect(lock.acquire(key, "shared", "a2")).toBe(false)
    lock.release(key, "a1")
    expect(lock.acquire(key, "shared", "a2")).toBe(true)
    expect(lock.acquire(key, "shared", "a3")).toBe(true)
    expect(lock.acquire(key, "exclusive", "a4")).toBe(false)
  })

  test("releaseAll frees everything for a cancelled agent (AGENT_CANCEL_ISOLATION)", () => {
    const lock = new IsolationDomainLock()
    lock.acquire(IsolationDomainLock.worktreeKey("a1"), "exclusive", "a1")
    lock.acquire(IsolationDomainLock.cacheKey("npm", "k"), "shared", "a1")
    expect(lock.releaseAll("a1")).toBe(2)
    expect(lock.acquire(IsolationDomainLock.worktreeKey("a1"), "exclusive", "a2")).toBe(true)
  })
})

describe("LF-5: cache manager", () => {
  test("host paths are runtime-decided per kind/key", () => {
    const root = mkdtempSync(join(tmpdir(), "lnxf-cache-"))
    try {
      const manager = new CacheManager(root)
      const p1 = manager.hostPath({ cacheId: "x", kind: "bun", key: "v1", mode: "rw-locked", target: "/cache" })
      const p2 = manager.hostPath({ cacheId: "y", kind: "bun", key: "v1", mode: "rw-locked", target: "/cache" })
      expect(p1).toBe(p2)
      expect(p1).toContain("bun")
      expect(manager.lockKey({ cacheId: "x", kind: "bun", key: "v1", mode: "rw-locked", target: "/cache" })).toBe("cache:bun:v1")
      expect(manager.requiresExclusive({ cacheId: "x", kind: "bun", key: "v1", mode: "rw-locked", target: "/cache" })).toBe(true)
      expect(SHARED_READONLY_KINDS.has("repo-map")).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("LF-5: port lease", () => {
  test("leases are loopback-only with expiry and run collection", () => {
    const manager = new PortLeaseManager({ hostPortRange: { start: 40_000, end: 40_010 }, leaseMs: 60_000 })
    const lease = manager.lease({ runId: "r1", cellId: "c1", internalPort: 8080, exposeToHost: true })
    expect(lease?.internalPort).toBe(8080)
    expect(lease?.hostPort).toBe(40_000)
    expect(lease?.bindAddress).toBe("127.0.0.1")
    // 端口不重复
    const second = manager.lease({ runId: "r1", cellId: "c2", internalPort: 8081, exposeToHost: true })
    expect(second?.hostPort).toBe(40_001)
    // run 回收
    expect(manager.releaseRun("r1")).toBe(2)
    expect(manager.activeLeases()).toHaveLength(0)
  })

  test("expired leases are collected", () => {
    const manager = new PortLeaseManager({ leaseMs: -1000 })
    manager.lease({ runId: "r1", cellId: "c1", internalPort: 8080 })
    expect(manager.collectExpired()).toBe(1)
  })

  test("0.0.0.0 binding is rejected", () => {
    expect(validateBindAddress("0.0.0.0")).toBe(false)
    expect(validateBindAddress("127.0.0.1")).toBe(true)
    expect(validateBindAddress("localhost")).toBe(true)
  })
})

describe("LF-5: agent domain", () => {
  test("domain binds worktree/temp/cache/budget", () => {
    const manager = new AgentDomainManager()
    const domain = manager.createDomain({
      runId: "r1",
      agentId: "a1",
      worktreeRoot: "/wt/a1",
      ownerFiles: ["src/a.ts"],
      resourceBudget: { maxConcurrentCells: 2, cpuQuotaTotal: 10_000, memoryMaxBytes: 1024, pidsMax: 64, maxWallTimeMs: 60_000, maxOutputBytes: 1024, maxTempBytes: 1024 },
    })
    expect(domain.status).toBe("active")
    expect(domain.worktreeRoot).toBe("/wt/a1")
    expect(domain.cacheNamespace).toContain("agent-a1")
    expect(manager.byAgent("a1")?.domainId).toBe(domain.domainId)
  })

  test("cancel kills the agent cgroup and marks cancelling", () => {
    const manager = new AgentDomainManager()
    const domain = manager.createDomain({
      runId: "r1", agentId: "a1", worktreeRoot: "/wt", ownerFiles: [],
      resourceBudget: { maxConcurrentCells: 1, cpuQuotaTotal: 100, memoryMaxBytes: 100, pidsMax: 10, maxWallTimeMs: 100, maxOutputBytes: 100, maxTempBytes: 100 },
    })
    expect(manager.cancelAgent("a1")).toBe(true)
    expect(domain.status).toBe("cancelling")
    // 取消一个 agent 不影响其他
    const other = manager.createDomain({
      runId: "r1", agentId: "b1", worktreeRoot: "/wt2", ownerFiles: [],
      resourceBudget: { maxConcurrentCells: 1, cpuQuotaTotal: 100, memoryMaxBytes: 100, pidsMax: 10, maxWallTimeMs: 100, maxOutputBytes: 100, maxTempBytes: 100 },
    })
    expect(other.status).toBe("active")
  })

  test("closeRun closes all domains and cleans temp roots", () => {
    const root = mkdtempSync(join(tmpdir(), "lnxf-domain-"))
    try {
      const manager = new AgentDomainManager()
      manager.createDomain({
        runId: "r1", agentId: "a1", worktreeRoot: "/wt", ownerFiles: [], tempRoot: join(root, "a1"),
        resourceBudget: { maxConcurrentCells: 1, cpuQuotaTotal: 100, memoryMaxBytes: 100, pidsMax: 10, maxWallTimeMs: 100, maxOutputBytes: 100, maxTempBytes: 100 },
      })
      expect(manager.closeRun("r1")).toBe(1)
      expect(manager.byAgent("a1")).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
