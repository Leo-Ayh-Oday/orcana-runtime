import { describe, expect, test } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import {
  assertWorldRecovered,
  createFileManifest,
  recoverWorldStore,
} from "../../../src/kernel/world"
import { createTestWorldStore } from "./helpers"

describe("AK-1 deterministic World snapshot", () => {
  test("the same World revision produces the same immutable snapshot", () => {
    const fixture = createTestWorldStore()
    try {
      fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      const file = createFileManifest(
        fixture.store.cas,
        Buffer.from("export const stable = true\n"),
        "text/typescript",
      )
      const artifact = fixture.store.cas.put(Buffer.from("report"), "text/plain")
      fixture.store.compareAndCommit({
        worldId: "w1",
        branchId: "main",
        baseRevision: 0n,
        actor: "agent:a",
        mutations: [
          {
            type: "object.put",
            objectId: "src/stable.ts",
            objectType: "file",
            path: "src/stable.ts",
            contentRef: file.digest,
          },
          {
            type: "object.put",
            objectId: "memory:decision",
            objectType: "memory",
            metadata: { decision: "world is authority" },
          },
          {
            type: "artifact.put",
            artifactId: "report",
            mediaType: "text/plain",
            contentRef: artifact.digest,
          },
          { type: "service.set", serviceId: "indexer", status: "ready" },
        ],
      })

      const first = fixture.store.createSnapshot("w1", "main")
      const second = fixture.store.createSnapshot("w1", "main")
      expect(second).toEqual(first)
      expect(fixture.store.snapshots.list("w1", "main")).toHaveLength(1)
      expect(fixture.store.cas.has(first.manifestDigest)).toBe(true)
      expect(fixture.store.ledger.list("w1").filter(event =>
        event.eventType === "world.snapshot.created",
      )).toHaveLength(1)

      const manifest = JSON.parse(fixture.store.cas.get(first.manifestDigest).toString())
      expect(manifest).toEqual(expect.objectContaining({
        worldId: "w1",
        branchId: "main",
        revision: "1",
        filesystemDigest: first.filesystemDigest,
      }))
    } finally {
      fixture.cleanup()
    }
  })

  test("a new World revision produces a different snapshot", () => {
    const fixture = createTestWorldStore()
    try {
      fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      fixture.store.compareAndCommit({
        worldId: "w1",
        branchId: "main",
        baseRevision: 0n,
        actor: "agent:a",
        mutations: [{ type: "service.set", serviceId: "indexer", status: "starting" }],
      })
      const first = fixture.store.createSnapshot("w1", "main")
      fixture.store.compareAndCommit({
        worldId: "w1",
        branchId: "main",
        baseRevision: 1n,
        actor: "agent:a",
        mutations: [{ type: "service.set", serviceId: "indexer", status: "ready" }],
      })
      const second = fixture.store.createSnapshot("w1", "main")
      expect(second.revision).toBe(2n)
      expect(second.snapshotId).not.toBe(first.snapshotId)
      expect(second.manifestDigest).not.toBe(first.manifestDigest)
    } finally {
      fixture.cleanup()
    }
  })
})

describe("AK-1 recovery", () => {
  test("CAS objects written without a manifest/link are collected", () => {
    const fixture = createTestWorldStore()
    try {
      fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      const orphan = fixture.store.cas.put(Buffer.from("orphan"), "text/plain")
      expect(existsSync(fixture.store.cas.resolveObjectPath(orphan.digest))).toBe(true)
      const report = recoverWorldStore(fixture.store)
      expect(report.removedUnreachableObjects).toContain(orphan.digest)
      expect(fixture.store.cas.record(orphan.digest)).toBeUndefined()
      expect(existsSync(fixture.store.cas.resolveObjectPath(orphan.digest))).toBe(false)
      assertWorldRecovered(report)
    } finally {
      fixture.cleanup()
    }
  })

  test("a committed manifest with missing CAS bytes fails closed and marks the World corrupted", () => {
    const fixture = createTestWorldStore()
    try {
      fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      const file = createFileManifest(fixture.store.cas, Buffer.from("committed"), "text/plain")
      fixture.store.compareAndCommit({
        worldId: "w1",
        branchId: "main",
        baseRevision: 0n,
        actor: "agent:a",
        mutations: [{
          type: "object.put",
          objectId: "file",
          objectType: "file",
          contentRef: file.digest,
        }],
      })
      rmSync(fixture.store.cas.resolveObjectPath(file.digest), { force: true })

      const report = recoverWorldStore(fixture.store)
      expect(report.integrityIssues.some(issue =>
        issue.code === "CAS_MISSING_REFERENCED_OBJECT",
      )).toBe(true)
      expect(report.corruptedWorldIds).toEqual(["w1"])
      expect(fixture.store.getWorld("w1")?.status).toBe("corrupted")
      expect(() => assertWorldRecovered(report)).toThrow(/WORLD_CORRUPTED/)
    } finally {
      fixture.cleanup()
    }
  })
})
