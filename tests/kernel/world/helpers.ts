import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WorldStore, type WorldFaultPoint } from "../../../src/kernel/world"

export interface TestWorldStore {
  readonly root: string
  readonly store: WorldStore
  readonly cleanup: () => void
}

export function removeTestWorldRoot(root: string): void {
  if (!existsSync(root)) return
  chmodSync(root, 0o700)
  const recovery = join(root, "recovery")
  if (existsSync(recovery)) chmodSync(recovery, 0o700)
  rmSync(root, { recursive: true, force: true })
}

export function createTestWorldStore(options: {
  readonly root?: string
  readonly faultInjector?: (point: WorldFaultPoint) => void
  readonly nowStart?: number
} = {}): TestWorldStore {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "orcana-world-"))
  let now = options.nowStart ?? 1_000
  let id = 0
  const store = new WorldStore(root, {
    now: () => now++,
    idFactory: kind => `${kind}-test-${++id}`,
    faultInjector: options.faultInjector,
  })
  return {
    root,
    store,
    cleanup: () => {
      try {
        store.close()
      } finally {
        removeTestWorldRoot(root)
      }
    },
  }
}
