/** Concurrency controller (G3 + IC06 P0-6): read slots + single writer slot.
 *
 *  Read nodes may run up to maxParallel concurrently; write nodes are
 *  globally serialized (exactly one write node in flight at any time) —
 *  the WorkspaceWriteLock of the plan.
 *
 *  IC06（P0-6）硬化：
 *  - cancellable FIFO waiter（AbortSignal + deadline）；
 *  - atomic handoff：释放与接手在同一 tick 完成，旧 waiter 唤醒后不再
 *    二次抢锁（WRITE_LOCK_HANDOFF_RACE=0）；
 *  - owner token/identity：只有持有者能 release（idempotent，double
 *    release no-op —— RESOURCE_DOUBLE_RELEASE=0）；
 *  - cancelled waiter 移除（WRITE_LOCK_CANCELLED_WAITER_RESURRECTION=0）；
 *  - late wake guard：waiter 被取消后即使被唤醒也拒绝接手（锁直接释放，
 *    无死锁、无双 owner）。
 */

export interface WriteLockHandle {
  release(): void
  /** 锁身份（owner token —— 只有匹配的 release 有效）。 */
  readonly token: number
}

export interface AcquireWriteOptions {
  signal?: AbortSignal
  /** 有界等待（RESOURCE_WAIT_UNBOUNDED=0 的锁面）。 */
  deadlineMs?: number
}

interface WriteWaiter {
  resolve: (handle: WriteLockHandle) => void
  reject: (e: Error) => void
  token: number
  cancelled: boolean
  timer?: ReturnType<typeof setTimeout>
}

export class ConcurrencyController {
  private writeHeld = false
  private writeOwnerToken = 0
  private waiter: WriteWaiter | null = null
  private nextToken = 1

  /** Try to acquire the write slot without waiting. */
  tryAcquireWrite(): WriteLockHandle | null {
    if (this.writeHeld) return null
    this.writeHeld = true
    const token = this.nextToken++
    this.writeOwnerToken = token
    return { release: () => this.releaseWrite(token), token }
  }

  /** Wait for the write slot（写节点全局串行；多写者按到达序串行等待）。
   *  IC06：AbortSignal / deadline 可取消；原子 handoff。 */
  acquireWrite(options: AcquireWriteOptions = {}): Promise<WriteLockHandle> {
    if (!this.writeHeld) {
      this.writeHeld = true
      const token = this.nextToken++
      this.writeOwnerToken = token
      return Promise.resolve({ release: () => this.releaseWrite(token), token })
    }
    return new Promise<WriteLockHandle>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new Error("WRITE_LOCK_ACQUIRE_CANCELLED"))
        return
      }
      const token = this.nextToken++
      const waiter: WriteWaiter = {
        resolve: (handle) => {
          // late wake guard：已被取消的 waiter 被 handoff 唤醒 → 拒绝接手，
          // 锁直接释放（无死锁、无双 owner —— WRITE_LOCK_CANCELLED_WAITER_
          // RESURRECTION=0）。
          if (waiter.cancelled) {
            this.writeHeld = false
            this.writeOwnerToken = 0
            return
          }
          if (this.waiter === waiter) this.waiter = null
          clearTimeoutIfAny(waiter)
          options.signal?.removeEventListener("abort", onSignal)
          resolve(handle)
        },
        reject: (e) => {
          if (this.waiter === waiter) this.waiter = null
          clearTimeoutIfAny(waiter)
          options.signal?.removeEventListener("abort", onSignal)
          reject(e)
        },
        token,
        cancelled: false,
      }
      this.waiter = waiter
      const onSignal = () => {
        if (waiter.cancelled) return
        waiter.cancelled = true
        waiter.reject(new Error("WRITE_LOCK_ACQUIRE_CANCELLED"))
      }
      options.signal?.addEventListener("abort", onSignal, { once: true })
      if (options.deadlineMs !== undefined && options.deadlineMs > 0) {
        waiter.timer = setTimeout(() => onSignal(), options.deadlineMs)
        waiter.timer.unref?.()
      }
    })
  }

  /** 持有者释放（owner token 匹配才生效；double release / 非 owner no-op）。 */
  private releaseWrite(token: number): void {
    if (!this.writeHeld) return
    if (token !== this.writeOwnerToken) return // 非 owner / double release no-op
    const next = this.waiter
    if (next) {
      // 原子 handoff：同一 tick 内完成"释放→接手"—— writeHeld 保持 true，
      // 旧持有者与新 owner 之间不存在无主窗口（WRITE_LOCK_HANDOFF_RACE=0）。
      this.waiter = null
      this.writeOwnerToken = next.token
      next.resolve({ release: () => this.releaseWrite(next.token), token: next.token })
      return
    }
    this.writeHeld = false
    this.writeOwnerToken = 0
  }

  get writeBusy(): boolean {
    return this.writeHeld
  }
}

function clearTimeoutIfAny(waiter: WriteWaiter): void {
  if (waiter.timer) {
    clearTimeout(waiter.timer)
    waiter.timer = undefined
  }
}
