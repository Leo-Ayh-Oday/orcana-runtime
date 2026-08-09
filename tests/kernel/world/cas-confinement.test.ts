import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  recoverWorldStore,
  sha256Digest,
  WorldStore,
} from "../../../src/kernel/world"
import { createTestWorldStore, removeTestWorldRoot } from "./helpers"

describe("AK-1 CAS filesystem confinement", () => {
  test("a configured World root symlink is rejected before subdirectories are created", () => {
    const parent = mkdtempSync(join(tmpdir(), "orcana-world-root-parent-"))
    const outside = mkdtempSync(join(tmpdir(), "orcana-world-root-outside-"))
    const root = join(parent, "world-link")
    try {
      writeFileSync(join(outside, "sentinel"), "outside")
      symlinkSync(outside, root, "dir")
      expect(() => new WorldStore(root)).toThrow(/World root must be a real directory/)
      expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("outside")
      expect(existsSync(join(outside, "ledger"))).toBe(false)
    } finally {
      rmSync(parent, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("objects and staging roots reject pre-existing symlinks", () => {
    for (const relative of [
      ["cas", "sha256"],
      ["recovery", "cas-staging"],
    ]) {
      const root = mkdtempSync(join(tmpdir(), "orcana-world-cas-root-"))
      const outside = mkdtempSync(join(tmpdir(), "orcana-world-cas-outside-"))
      const target = join(root, ...relative)
      try {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(join(outside, "sentinel"), "outside")
        symlinkSync(outside, target, "dir")
        expect(() => new WorldStore(root)).toThrow()
        expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("outside")
      } finally {
        removeTestWorldRoot(root)
        rmSync(outside, { recursive: true, force: true })
      }
    }
  })

  test("a pre-existing WorldDB symlink is rejected without touching its target", () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-world-db-root-"))
    const outside = mkdtempSync(join(tmpdir(), "orcana-world-db-outside-"))
    const outsideDatabase = join(outside, "sentinel.db")
    try {
      writeFileSync(outsideDatabase, "must survive")
      symlinkSync(outsideDatabase, join(root, "world.db"), "file")
      expect(() => new WorldStore(root)).toThrow()
      expect(readFileSync(outsideDatabase, "utf8")).toBe("must survive")
      expect(existsSync(`${outsideDatabase}-wal`)).toBe(false)
      expect(existsSync(`${outsideDatabase}-shm`)).toBe(false)
    } finally {
      removeTestWorldRoot(root)
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("SQLite WAL, SHM, and journal symlinks are rejected without touching targets", () => {
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const root = mkdtempSync(join(tmpdir(), "orcana-world-sidecar-root-"))
      const outside = mkdtempSync(join(tmpdir(), "orcana-world-sidecar-outside-"))
      const sentinel = join(outside, "sentinel")
      try {
        const seed = new WorldStore(root)
        seed.close()
        chmodSync(root, 0o700)
        rmSync(join(root, `world.db${suffix}`), { force: true })
        writeFileSync(sentinel, "must survive")
        symlinkSync(sentinel, join(root, `world.db${suffix}`), "file")

        expect(() => new WorldStore(root)).toThrow()
        expect(readFileSync(sentinel, "utf8")).toBe("must survive")
      } finally {
        removeTestWorldRoot(root)
        rmSync(outside, { recursive: true, force: true })
      }
    }
  })

  test("WorldDB entries cannot be replaced after no-follow verification and parent lock", () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-world-db-race-root-"))
    const outside = mkdtempSync(join(tmpdir(), "orcana-world-db-race-outside-"))
    let observed = false
    try {
      const store = new WorldStore(root, {
        faultInjector: point => {
          if (point !== "after_world_db_entries_locked") return
          observed = true
          expect(() => renameSync(
            join(root, "world.db"),
            join(outside, "escaped.db"),
          )).toThrow()
        },
      })
      store.close()
      expect(observed).toBe(true)
      expect(existsSync(join(root, "world.db"))).toBe(true)
      expect(existsSync(join(outside, "escaped.db"))).toBe(false)
    } finally {
      removeTestWorldRoot(root)
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("closing one concurrent Store never unlocks another Store's WorldDB entries", () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-world-db-multi-open-"))
    let first: WorldStore | undefined
    let second: WorldStore | undefined
    try {
      first = new WorldStore(root)
      second = new WorldStore(root)
      first.close()
      first = undefined

      expect(statSync(root).mode & 0o222).toBe(0)
      expect(() => writeFileSync(join(root, "rogue-entry"), "blocked")).toThrow()
      expect(second.verifyIntegrity()).toEqual([])
      second.close()
      second = undefined
      expect(statSync(root).mode & 0o222).toBe(0)
    } finally {
      first?.close()
      second?.close()
      removeTestWorldRoot(root)
    }
  })

  test("an open store remains pinned to a durably-created World root after pathname replacement", () => {
    const parent = mkdtempSync(join(tmpdir(), "orcana-world-root-replace-"))
    const root = join(parent, "world")
    const originalRoot = join(parent, "world-original")
    const digest = sha256Digest("pinned root")
    let store: WorldStore | undefined
    try {
      expect(existsSync(root)).toBe(false)
      store = new WorldStore(root)
      expect(existsSync(root)).toBe(true)
      store.createWorld({ worldId: "w1", owner: "user:owner" })

      renameSync(root, originalRoot)
      mkdirSync(root)

      const content = store.cas.put(Buffer.from("pinned root"), "text/plain")
      expect(content.digest).toBe(digest)
      store.compareAndCommit({
        worldId: "w1",
        branchId: "main",
        baseRevision: 0n,
        actor: "agent:test",
        commitId: "commit-pinned-root",
        mutations: [{
          type: "object.put",
          objectId: "pinned",
          objectType: "file",
          contentRef: digest,
        }],
      })
      store.close()
      store = undefined

      const hex = digest.slice("sha256:".length)
      expect(existsSync(join(originalRoot, "cas", "sha256", hex.slice(0, 2), hex))).toBe(true)
      expect(existsSync(join(root, "cas"))).toBe(false)
      expect(existsSync(join(root, "world.db"))).toBe(false)

      const reopened = new WorldStore(originalRoot)
      try {
        expect(reopened.getWorld("w1")?.currentRevision).toBe(1n)
        expect(reopened.cas.get(digest).toString()).toBe("pinned root")
        expect(reopened.verifyIntegrity()).toEqual([])
      } finally {
        reopened.close()
      }
    } finally {
      store?.close()
      removeTestWorldRoot(originalRoot)
      removeTestWorldRoot(root)
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test("digest-prefix symlinks cannot redirect put or recovery deletion", () => {
    const fixture = createTestWorldStore()
    const outside = mkdtempSync(join(tmpdir(), "orcana-world-cas-prefix-outside-"))
    try {
      fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      const digest = sha256Digest("outside escape")
      const hex = digest.slice("sha256:".length)
      const outsideFile = join(outside, hex)
      writeFileSync(outsideFile, "must survive")
      symlinkSync(outside, join(fixture.store.cas.objectsRoot, hex.slice(0, 2)), "dir")

      expect(() => fixture.store.cas.put(Buffer.from("outside escape"), "text/plain")).toThrow()
      expect(existsSync(join(outside, hex))).toBe(true)
      expect(() => recoverWorldStore(fixture.store)).toThrow(/unsafe CAS prefix path/)
      expect(readFileSync(outsideFile, "utf8")).toBe("must survive")
      expect(fixture.store.getWorld("w1")?.status).toBe("active")
    } finally {
      fixture.cleanup()
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("recovery refuses staging-entry symlinks without touching their targets", () => {
    const fixture = createTestWorldStore()
    const outside = mkdtempSync(join(tmpdir(), "orcana-world-cas-staging-outside-"))
    try {
      fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      const outsideFile = join(outside, "sentinel")
      writeFileSync(outsideFile, "must survive")
      symlinkSync(outsideFile, join(fixture.store.cas.stagingRoot, "malicious.tmp"), "file")

      expect(() => recoverWorldStore(fixture.store)).toThrow(/unsafe CAS staging entry/)
      expect(readFileSync(outsideFile, "utf8")).toBe("must survive")
      expect(fixture.store.getWorld("w1")?.status).toBe("active")
    } finally {
      fixture.cleanup()
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
