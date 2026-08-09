import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, rmSync } from "node:fs"
import {
  assertWorldRecovered,
  createFileManifest,
  encodeCasOwnerId,
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
      const serviceSection = JSON.parse(
        fixture.store.cas.get(first.serviceStateDigest).toString(),
      )
      const artifactSection = JSON.parse(
        fixture.store.cas.get(first.artifactStateDigest).toString(),
      )
      expect(serviceSection.entries[0].metadata.status).toBe("ready")
      expect(artifactSection.entries[0].metadata.mediaType).toBe("text/plain")

      const db = new Database(fixture.store.databasePath)
      try {
        expect(() => db.run(
          `INSERT INTO world_snapshots (
             snapshot_id, world_id, branch_id, revision, manifest_digest,
             filesystem_digest, memory_digest, task_state_digest,
             capability_state_digest, service_state_digest, artifact_state_digest, created_at
           ) SELECT 'snapshot:forged', world_id, branch_id, revision,
                    manifest_digest, filesystem_digest, memory_digest, task_state_digest,
                    capability_state_digest, service_state_digest, artifact_state_digest, created_at
             FROM world_snapshots WHERE snapshot_id = ?`,
          [first.snapshotId],
        )).toThrow()
      } finally {
        db.close()
      }
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

  test("reserved service and artifact metadata cannot shadow authoritative fields", () => {
    const fixture = createTestWorldStore()
    try {
      fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      expect(() => fixture.store.compareAndCommit({
        worldId: "w1",
        branchId: "main",
        baseRevision: 0n,
        actor: "agent:a",
        mutations: [{
          type: "service.set",
          serviceId: "reviewer",
          status: "ready",
          metadata: { status: "stopped" },
        }],
      })).toThrow(/metadata key is reserved/)
      const artifact = fixture.store.cas.put(Buffer.from("artifact"), "text/plain")
      expect(() => fixture.store.compareAndCommit({
        worldId: "w1",
        branchId: "main",
        baseRevision: 0n,
        actor: "agent:a",
        mutations: [{
          type: "artifact.put",
          artifactId: "report",
          mediaType: "text/plain",
          contentRef: artifact.digest,
          metadata: { mediaType: "application/forged" },
        }],
      })).toThrow(/metadata key is reserved/)
      expect(fixture.store.getWorld("w1")?.currentRevision).toBe(0n)
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

  test("a missing authoritative root link blocks GC and preserves recoverable bytes", () => {
    const fixture = createTestWorldStore()
    try {
      fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      const file = createFileManifest(fixture.store.cas, Buffer.from("preserve me"), "text/plain")
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
      const db = new Database(fixture.store.databasePath)
      try {
        db.run(
          "DELETE FROM cas_links WHERE owner_type = ? AND owner_id = ? AND digest = ?",
          ["world_object", encodeCasOwnerId(["w1", "main", "file"]), file.digest],
        )
      } finally {
        db.close()
      }

      const report = recoverWorldStore(fixture.store)
      expect(report.integrityIssues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "CAS_REFERENCE_DIVERGENCE" }),
      ]))
      expect(report.removedUnreachableObjects).not.toContain(file.digest)
      expect(fixture.store.cas.record(file.digest)).toBeDefined()
      expect(existsSync(fixture.store.cas.resolveObjectPath(file.digest))).toBe(true)
      expect(fixture.store.getWorld("w1")?.status).toBe("corrupted")
    } finally {
      fixture.cleanup()
    }
  })

  test("manifest edges are verified from immutable content even if media metadata is tampered", () => {
    const fixture = createTestWorldStore()
    try {
      fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      const file = createFileManifest(fixture.store.cas, Buffer.from("preserve chunk"), "text/plain")
      const chunkDigest = file.manifest.chunks[0]!.digest
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

      const db = new Database(fixture.store.databasePath)
      try {
        expect(() => db.run(
          "UPDATE cas_objects SET media_type = 'text/plain' WHERE digest = ?",
          [file.digest],
        )).toThrow(/CAS_OBJECT_METADATA_IMMUTABLE/)
        db.run("DROP TRIGGER cas_objects_immutable_metadata")
        db.run("UPDATE cas_objects SET media_type = 'text/plain' WHERE digest = ?", [file.digest])
        db.run(
          "DELETE FROM cas_links WHERE owner_type = 'cas_object' AND owner_id = ? AND digest = ?",
          [file.digest, chunkDigest],
        )
      } finally {
        db.close()
      }

      const report = recoverWorldStore(fixture.store)
      expect(report.integrityIssues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "CAS_REFERENCE_DIVERGENCE",
          detail: expect.stringContaining(file.digest),
        }),
      ]))
      expect(report.removedUnreachableObjects).not.toContain(chunkDigest)
      expect(fixture.store.cas.record(chunkDigest)).toBeDefined()
      expect(existsSync(fixture.store.cas.resolveObjectPath(chunkDigest))).toBe(true)
      expect(fixture.store.getWorld("w1")?.status).toBe("corrupted")
    } finally {
      fixture.cleanup()
    }
  })
})
