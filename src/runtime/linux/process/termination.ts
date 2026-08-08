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

/** 反复终止直到进程组归零（最多 attempts 次）。
 *
 *  LR2-0J 前置修复：同步阻塞必须有界。WSL 高负载下 /proc 全量扫描可能
 *  单次数百 ms，原实现 25ms 间隔轮询最多 ~20 次扫描，最坏可阻塞 10s+
 *  （触发上层 wall-time 超时 → broker 事务 finally 不执行 → 锁泄漏）。
 *  - budgetMs：总预算，超限即停止轮询，剩余数如实上报（不硬编码 0）；
 *  - 轮询间隔 25ms → 100ms（降低 /proc 扫描频率，归零检测延迟不变性）；
 *  - remaining === 0 才判干净：EPERM/不可用返回的 -1（未验证）不得被
 *    `<= 0` 误吞成假 0（否则绕过 Receipt 完整性门 processesRemaining===0）。
 */
export function terminateTree(
  pid: number,
  options: { graceMs?: number; attempts?: number; verify?: boolean; budgetMs?: number } = {},
): TerminationReport {
  // F7：终止入口同防护 —— pid<=0 直接安全返回（killProcessGroup 已拒绝，
  // 此处避免无意义的 /proc 扫描循环）。
  if (!Number.isInteger(pid) || pid <= 0) {
    return { processesRemaining: 0, signalSent: "SIGTERM" }
  }
  const graceMs = options.graceMs ?? 500
  const attempts = options.attempts ?? 3
  const budgetMs = options.budgetMs ?? 3000
  const startedAt = Date.now()
  const overBudget = (): boolean => Date.now() - startedAt > budgetMs
  const remainingNow = (): number => countProcessGroup(pid)
  killProcessGroup(pid, "SIGTERM")
  for (let i = 0; i < attempts; i++) {
    const remaining = remainingNow()
    if (remaining === 0) return { processesRemaining: 0, signalSent: "SIGTERM" }
    if (overBudget()) return { processesRemaining: remainingNow(), signalSent: "SIGTERM" }
    // 等 grace 后升级 SIGKILL（低频扫描：/proc 全量扫描在 WSL 高负载下昂贵）。
    const waitStart = Date.now()
    while (Date.now() - waitStart < graceMs) {
      if (overBudget()) return { processesRemaining: remainingNow(), signalSent: "SIGTERM" }
      const now = remainingNow()
      if (now === 0) return { processesRemaining: 0, signalSent: "SIGTERM" }
      sleep(100)
    }
  }
  killProcessGroup(pid, "SIGKILL")
  for (let i = 0; i < 12; i++) {
    if (overBudget()) return { processesRemaining: remainingNow(), signalSent: "SIGKILL" }
    const remaining = remainingNow()
    if (remaining === 0) return { processesRemaining: 0, signalSent: "SIGKILL" }
    sleep(100)
  }
  return { processesRemaining: remainingNow(), signalSent: "SIGKILL" }
}

export function sleep(ms: number): void {
  const sab = new SharedArrayBuffer(4)
  const arr = new Int32Array(sab)
  Atomics.wait(arr, 0, 0, ms)
}
