/** LNXF-1.0: cgroup metrics + cleanup (LF-4).
 *
 *  metrics: cpu.stat throttling, memory.events pressure, pids peaks.
 *  cleanup: remove leftovers of a run; scan for orphaned orcana scopes.
 */

import { join } from "node:path"
import type { CgroupManager, CgroupFs } from "./manager"
import { hierarchyPaths } from "./manager"

export interface CgroupMetrics {
  cpuUsageUsec?: number
  cpuThrottledUsec?: number
  peakMemoryBytes?: number
  peakPids?: number
  oomKills: number
}

export function readCgroupMetrics(cellPath: string, fs: CgroupFs): CgroupMetrics {
  const metrics: CgroupMetrics = { oomKills: 0 }
  try {
    const cpuStat = fs.read(joinAttr(cellPath, "cpu.stat"))
    for (const line of cpuStat.split("\n")) {
      const [key, value] = line.split(/\s+/)
      if (key === "usage_usec") metrics.cpuUsageUsec = Number(value ?? 0)
      if (key === "throttled_usec") metrics.cpuThrottledUsec = Number(value ?? 0)
    }
  } catch {
    // cpu.stat 不存在（controller 未启用）
  }
  try {
    metrics.peakMemoryBytes = Number(fs.read(joinAttr(cellPath, "memory.peak")).trim() || 0)
  } catch {
    // memory.peak 为内核 6.5+ 字段
  }
  try {
    metrics.peakPids = Number(fs.read(joinAttr(cellPath, "pids.peak")).trim() || 0)
  } catch {
    // pids.peak 为内核 6.5+ 字段
  }
  try {
    const events = fs.read(joinAttr(cellPath, "memory.events"))
    for (const line of events.split("\n")) {
      const [key, value] = line.split(/\s+/)
      if (key === "oom_kill") metrics.oomKills = Number(value ?? 0)
    }
  } catch {
    // memory.events 不存在
  }
  return metrics
}

function joinAttr(path: string, file: string): string {
  return join(path, file)
}

export interface CleanupReport {
  runId: string
  removedScopes: string[]
  failedScopes: string[]
  processesKilled: boolean
}

/** 清理一个 run 的全部 cgroup（run 层整树）。 */
export function cleanupRunCgroups(manager: CgroupManager, base: string, runId: string): CleanupReport {
  const { run } = hierarchyPaths(base, runId, undefined, "x")
  const removed = manager.removeRun(run)
  return {
    runId,
    removedScopes: removed ? [run] : [],
    failedScopes: removed ? [] : [run],
    processesKilled: removed,
  }
}

/** 扫描 orcana.scope 下的遗留 run 子树（崩溃恢复识别）。 */
export function scanOrcanaScopes(fs: CgroupFs, base: string): string[] {
  const scope = joinAttr(base, "orcana.scope")
  if (!fs.exists(scope)) return []
  try {
    return fs.readdir(scope).filter(name => name.startsWith("run-"))
  } catch {
    return []
  }
}
