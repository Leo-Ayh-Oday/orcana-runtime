/** LNXF-1.0: process termination (LF-2) — tree-kill with verification.
 *
 *  POSIX process-group kill (negative PID) terminates the whole tree
 *  including double-forked descendants that escaped the direct parent
 *  chain but stayed in the group. `killOnParentExit` uses the parent-death
 *  signal (prctl PR_SET_PDEATHSIG) — implemented at the backend level.
 */

import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"

export interface TerminationReport {
  /** 终止后仍然存活的进程数（0 = 干净）。 */
  processesRemaining: number
  signalSent: "SIGTERM" | "SIGKILL"
}

export function killProcessGroup(pid: number, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): TerminationReport {
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
