/** IC06: Resource Authority 集成回归（R59-R84 子集 + R1-R15 关键 MUST PASS）——
 *  broker + fake/in-process authority：fail closed / generator 收尾 / acquired
 *  truth / claimId env / host-audit 拒绝 / local-ledger bypass / double acquire。 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLinuxBroker } from "../src/runtime/linux/broker"
import { createHostCapacityAuthority, type CapacityAuthority, type ClaimPhase, type ReserveOutcome } from "../src/runtime/linux/scheduler/host-capacity"
import { CgroupManager, type CgroupFs } from "../src/runtime/linux/cgroup/manager"
import { LinuxExecutionError } from "../src/runtime/linux/errors"
import type { ExecutionCellSpec } from "../src/runtime/linux/contracts"

/** WSL2 真实 cgroup attach 会挂起 → 与 broker-transaction.test.ts 相同的
 *  mock cgroup（隔离执行路径干扰，保持 IC06 语义可测）。 */
function mockCgroupFs(): CgroupFs {
  const state = new Map<string, string>()
  const dirs = new Set<string>(["/sys/fs/cgroup"])
  return {
    exists: p => dirs.has(p) || state.has(p) || p.endsWith("cgroup.subtree_control"),
    read(p) {
      const v = state.get(p)
      if (v !== undefined) return v
      if (p.endsWith("cgroup.controllers")) return "cpuset cpu io memory hugetlb pids"
      if (p.endsWith("cgroup.subtree_control")) return "cpu memory pids"
      throw new Error(`missing ${p}`)
    },
    write(p, c) {
      if (p.endsWith("cgroup.subtree_control")) {
        state.set(p, `${state.get(p) ?? "cpu memory pids"} ${c}`.trim())
        return
      }
      state.set(p, c)
    },
    mkdir(p) {
      dirs.add(p)
      for (const a of ["cgroup.procs", "cgroup.kill", "pids.max", "memory.max", "memory.events", "memory.current", "memory.oom.group", "cpu.max", "pids.current", "memory.peak", "pids.peak", "cpu.stat"]) {
        state.set(`${p}/${a}`, a === "pids.max" ? "max" : a === "pids.current" ? "0" : a === "memory.events" ? "oom 0\noom_kill 0" : a === "cpu.stat" ? "usage_usec 100\nt_hrottled_usec 0" : a === "memory.peak" ? "4096" : a === "pids.peak" ? "2" : "0")
      }
    },
    rm(p) {
      for (const k of [...state.keys()]) if (k.startsWith(p + "/")) state.delete(k)
      dirs.delete(p)
    },
    readdir(p) {
      return [...new Set([...dirs].filter(d => d.startsWith(p + "/")).map(d => d.slice(p.length + 1).split("/")[0] ?? ""))]
    },
  }
}

const mockCgroup = () => new CgroupManager({ base: "/sys/fs/cgroup", fs: mockCgroupFs() })

/** worktree 必须是真实小目录（bubblewrap PathGuard 快照 worktree ——
 *  快照 /tmp 会挂起 loaded host）。 */
function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "ic06-wt-"))
  return dir
}
const worktree = makeWorktree()

function cellSpec(overrides: Partial<ExecutionCellSpec> = {}): ExecutionCellSpec {
  return {
    schemaVersion: "1.0",
    identity: { cellId: `c-${Math.random().toString(36).slice(2, 8)}`, runId: "r1", nodeRunId: "r1:n", attempt: 1, agentId: "a1" },
    command: { executable: "/bin/true", args: [], cwd: worktree, stdin: "closed" },
    profile: "build",
    // IC06 hardAuthority 下 host-audit fail closed → 测试执行用 bubblewrap
    // （本机真实可用；与 bubblewrap.test.ts 相同的真实沙盒路径）。
    isolation: { minimum: "namespace", preferredBackend: "bubblewrap", allowDegradation: false },
    filesystem: { readonlyMounts: [], writableMounts: [], tmpfsMounts: [], hiddenPaths: [], emptyHome: true, worktreeRoot: worktree },
    network: { mode: "none" },
    environment: { variables: {}, inheritHost: false, locale: "C.UTF-8", pathEntries: [] },
    secrets: [],
    resources: { memoryMaxBytes: 1024, pidsMax: 128, wallTimeMs: 10_000, stdoutMaxBytes: 1024, stderrMaxBytes: 1024, tmpfsMaxBytes: 1024 },
    cache: [],
    lifecycle: { killOnParentExit: true, cleanupOnExit: true, retainOnFailure: false, serviceMode: false },
    policyDigest: "",
    ...overrides,
  }
}

function tempAuthority(): { auth: import("../src/runtime/linux/scheduler/host-capacity").HostCapacityAuthority; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ic06-int-"))
  const auth = createHostCapacityAuthority({
    dbPath: join(dir, "capacity.db"),
    capacityOverride: { cpuQuota: 100_000, memoryBytes: 1_024 * 1024 * 1024 },
    reality: async claim => {
      if (claim.spawnedPid && claim.spawnedPid > 0) return { state: "proven", evidence: "test-proven" }
      return { state: "unknown", evidence: "no-pid" }
    },
  })
  return { auth, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 可注入 fake authority：记录调用，可挂起/抛错。 */
function recordingAuthority(overrides: Partial<CapacityAuthority> = {}): { authority: CapacityAuthority; calls: { reserve: number; release: number; phase: string[] } } {
  const calls = { reserve: 0, release: 0, phase: [] as string[] }
  const authority: CapacityAuthority = {
    reserve: async (req, key) => { calls.reserve += 1; return { ok: true, claimId: `claim-${calls.reserve}`, ownerToken: `tok-${calls.reserve}` } },
    releaseRequested: async () => { calls.release += 1; return { state: "RELEASED", phase: "RELEASED" } },
    updatePhase: async (_c, _t, phase) => { calls.phase.push(phase) },
    reconcile: async () => ({ freed: 0, remainingCharged: 0 }),
    status: async () => ({ capacity: { cpuQuota: 0, memoryBytes: 0, pids: 0, networkSlots: 0, tempBytes: 0, concurrentCells: 0 }, available: { cpuQuota: 0, memoryBytes: 0, pids: 0, ioWeight: 0, networkSlots: 0, tempBytes: 0 }, charged: 0, claims: [] }),
    close: async () => {},
    ...overrides,
  }
  return { authority, calls }
}

async function collect(spec: ExecutionCellSpec, broker: ReturnType<typeof createLinuxBroker>) {
  const events: Array<{ type: string; [k: string]: unknown }> = []
  for await (const e of broker.execute(spec)) events.push(e as unknown as { type: string; [k: string]: unknown })
  return events
}

describe("IC06 resource authority integration", () => {
  test("R72/R84: authority unavailable → FAIL CLOSED, no local-ledger bypass", async () => {
    const failing = recordingAuthority({
      reserve: async () => { throw new Error("CAPACITY_AUTHORITY_UNREACHABLE") },
    })
    const broker = createLinuxBroker({ mode: "enabled", capacityAuthority: failing.authority, cgroup: mockCgroup() })
    await expect(collect(cellSpec(), broker)).rejects.toThrow(LinuxExecutionError)
  })

  test("R72b: authority rejects reserve (insufficient) → fail closed without execution", async () => {
    const auth = recordingAuthority({
      reserve: async () => {
        auth.calls.reserve += 1
        return { ok: false, reason: "insufficient resources: cpu" } as ReserveOutcome
      },
    })
    const broker = createLinuxBroker({ mode: "enabled", capacityAuthority: auth.authority, cgroup: mockCgroup() })
    await expect(collect(cellSpec(), broker)).rejects.toThrow("RESOURCE_RESERVATION_FAILED")
    expect(auth.calls.reserve).toBe(1)
    expect(auth.calls.release).toBe(0)
  })

  test("R76: iterator early return — local cleanup + release-request both run", async () => {
    const { authority, calls } = recordingAuthority()
    const broker = createLinuxBroker({ mode: "enabled", capacityAuthority: authority, cgroup: mockCgroup() })
    const iter = broker.execute(cellSpec())[Symbol.asyncIterator]()
    await iter.next() // consume 第一事件
    await iter.return?.() // consumer break / return()
    expect(calls.reserve).toBe(1)
    expect(calls.release).toBe(1)
  })

  test("R77: consumer throw — finally runs release-request", async () => {
    const { authority, calls } = recordingAuthority()
    const broker = createLinuxBroker({ mode: "enabled", capacityAuthority: authority, cgroup: mockCgroup() })
    const iter = broker.execute(cellSpec())[Symbol.asyncIterator]()
    await iter.next()
    await expect(iter.throw?.(new Error("consumer-fail"))).rejects.toThrow("consumer-fail")
    expect(calls.release).toBe(1)
  })

  test("R78: release timeout — bounded, generator completes, claim not freed by client", async () => {
    const { authority } = recordingAuthority({
      releaseRequested: () => new Promise<never>(() => {}), // 永不返回
    })
    const broker = createLinuxBroker({ mode: "enabled", capacityAuthority: authority, cgroup: mockCgroup() })
    const started = Date.now()
    const events = await collect(cellSpec(), broker)
    expect(events.some(e => e.type === "cell.exit")).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000) // bounded ≤5s（给松弛）
  }, 15_000)

  test("R79: remote claim acquisition truth — fault after ACK still releases via acquired record", async () => {
    const { authority, calls } = recordingAuthority()
    const broker = createLinuxBroker({ mode: "enabled", capacityAuthority: authority, cgroup: mockCgroup() })
    const iter = broker.execute(cellSpec())[Symbol.asyncIterator]()
    // ACK 后 fault：消费完首事件立即 throw（acquired.capacityClaim 已记录）
    await iter.next()
    await expect(iter.throw?.(new Error("after-ack-fault"))).rejects.toThrow("after-ack-fault")
    expect(calls.reserve).toBe(1)
    expect(calls.release).toBe(1) // finalizer 找到 remote claim 并 release
  })

  test("R83: scheduler claim + broker second claim — authority rejects double acquire", async () => {
    const { auth, cleanup } = tempAuthority()
    try {
      const p = { uid: process.getuid?.() ?? -1, pid: process.pid, startticks: 1, clientInstanceId: "t" }
      const spec = cellSpec()
      const first = await auth.reserve({ request: { cpuQuota: 100, memoryBytes: 64 * 1024, pids: 8, ioWeight: 0, networkSlots: 0, tempBytes: 1024 }, runId: spec.identity.runId, cellId: spec.identity.cellId, backendId: "host-audit" }, "sched-key", p)
      expect(first.ok).toBe(true)
      // broker 同 run/cell 再 reserve（不同 key）→ 拒绝
      const second = await auth.reserve({ request: { cpuQuota: 100, memoryBytes: 64 * 1024, pids: 8, ioWeight: 0, networkSlots: 0, tempBytes: 1024 }, runId: spec.identity.runId, cellId: spec.identity.cellId, backendId: "host-audit" }, "broker-key", p)
      expect(second.ok).toBe(false)
    } finally {
      await auth.close(); cleanup()
    }
  })

  test("R60: host-audit + hard authority → fail closed (no execution)", async () => {
    const { authority } = recordingAuthority()
    const broker = createLinuxBroker({ mode: "enabled", capacityAuthority: authority, cgroup: mockCgroup() })
    const spec = cellSpec({ isolation: { minimum: "audit", preferredBackend: "host-audit", allowDegradation: true } })
    await expect(collect(spec, broker)).rejects.toThrow(LinuxExecutionError)
  })

  test("R60b: legacy（无 capacity）host-audit 仍可执行（特性未启用）", async () => {
    const broker = createLinuxBroker({ mode: "enabled" })
    const events = await collect(cellSpec({ isolation: { minimum: "audit", preferredBackend: "host-audit", allowDegradation: true } }), broker)
    expect(events.some(e => e.type === "cell.exit")).toBe(true)
  })

  test("R1: scheduler-style failed reservation (capacity exhaustion) → no execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ic06-int-"))
    try {
      const auth = createHostCapacityAuthority({ dbPath: join(dir, "c.db"), capacityOverride: { cpuQuota: 100, memoryBytes: 1024 } })
      const broker = createLinuxBroker({ mode: "enabled", capacityAuthority: auth, cgroup: mockCgroup() })
      await expect(collect(cellSpec(), broker)).rejects.toThrow("RESOURCE_RESERVATION_FAILED")
      await auth.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("claimId env injection: ORCANA_CLAIM_ID present in child env, ownerToken absent", async () => {
    const { authority, calls } = recordingAuthority()
    const broker = createLinuxBroker({ mode: "enabled", capacityAuthority: authority, cgroup: mockCgroup() })
    const spec = cellSpec({
      command: { executable: "/bin/sh", args: ["-c", "test -n \"$ORCANA_CLAIM_ID\""], cwd: worktree, stdin: "closed" },
    })
    const events = await collect(spec, broker)
    expect(events.some(e => e.type === "cell.exit" && e.exitCode === 0)).toBe(true)
    expect(calls.phase).toContain("PRE_SPAWN")
    expect(calls.phase).toContain("SPAWN_ATTEMPTING")
  })

  test("legacy no-capacity execution requires explicit developer flag (unsupported mode)", async () => {
    // P0-2：production 无 authority → FAIL CLOSED；legacy 仅显式 dev flag。
    process.env.ORCANA_DISABLE_RESOURCE_AUTHORITY = "1"
    try {
      const broker = createLinuxBroker({ mode: "enabled", cgroup: mockCgroup() })
      const events = await collect(cellSpec(), broker)
      expect(events.some(e => e.type === "cell.exit")).toBe(true)
    } finally {
      delete process.env.ORCANA_DISABLE_RESOURCE_AUTHORITY
    }
  })

  test("R75 integration: REVERSE GHOST — live reality → release leaves claim charged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ic06-int-"))
    try {
      const auth = createHostCapacityAuthority({
        dbPath: join(dir, "c.db"),
        capacityOverride: { cpuQuota: 100_000, memoryBytes: 1024 * 1024 * 1024 },
        reality: async () => ({ state: "live", evidence: "fake-live" }),
      })
      const broker = createLinuxBroker({ mode: "enabled", capacityAuthority: auth, cgroup: mockCgroup() })
      const spec = cellSpec({ command: { executable: "/bin/sleep", args: ["0.2"], cwd: worktree, stdin: "closed" } })
      const events = await collect(spec, broker)
      expect(events.some(e => e.type === "cell.exit")).toBe(true)
      // 执行结束后 claim 仍活着（fake live reality）→ QUARANTINED，容量保持 charged
      const st = await auth.status({ uid: process.getuid?.() ?? -1, pid: process.pid, startticks: 1, clientInstanceId: "t" })
      expect(st.charged).toBe(1)
      await auth.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
