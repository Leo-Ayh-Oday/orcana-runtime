/** LNXF LF-4 acceptance: cgroup v2 资源治理.
 *
 *  Gates: MEMORY_LIMIT_ENFORCED / PIDS_LIMIT_ENFORCED / CGROUP_TREE_KILL /
 *  OOM_OUTSIDE_CELL / CGROUP_LEAK.
 *
 *  Full lifecycle tests run against an in-memory mock cgroupfs (the root
 *  cgroup is usually not writable without delegation); true-kernel tests
 *  run when a delegated writable subtree exists.
 */

import { describe, expect, test } from "bun:test"
import { platform } from "node:os"
import { CgroupManager, hierarchyPaths, type CgroupFs } from "../../../src/runtime/linux/cgroup/manager"
import { detectDelegatedRoot, enableControllers, delegationAvailable } from "../../../src/runtime/linux/cgroup/delegation"
import { readCgroupMetrics, cleanupRunCgroups, scanOrcanaScopes } from "../../../src/runtime/linux/cgroup/metrics"

const linuxOnly = platform() === "linux" ? test : test.skip

/** 内存 mock cgroupfs：记录写入的属性，模拟控制器。 */
function mockFs(attrs: Record<string, string> = {}, controllers = "cpuset cpu io memory hugetlb pids rdma"): { fs: CgroupFs; writes: Array<{ path: string; content: string }>; state: Map<string, string> } {
  const state = new Map<string, string>(Object.entries(attrs))
  const writes: Array<{ path: string; content: string }> = []
  const dirs = new Set<string>(["/sys/fs/cgroup"])
  const CELL_ATTRS = ["cgroup.procs", "cgroup.kill", "pids.max", "pids.current", "memory.max", "memory.events", "cpu.max", "memory.oom.group", "memory.current", "cpu.weight", "memory.swap.max", "io.weight", "memory.high", "memory.peak", "pids.peak", "cgroup.controllers"]
  const mkdirRecursive = (path: string): void => {
    if (path === "/" || dirs.has(path)) return
    const parent = path.slice(0, path.lastIndexOf("/"))
    if (parent) mkdirRecursive(parent)
    dirs.add(path)
    for (const attr of CELL_ATTRS) {
      state.set(`${path}/${attr}`, attr === "pids.max" ? "max" : attr === "pids.current" ? "0" : attr === "cgroup.kill" ? "" : attr === "memory.events" ? "oom 0\noom_kill 0" : attr === "cgroup.controllers" ? controllers : "0")
    }
  }
  const fs: CgroupFs = {
    exists(path) {
      return dirs.has(path) || state.has(path) || path.endsWith("cgroup.subtree_control")
    },
    read(path) {
      const value = state.get(path)
      if (value !== undefined) return value
      if (path.endsWith("cgroup.subtree_control")) return "cpu memory pids"
      if (path.endsWith("cgroup.controllers")) return controllers
      throw new Error(`mock read missing: ${path}`)
    },
    write(path, content) {
      writes.push({ path, content })
      if (path.endsWith("cgroup.subtree_control")) {
        // 模拟内核：只有 cgroup.controllers 声明的控制器才能启用
        const available = controllers.split(/\s+/)
        for (const token of content.split(/\s+/)) {
          if (token.startsWith("+") && !available.includes(token.slice(1))) {
            throw new Error("mock: controller unavailable")
          }
        }
      }
      state.set(path, content)
    },
    mkdir(path) {
      mkdirRecursive(path)
    },
    rm(path) {
      // PR-5 语义：非递归 rmdir —— 目录必须已空；子目录由协议自底向上删除。
      dirs.delete(path)
      for (const key of [...state.keys()]) if (key.startsWith(path + "/")) state.delete(key)
    },
    readdir(path) {
      return [...new Set([...dirs].filter(d => d.startsWith(path + "/")).map(d => d.slice(path.length + 1).split("/")[0] ?? ""))]
    },
  }
  return { fs, writes, state }
}

const BASE = "/sys/fs/cgroup"

describe("LF-4: hierarchy", () => {
  test("paths form run → agent → cell", () => {
    const paths = hierarchyPaths(BASE, "r1", "a1", "c1")
    expect(paths.run).toBe(`${BASE}/orcana.scope/run-r1`)
    expect(paths.agent).toBe(`${BASE}/orcana.scope/run-r1/agent-a1`)
    expect(paths.cell).toBe(`${BASE}/orcana.scope/run-r1/agent-a1/cell-c1`)
  })

  test("system cell nests under run when no agent", () => {
    const paths = hierarchyPaths(BASE, "r1", undefined, "c1")
    expect(paths.agent).toBe(`${BASE}/orcana.scope/run-r1/system`)
  })
})

describe("LF-4: manager (mock fs)", () => {
  test("creates run/agent/cell with all controllers", () => {
    const { fs } = mockFs()
    const manager = new CgroupManager({ base: BASE, fs })
    const run = manager.createRun("r1", { memoryMaxBytes: 1024, pidsMax: 10 })
    const agent = manager.createAgent("r1", "a1", { memoryMaxBytes: 512, pidsMax: 5, cpuWeight: 100 })
    const cell = manager.createCell("r1", "a1", "c1", {
      cpuQuotaMicros: 50000,
      cpuPeriodMicros: 100000,
      memoryHighBytes: 256,
      memoryMaxBytes: 512,
      pidsMax: 3,
      oomGroup: true,
    })
    expect(fs.exists(run)).toBe(true)
    expect(fs.exists(agent)).toBe(true)
    expect(fs.exists(cell)).toBe(true)
    expect(fs.read(`${cell}/pids.max`)).toBe("3")
    expect(fs.read(`${cell}/memory.max`)).toBe("512")
    expect(fs.read(`${cell}/memory.high`)).toBe("256")
    expect(fs.read(`${cell}/cpu.max`)).toBe("50000 100000")
    expect(fs.read(`${cell}/memory.oom.group`)).toBe("1")
  })

  test("attach writes pid to cgroup.procs", () => {
    const { fs } = mockFs()
    const manager = new CgroupManager({ base: BASE, fs })
    const cell = manager.createCell("r1", undefined, "c1", { memoryMaxBytes: 1024, pidsMax: 5 })
    manager.attach(4242, cell)
    expect(fs.read(`${cell}/cgroup.procs`)).toBe("4242")
  })

  test("kill writes 1 to cgroup.kill (tree kill)", () => {
    const { fs } = mockFs()
    const manager = new CgroupManager({ base: BASE, fs })
    const run = manager.createRun("r1")
    const result = manager.kill(run)
    expect(result.killed).toBe(true)
  })

  test("removeCell and removeRun clean up (CGROUP_LEAK: 0)", () => {
    const { fs } = mockFs()
    const manager = new CgroupManager({ base: BASE, fs })
    const cell = manager.createCell("r1", "a1", "c1", { memoryMaxBytes: 1024, pidsMax: 5 })
    expect(manager.removeCell(cell)).toBe(true)
    expect(fs.exists(cell)).toBe(false)
    const run = manager.createRun("r2")
    expect(manager.removeRun(run)).toBe(true)
    expect(fs.exists(run)).toBe(false)
  })

  test("metrics read from cell", () => {
    const { fs } = mockFs()
    const manager = new CgroupManager({ base: BASE, fs })
    const cell = manager.createCell("r1", "a1", "c1", { memoryMaxBytes: 1024, pidsMax: 5 })
    fs.write(`${cell}/cpu.stat`, "usage_usec 12345\nthrottled_usec 67")
    fs.write(`${cell}/memory.events`, "oom 0\noom_kill 1")
    fs.write(`${cell}/memory.peak`, "777")
    fs.write(`${cell}/pids.peak`, "4")
    const metrics = readCgroupMetrics(cell, fs)
    expect(metrics.cpuUsageUsec).toBe(12345)
    expect(metrics.cpuThrottledUsec).toBe(67)
    expect(metrics.peakMemoryBytes).toBe(777)
    expect(metrics.peakPids).toBe(4)
    expect(metrics.oomKills).toBe(1)
  })

  test("cleanupRunCgroups removes the run scope", () => {
    const { fs } = mockFs()
    const manager = new CgroupManager({ base: BASE, fs })
    manager.createRun("r9")
    const report = cleanupRunCgroups(manager, BASE, "r9")
    expect(report.removedScopes.length).toBe(1)
    expect(manager.createdPaths().length).toBeGreaterThan(0)
  })

  test("scanOrcanaScopes finds leftover runs (crash recovery)", () => {
    const { fs } = mockFs()
    const manager = new CgroupManager({ base: BASE, fs })
    manager.createRun("zombie-1")
    manager.createRun("zombie-2")
    const scopes = scanOrcanaScopes(fs, BASE)
    expect(scopes).toContain("run-zombie-1")
    expect(scopes).toContain("run-zombie-2")
  })
})

describe("PR-5: cgroup lifecycle protocol", () => {
  test("constructor creates orcana.scope at the delegation point", () => {
    const { fs } = mockFs()
    const manager = new CgroupManager({ base: BASE, fs })
    expect(fs.exists(`${BASE}/orcana.scope`)).toBe(true)
    const run = manager.createRun("r1")
    expect(fs.exists(run)).toBe(true)
  })

  test("removeCell uses kill → populated=0 → non-recursive rmdir", () => {
    const { fs } = mockFs()
    let rmCalls: string[] = []
    const manager = new CgroupManager({
      base: BASE,
      fs: {
        ...fs,
        rm: p => { rmCalls.push(p); fs.rm(p) },
      },
    })
    const cell = manager.createCell("r1", "a1", "c1", { memoryMaxBytes: 1024, pidsMax: 5 })
    expect(manager.removeCell(cell)).toBe(true)
    // 非递归 rmdir：恰好一次调用，目标是 cell 目录本身
    expect(rmCalls).toEqual([cell])
    expect(fs.exists(cell)).toBe(false)
    // 父级保留（只删 cell）
    expect(fs.exists(`${BASE}/orcana.scope/run-r1/agent-a1`)).toBe(true)
  })

  test("removeRun removes the whole subtree bottom-up (leaf first)", () => {
    const { fs } = mockFs()
    let rmCalls: string[] = []
    const manager = new CgroupManager({
      base: BASE,
      fs: {
        ...fs,
        rm: p => { rmCalls.push(p); fs.rm(p) },
      },
    })
    const run = manager.createRun("r1")
    manager.createAgent("r1", "a1", {})
    manager.createCell("r1", "a1", "c1", { memoryMaxBytes: 1024, pidsMax: 5 })
    expect(manager.removeRun(run)).toBe(true)
    // 自底向上：cell 先于 agent 先于 run 删除
    const cell = `${run}/agent-a1/cell-c1`
    const agent = `${run}/agent-a1`
    expect(rmCalls).toEqual([cell, agent, run])
    expect(fs.exists(run)).toBe(false)
  })

  test("removeCell refuses when populated stays non-zero (waitEmpty fails)", () => {
    const { fs, state } = mockFs()
    const manager = new CgroupManager({ base: BASE, fs })
    const cell = manager.createCell("r1", "a1", "c1", { memoryMaxBytes: 1024, pidsMax: 5 })
    // 模拟进程未退出：pids.current 恒 > 0
    state.set(`${cell}/pids.current`, "3")
    expect(manager.removeCell(cell)).toBe(false)
    // 未删除 —— 调用方必须继续清理（fail-closed）
    expect(fs.exists(cell)).toBe(true)
  })

  test("kill → waitEmpty → rmdir order is enforced (CGROUP_LEAK: 0 protocol)", () => {
    const { fs } = mockFs()
    const events: string[] = []
    const manager = new CgroupManager({
      base: BASE,
      fs: {
        ...fs,
        write: (p, c) => { if (p.endsWith("cgroup.kill")) events.push("kill"); fs.write(p, c) },
        rm: p => { events.push("rmdir"); fs.rm(p) },
      },
    })
    const cell = manager.createCell("r1", "a1", "c1", { memoryMaxBytes: 1024, pidsMax: 5 })
    expect(manager.removeCell(cell)).toBe(true)
    // kill 先于 rmdir
    expect(events.indexOf("kill")).toBeGreaterThan(-1)
    expect(events.indexOf("kill")).toBeLessThan(events.indexOf("rmdir"))
  })
})

describe("LF-4: delegation", () => {
  linuxOnly("delegation probe returns explicit source", () => {
    const delegated = detectDelegatedRoot()
    expect(["systemd-user", "systemd-system", "container-runtime", "manual", "none"]).toContain(delegated.source)
    expect(typeof delegated.writable).toBe("boolean")
  })

  test("enableControllers enables only available controllers", () => {
    const { fs, state } = mockFs({}, "cpu io memory") // pids 不可用
    fs.mkdir(`${BASE}/user.slice`)
    state.set(`${BASE}/user.slice/cgroup.subtree_control`, "cpu memory")
    const result = enableControllers(`${BASE}/user.slice`, ["cpu", "pids"], fs)
    expect(result.ok).toBe(false)
    expect(result.enabled).toContain("cpu")
    expect(result.missing).toContain("pids")
  })

  test("delegationAvailable is false when not writable", () => {
    expect(delegationAvailable({ root: BASE, base: "", source: "none", controllers: [], writable: false })).toBe(false)
    expect(delegationAvailable({ root: BASE, base: "/x", source: "systemd-user", controllers: [], writable: true })).toBe(true)
  })
})

describe("LF-4: true kernel (runs only with a writable delegated cgroup)", () => {
  const delegated = detectDelegatedRoot()
  const kernelTest = delegated.writable ? test : test.skip

  kernelTest("real cgroup tree is created, limited and killed", async () => {
    const manager = new CgroupManager({ base: delegated.base })
    const cell = manager.createCell(`lxf4-${process.pid}`, undefined, "mem", { memoryMaxBytes: 64 * 1024 * 1024, pidsMax: 8 })
    // 放进一个 sleep 进程
    const { spawn } = await import("node:child_process")
    const proc = spawn("/bin/sleep", ["10"], { stdio: "ignore" })
    manager.attach(proc.pid ?? 0, cell)
    expect(manager.pidsCurrent(cell)).toBeGreaterThanOrEqual(1)
    expect(manager.memoryCurrent(cell)).toBeGreaterThanOrEqual(0)
    expect(manager.kill(cell).killed).toBe(true)
    await new Promise(r => setTimeout(r, 150))
    expect(manager.pidsCurrent(cell)).toBe(0)
    manager.removeCell(cell)
  })
})
