/** LNXF-1.0: isolation-domain lock (LF-5, plan §13.1).
 *
 *  main-workspace: exclusive write lock; worktree:<agent>: exclusive write
 *  lock; cache:<type>:<key>: exclusive (rw-locked) or shared (ro); artifact
 *  ids are immutable. Different worktrees write in parallel; the official
 *  workspace stays single-writer (CROSS_WORKTREE_SERIALIZATION /
 *  MAIN_WORKSPACE_MULTI_WRITER).
 */

export type LockKind = "exclusive" | "shared"

export class IsolationDomainLock {
  private readonly exclusive = new Map<string, string>() // key → holder
  private readonly shared = new Map<string, Set<string>>() // key → holders

  static mainWorkspaceKey(): string {
    return "main-workspace"
  }

  /** LNXF-R2 9.2：物理冲突域锁键（同物理目录别名 → 同键 → 单写者）。 */
  static physicalKey(physicalWorkspaceKey: string): string {
    return `workspace-physical:${physicalWorkspaceKey}`
  }

  static worktreeKey(agentId: string): string {
    return `worktree:${agentId}`
  }

  /**
   * GATE（GS-12）：按真实 workspace 身份（canonicalRealPath + dev/ino）的
   * 锁键 —— 同物理目录别名同键（单写者），不同 worktree（即使同 agent）
   * 不同键（允许并行）。
   */
  static workspaceKey(workspaceIdentity: string): string {
    return `workspace:${workspaceIdentity}`
  }

  static cacheKey(type: string, key: string): string {
    return `cache:${type}:${key}`
  }

  static artifactKey(artifactId: string): string {
    return `artifact:${artifactId}`
  }

  /** 尝试获取锁。kind=exclusive 需要无独占且无共享；shared 需要无独占。 */
  acquire(key: string, kind: LockKind, holder: string): boolean {
    if (kind === "exclusive") {
      if (this.exclusive.has(key) || (this.shared.get(key)?.size ?? 0) > 0) return false
      this.exclusive.set(key, holder)
      return true
    }
    if (this.exclusive.has(key)) return false
    const holders = this.shared.get(key) ?? new Set<string>()
    holders.add(holder)
    this.shared.set(key, holders)
    return true
  }

  release(key: string, holder: string): boolean {
    if (this.exclusive.get(key) === holder) {
      this.exclusive.delete(key)
      return true
    }
    const holders = this.shared.get(key)
    if (holders?.has(holder)) {
      holders.delete(holder)
      if (holders.size === 0) this.shared.delete(key)
      return true
    }
    return false
  }

  /** 立即获取或等待（同步接口：等待由调用方调度循环驱动）。 */
  tryAcquire(key: string, kind: LockKind, holder: string): boolean {
    return this.acquire(key, kind, holder)
  }

  heldBy(key: string): string | undefined {
    if (this.exclusive.has(key)) return this.exclusive.get(key)
    const holders = this.shared.get(key)
    return holders && holders.size > 0 ? [...holders].join(",") : undefined
  }

  /** 释放一个 holder 的全部锁（Agent 取消）。 */
  releaseAll(holder: string): number {
    let count = 0
    for (const [key, owner] of this.exclusive) {
      if (owner === holder) {
        this.exclusive.delete(key)
        count += 1
      }
    }
    for (const [key, holders] of this.shared) {
      if (holders.delete(holder)) {
        count += 1
        if (holders.size === 0) this.shared.delete(key)
      }
    }
    return count
  }

  /** 并行写判定（plan §13.2）：两个写目标是否互不冲突。 */
  canWriteInParallel(targetA: string, targetB: string): boolean {
    return IsolationDomainLock.worktreeKey(targetA) !== IsolationDomainLock.worktreeKey(targetB) && targetA !== "main-workspace" && targetB !== "main-workspace"
  }
}
