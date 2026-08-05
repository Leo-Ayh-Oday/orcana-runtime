/** Concurrency controller (G3): read slots + single writer slot.
 *
 *  Read nodes may run up to maxParallel concurrently; write nodes are
 *  globally serialized (exactly one write node in flight at any time) —
 *  the WorkspaceWriteLock of the plan.
 */

export interface WriteLockHandle {
  release(): void
}

export class ConcurrencyController {
  private writeHeld = false
  private writeWaiters: Array<() => void> = []

  /** Try to acquire the write slot without waiting. */
  tryAcquireWrite(): WriteLockHandle | null {
    if (this.writeHeld) return null
    this.writeHeld = true
    return { release: () => this.releaseWrite() }
  }

  /** Wait for the write slot (FIFO). */
  async acquireWrite(): Promise<WriteLockHandle> {
    if (this.writeHeld) {
      await new Promise<void>(resolve => this.writeWaiters.push(resolve))
    }
    this.writeHeld = true
    return { release: () => this.releaseWrite() }
  }

  private releaseWrite(): void {
    this.writeHeld = false
    const next = this.writeWaiters.shift()
    if (next) next()
  }

  get writeBusy(): boolean {
    return this.writeHeld
  }
}
