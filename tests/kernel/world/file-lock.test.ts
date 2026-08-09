import { describe, expect, test } from "bun:test"
import { closeSync, mkdtempSync, openSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withExclusiveFileLock } from "../../../src/kernel/world/file-lock"
import { removeTestWorldRoot } from "./helpers"

describe("AK-1 WorldDB bootstrap file lock", () => {
  test("non-contention flock errors fail immediately with errno", () => {
    const startedAt = performance.now()
    expect(() => withExclusiveFileLock(-1, () => undefined)).toThrow(
      /WORLD_DB_BOOTSTRAP_LOCK_FAILED: errno=9/,
    )
    expect(performance.now() - startedAt).toBeLessThan(1_000)
  })

  test("contention uses a bounded monotonic timeout", () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-world-flock-"))
    const path = join(root, "lock")
    const ownerFd = openSync(path, "w+")
    const contenderFd = openSync(path, "r+")
    try {
      withExclusiveFileLock(ownerFd, () => {
        const startedAt = performance.now()
        expect(() => withExclusiveFileLock(contenderFd, () => undefined, 20)).toThrow(
          /WORLD_DB_BOOTSTRAP_BUSY/,
        )
        const elapsed = performance.now() - startedAt
        expect(elapsed).toBeGreaterThanOrEqual(20)
        expect(elapsed).toBeLessThan(1_000)
      })
    } finally {
      closeSync(contenderFd)
      closeSync(ownerFd)
      removeTestWorldRoot(root)
    }
  })
})
