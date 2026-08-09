/** LR2-1v2（L2-A）：执行句柄 —— 跨重启接管所需的最小持久化事实。
 *
 *  pidfd 不可跨重启；同 boot 内 execd 重启后只依赖可观测事实：
 *  - cgroup 路径（cell 专属）存在且 cgroup.events populated=1 → 进程树
 *    仍活着 → 重新接管（RUNNING 保持，取消/监控走 cgroup 路径）；
 *  - cgroup 存在但 populated=0 → 树已退出 → 收敛 EXIT_OBSERVED；
 *  - cgroup 不存在 → 未启动/已清理 → 收敛 START_FAILED。
 *
 *  句柄持久化到 StateStore（execution_handles 表）；探活注入 fs 接口
 *  （真实路径 CgroupManager.fs，测试注入内存 fs）。
 */

export interface ExecutionHandle {
  handleId: string
  cellId: string
  runId: string
  attemptId: string
  /** cell 专属 cgroup 路径（restart 接管的唯一可靠锚点）。 */
  cgroupPath: string
  /** spawn 时的主 pid（仅诊断；pidfd 不可跨重启，不用于接管）。 */
  spawnPid?: number
  startedAt: number
  /** 接管后探活结果（RECOVERED / EXITED / ABSENT）。 */
  takeover?: "RECOVERED" | "EXITED" | "ABSENT"
}

export interface CgroupProbeFs {
  /** cgroup.events 内容（populated/ 行）。 */
  readCgroupEvents(path: string): string | undefined
  exists(path: string): boolean
}

export const REAL_CGROUP_PROBE_FS: CgroupProbeFs = {
  readCgroupEvents(path: string): string | undefined {
    try {
      const { readFileSync } = require("node:fs") as typeof import("node:fs")
      const { join } = require("node:path") as typeof import("node:path")
      return readFileSync(join(path, "cgroup.events"), "utf8")
    } catch {
      return undefined
    }
  },
  exists(path: string): boolean {
    try {
      const { accessSync, constants } = require("node:fs") as typeof import("node:fs")
      accessSync(path, constants.F_OK)
      return true
    } catch {
      return false
    }
  },
}

export type TakeoverVerdict =
  | { state: "RECOVERED"; reason: string; populated: true }
  | { state: "EXITED"; reason: string; populated: false }
  | { state: "ABSENT"; reason: string }
  | { state: "UNKNOWN"; reason: string }

/** 解析 cgroup.events 的 populated 行（文件缺失/解析失败 → undefined）。 */
export function parsePopulated(events: string | undefined): boolean | undefined {
  if (events === undefined) return undefined
  const match = events.split("\n").find(line => line.startsWith("populated "))
  if (!match) return undefined
  const value = match.split(" ")[1]
  if (value !== "0" && value !== "1") return undefined
  return value === "1"
}

/** 接管判定：cgroup 存在性 + populated。
 *  M1：cgroup 存在但 events 读取/解析失败 → UNKNOWN（进程树可能仍活着
 *  —— 不得谎报 START_FAILED 孤儿化；由上层保持 RUNNING 待重试）。 */
export function determineTakeover(handle: ExecutionHandle, fs: CgroupProbeFs = REAL_CGROUP_PROBE_FS): TakeoverVerdict {
  if (!fs.exists(handle.cgroupPath)) {
    return { state: "ABSENT", reason: `cgroup not found: ${handle.cgroupPath}` }
  }
  const events = fs.readCgroupEvents(handle.cgroupPath)
  const populated = parsePopulated(events)
  if (populated === undefined) {
    return { state: "UNKNOWN", reason: `cgroup.events unreadable: ${handle.cgroupPath}` }
  }
  if (populated) {
    return { state: "RECOVERED", reason: `cgroup populated: ${handle.cgroupPath}`, populated: true }
  }
  return { state: "EXITED", reason: `cgroup empty: ${handle.cgroupPath}`, populated: false }
}

/** 内存探活 fs（测试用）。 */
export function memCgroupFs(paths: { [path: string]: { events?: string } }): CgroupProbeFs {
  return {
    readCgroupEvents(path: string): string | undefined {
      return paths[path]?.events
    },
    exists(path: string): boolean {
      return path in paths
    },
  }
}
