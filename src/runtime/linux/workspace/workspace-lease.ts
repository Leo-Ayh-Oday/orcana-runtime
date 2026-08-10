/** GATE（GS-13）：跨进程 workspace 写互斥。
 *
 *  IsolationDomainLock 是进程内 Map —— Claude/Codex/Orcana 进程 1 与
 *  进程 2 互相不知道对方。本 lease 用 mkdir 原子性做 OS 级互斥：
 *    mkdir(lockDir) 成功 = 持有；EEXIST = 他方持有。
 *  owner 文件记录 pid/startedAt；stale 判定 = 超时（默认 10s）且
 *  owner pid 不存在 → 清理后重试一次。
 *
 *  锁目录默认 ~/.orcana/runtime/linux/leases（ORCANA_LEASE_ROOT 可覆盖，
 *  评测环境可指向受控目录）。
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface WorkspaceLeaseOptions {
  leaseRoot?: string
  staleTimeoutMs?: number
}

export interface WorkspaceLeaseResult {
  ok: boolean
  reason?: string
  /** 释放句柄（获得时提供）。 */
  release?: () => void
}

export class CrossProcessWorkspaceLease {
  private readonly leaseRoot: string
  private readonly staleTimeoutMs: number

  constructor(options: WorkspaceLeaseOptions = {}) {
    this.leaseRoot = options.leaseRoot
      ?? process.env.ORCANA_LEASE_ROOT
      ?? join(homedir(), ".orcana", "runtime", "linux", "leases")
    this.staleTimeoutMs = options.staleTimeoutMs ?? 10_000
  }

  /** 获取 workspace 写互斥。失败（他方持有且非 stale）→ ok=false。 */
  acquire(workspaceIdentity: string): WorkspaceLeaseResult {
    const lockDir = this.lockDirOf(workspaceIdentity)
    try {
      // 父目录可能不存在（首次运行）——递归创建不抢锁（递归 mkdir 对叶
      // 目录仍是原子的，EEXIST 竞态语义不变）。
      mkdirSync(this.leaseRoot, { recursive: true })
      mkdirSync(lockDir, { recursive: false })
      try {
        writeFileSync(join(lockDir, "owner"), `${process.pid}\n${Date.now()}\n`, { flag: "wx" })
      } catch {
        // owner 写入失败（并发竞态）→ 视为未持锁
        rmSync(lockDir, { recursive: true, force: true })
        return { ok: false, reason: "lease owner write failed" }
      }
      return {
        ok: true,
        release: () => {
          try { rmSync(lockDir, { recursive: true, force: true }) } catch { /* best-effort */ }
        },
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EEXIST") {
        return { ok: false, reason: `lease acquire failed: ${String(error)}` }
      }
      // EEXIST —— 检查 stale：owner pid 不存在且超时 → 抢占。
      if (this.isStale(lockDir)) {
        try { rmSync(lockDir, { recursive: true, force: true }) } catch { /* best-effort */ }
        return this.acquire(workspaceIdentity)
      }
      return { ok: false, reason: `workspace lease held: ${workspaceIdentity}` }
    }
  }

  private lockDirOf(workspaceIdentity: string): string {
    const digest = createHash("sha256").update(workspaceIdentity).digest("hex").slice(0, 16)
    return join(this.leaseRoot, digest)
  }

  private isStale(lockDir: string): boolean {
    try {
      const ownerFile = join(lockDir, "owner")
      if (!existsSync(ownerFile)) return false // 无 owner 信息 —— 保守视为持有
      const [pidText] = readFileSync(ownerFile, "utf8").trim().split("\n")
      const ownerPid = Number(pidText)
      // 持有者已死（进程崩溃/被 kill/测试进程退出）→ 立即接管 —— 无需等待
      // 超时：崩溃残留不应阻塞新进程 10 秒。pid 复用安全：被复用后
      // kill(pid,0) 成功 → 视为活持有者 → 不误抢。
      try {
        process.kill(ownerPid, 0)
        return false
      } catch {
        return true
      }
    } catch {
      return false
    }
  }
}
