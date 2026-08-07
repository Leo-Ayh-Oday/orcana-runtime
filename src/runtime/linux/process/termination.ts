/** LNXF-1.0: process termination (LF-2) — tree-kill with verification.
 *
 *  POSIX process-group kill (negative PID) terminates the whole tree
 *  including double-forked descendants that escaped the direct parent
 *  chain but stayed in the group. `killOnParentExit` uses the parent-death
 *  signal (prctl PR_SET_PDEATHSIG) — implemented at the backend level.
 *
 *  PR-11（ORCANA-E2E-001）：恢复路径需要处理 detached 后代（独立进程组、
 *  脱离父子关系）——组杀前先快照递归后代，组杀后对快照成员逐组补杀。
 */

import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"

export interface TerminationReport {
  /** 终止后仍然存活的进程数（0 = 干净）。 */
  processesRemaining: number
  signalSent: "SIGTERM" | "SIGKILL"
}

/** 递归后代收集（/proc ppid 扫描一次建表，从根 pid 向下遍历）。
 *  必须在根进程被杀**之前**调用——根死后 detached 后代被 init 收养，
 *  ancestry 不可再追踪。返回不含根自身。 */
export function collectDescendants(pid: number): number[] {
  if (!Number.isInteger(pid) || pid <= 0) return []
  const children = new Map<number, number[]>()
  let entries: string[]
  try {
    entries = readdirSync("/proc")
  } catch {
    return []
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const child = Number(entry)
    if (child === process.pid) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8")
      const match = /^(\d+) \(.+\) \w (\d+) (\d+)/.exec(stat)
      if (!match) continue
      const ppid = Number(match[2])
      const list = children.get(ppid)
      if (list) list.push(child)
      else children.set(ppid, [child])
    } catch {
      // process may have exited mid-scan
    }
  }
  const out: number[] = []
  const stack = [pid]
  const seen = new Set<number>([pid])
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const child of children.get(current) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      out.push(child)
      stack.push(child)
    }
  }
  return out
}

/** 树杀：组杀（含同组后代）+ detached 后代（独立组）逐组补杀。
 *  detached 后代无法经根进程组命中，必须用快照单独收尾 —— 恢复路径
 *  （ORCANA-E2E-001 阶段 3）与取消路径共用。 */
export function terminateTreeWithDescendants(
  pid: number,
  options: { graceMs?: number; attempts?: number } = {},
): TerminationReport {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { processesRemaining: 0, signalSent: "SIGTERM" }
  }
  // 1. 快照 detached 后代（根存活时）
  const descendants = collectDescendants(pid)
  // 2. 标准组杀（SIGTERM → 升级 SIGKILL）
  const report = terminateTree(pid, options)
  // 3. detached 后代逐组补杀（它们各自是组领导）
  for (const d of descendants) {
    if (d === pid) continue
    killProcessGroup(d, "SIGKILL")
  }
  // 4. 归零验证：组 + 后代中仍存活的
  let remaining = countProcessGroup(pid)
  if (remaining === 0) {
    for (const d of descendants) {
      if (d === pid) continue
      const alive = countProcessGroup(d)
      if (alive > 0) remaining += alive
    }
  }
  return { processesRemaining: remaining, signalSent: report.signalSent }
}

export function killProcessGroup(pid: number, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): TerminationReport {
  // F7（WRONG_PROCESS_KILL）：pid<=0 的信号操作必须拒绝。
  // POSIX 语义下 pid=0（含 -0）会 signal 调用方自身的进程组（killpg(0)），
  // pid<0 经 -pid 反转后指向无关单进程 —— 两者都是错杀。入口风险：
  // spawn 失败时 proc.pid 为 undefined，supervisor 记 pid=0，abort/timeout
  // 若先于 error 事件到达即命中此处。
  if (!Number.isInteger(pid) || pid <= 0) {
    return { processesRemaining: 0, signalSent: signal }
  }
  // POSIX: negative pid targets the process group.
  try {
    process.kill(-pid, signal)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return { processesRemaining: 0, signalSent: signal }
    if (code === "EPERM") return { processesRemaining: -1, signalSent: signal }
  }
  return { processesRemaining: countProcessGroup(pid), signalSent: signal }
}

/** 进程组存活计数（通过 /proc 扫描，避免 ps 依赖）。 */
export function countProcessGroup(pid: number): number {
  // F7：pid<=0 不可能是有效进程组 —— 直接 0（避免无意义扫描与误匹配）。
  if (!Number.isInteger(pid) || pid <= 0) return 0
  try {
    const entries = readdirSync("/proc") as string[]
    let count = 0
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue
      const pidNum = Number(entry)
      if (pidNum === process.pid) continue
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8")
        // stat format: pid (comm) state ppid pgrp session ...
        const match = /^(\d+) \(.+\) (\w) \d+ (\d+)/.exec(stat)
        if (!match) continue
        // zombie 由 init 收割，不计入存活（无法被杀，也不阻塞清理验证）
        if (match[2] === "Z") continue
        if (Number(match[3]) === pid) count += 1
      } catch {
        // process may have exited mid-scan
      }
    }
    return count
  } catch {
    // /proc unavailable (non-linux) — fall back to spawnSync ps
    const result = spawnSync("ps", ["-o", "pgid=", "-g", String(pid)], { encoding: "utf8", timeout: 5000 })
    return result.status === 0 ? result.stdout.trim().split("\n").filter(Boolean).length : -1
  }
}

/** 反复终止直到进程组归零（最多 attempts 次）。 */
export function terminateTree(
  pid: number,
  options: { graceMs?: number; attempts?: number; verify?: boolean } = {},
): TerminationReport {
  // F7：终止入口同防护 —— pid<=0 直接安全返回（killProcessGroup 已拒绝，
  // 此处避免无意义的 /proc 扫描循环）。
  if (!Number.isInteger(pid) || pid <= 0) {
    return { processesRemaining: 0, signalSent: "SIGTERM" }
  }
  const graceMs = options.graceMs ?? 500
  const attempts = options.attempts ?? 3
  killProcessGroup(pid, "SIGTERM")
  for (let i = 0; i < attempts; i++) {
    const remaining = countProcessGroup(pid)
    if (remaining <= 0) return { processesRemaining: 0, signalSent: "SIGTERM" }
    // 等 grace 后升级 SIGKILL
    const start = Date.now()
    while (Date.now() - start < graceMs) {
      const now = countProcessGroup(pid)
      if (now <= 0) return { processesRemaining: 0, signalSent: "SIGTERM" }
      sleep(25)
    }
  }
  killProcessGroup(pid, "SIGKILL")
  for (let i = 0; i < 12; i++) {
    const remaining = countProcessGroup(pid)
    if (remaining <= 0) return { processesRemaining: 0, signalSent: "SIGKILL" }
    sleep(25)
  }
  return { processesRemaining: countProcessGroup(pid), signalSent: "SIGKILL" }
}

export function sleep(ms: number): void {
  const sab = new SharedArrayBuffer(4)
  const arr = new Int32Array(sab)
  Atomics.wait(arr, 0, 0, ms)
}
