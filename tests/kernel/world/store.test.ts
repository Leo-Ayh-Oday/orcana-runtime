import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  canonicalDigest,
  encodeCasOwnerId,
  recoverWorldStore,
  WorldConflictError,
  WorldStore,
  type WorldCommitRequest,
} from "../../../src/kernel/world"
import { createTestWorldStore } from "./helpers"

describe("AK-1 WorldStore", () => {
  test("creates the WorldDB schema and revision-zero world atomically", () => {
    const fixture = createTestWorldStore()
    try {
      const world = fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      expect(world.currentRevision).toBe(0n)
      expect(world.currentBranchId).toBe("main")
      expect(fixture.store.getBranch("w1", "main")?.headRevision).toBe(0n)
      expect(fixture.store.ledger.list("w1").map(event => event.eventType)).toEqual([
        "world.created",
      ])

      const db = new Database(fixture.store.databasePath, { readonly: true })
      try {
        const names = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all()
          .map(row => row.name)
        expect(names).toEqual([
          "cas_links",
          "cas_objects",
          "world_artifacts",
          "world_branches",
          "world_commits",
          "world_events",
          "world_heads",
          "world_meta",
          "world_objects",
          "world_schema_meta",
          "world_services",
          "world_snapshots",
        ])
      } finally {
        db.close()
      }
    } finally {
      fixture.cleanup()
    }
  })

  test("compare-and-commit materializes objects and ledger events in one revision", () => {
    const fixture = createTestWorldStore()
    try {
      fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      const content = fixture.store.cas.put(Buffer.from("export const x = 1\n"), "text/typescript")
      const receipt = fixture.store.compareAndCommit({
        worldId: "w1",
        branchId: "main",
        baseRevision: 0n,
        actor: "agent:a1",
        commitId: "commit-1",
        executionReceiptIds: ["exec-1"],
        mutations: [
          {
            type: "object.put",
            objectId: "src/index.ts",
            objectType: "file",
            path: "src/index.ts",
            contentRef: content.digest,
            metadata: { language: "typescript" },
          },
        ],
      })

      expect(receipt.baseRevision).toBe(0n)
      expect(receipt.newRevision).toBe(1n)
      expect(fixture.store.getWorld("w1")?.currentRevision).toBe(1n)
      expect(fixture.store.getBranch("w1", "main")?.headRevision).toBe(1n)
      expect(fixture.store.listObjects("w1", "main")).toEqual([
        expect.objectContaining({
          objectId: "src/index.ts",
          contentRef: content.digest,
          updatedRevision: 1n,
        }),
      ])
      expect(fixture.store.cas.record(content.digest)?.refCount).toBe(1)
      expect(fixture.store.ledger.eventsForCommit("commit-1").map(event => event.eventType)).toEqual([
        "world.object.updated",
        "world.commit",
      ])
      expect(fixture.store.verifyIntegrity()).toEqual([])
    } finally {
      fixture.cleanup()
    }
  })

  test("stale base revisions never split WorldDB and branch HEAD", () => {
    const fixture = createTestWorldStore()
    let peer: WorldStore | undefined
    try {
      fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      peer = new WorldStore(fixture.root)
      const first = fixture.store.cas.put(Buffer.from("first"), "text/plain")
      const second = fixture.store.cas.put(Buffer.from("second"), "text/plain")
      fixture.store.compareAndCommit({
        worldId: "w1",
        branchId: "main",
        baseRevision: 0n,
        actor: "agent:a",
        mutations: [{
          type: "object.put",
          objectId: "a",
          objectType: "file",
          contentRef: first.digest,
        }],
      })

      expect(() =>
        peer!.compareAndCommit({
          worldId: "w1",
          branchId: "main",
          baseRevision: 0n,
          actor: "agent:b",
          mutations: [{
            type: "object.put",
            objectId: "b",
            objectType: "file",
            contentRef: second.digest,
          }],
        }),
      ).toThrow(WorldConflictError)
      expect(peer.getWorld("w1")?.currentRevision).toBe(1n)
      expect(peer.getBranch("w1", "main")?.headRevision).toBe(1n)
      const recovery = recoverWorldStore(peer)
      expect(recovery.removedUnreachableObjects).toContain(second.digest)
      expect(peer.verifyIntegrity()).toEqual([])
    } finally {
      peer?.close()
      fixture.cleanup()
    }
  })

  test("the WorldLedger is append-only at the database boundary", () => {
    const fixture = createTestWorldStore()
    try {
      fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      const db = new Database(fixture.store.databasePath)
      try {
        expect(() => db.run("UPDATE world_events SET event_type = 'forged'")).toThrow(
          /WORLD_LEDGER_APPEND_ONLY/,
        )
        expect(() => db.run("DELETE FROM world_events")).toThrow(/WORLD_LEDGER_APPEND_ONLY/)
      } finally {
        db.close()
      }
      expect(fixture.store.ledger.list("w1")).toHaveLength(1)
    } finally {
      fixture.cleanup()
    }
  })

  test("commit receipts are immutable and historical ledger divergence is detected", () => {
    const fixture = createTestWorldStore()
    try {
      fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      fixture.store.compareAndCommit({
        worldId: "w1",
        branchId: "main",
        baseRevision: 0n,
        actor: "agent:a",
        commitId: "commit-1",
        mutations: [{ type: "service.set", serviceId: "indexer", status: "starting" }],
      })
      fixture.store.compareAndCommit({
        worldId: "w1",
        branchId: "main",
        baseRevision: 1n,
        actor: "agent:a",
        commitId: "commit-2",
        mutations: [{ type: "service.set", serviceId: "indexer", status: "ready" }],
      })
      fixture.store.createSnapshot("w1", "main")

      const db = new Database(fixture.store.databasePath)
      try {
        expect(() => db.run("UPDATE world_commits SET actor = 'forged'")).toThrow(
          /WORLD_COMMIT_IMMUTABLE/,
        )
        expect(() => db.run("DELETE FROM world_snapshots")).toThrow(
          /WORLD_SNAPSHOT_IMMUTABLE/,
        )
        db.run(
          `INSERT INTO world_events (
             event_id, world_id, branch_id, revision, commit_id, event_type,
             actor, payload_digest, payload_json, occurred_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            "forged-event",
            "w1",
            "main",
            "1",
            "commit-1",
            "forged.event",
            "attacker",
            "sha256:forged",
            "{}",
            1,
          ],
        )
      } finally {
        db.close()
      }
      expect(fixture.store.verifyIntegrity()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "LEDGER_DB_DIVERGENCE",
          detail: expect.stringContaining("commit-1"),
        }),
        expect.objectContaining({
          code: "LEDGER_DB_DIVERGENCE",
          detail: expect.stringContaining("forged-event"),
        }),
      ]))
    } finally {
      fixture.cleanup()
    }
  })

  test("CAS root owner tuples cannot collide across World and branch identifiers", () => {
    const fixture = createTestWorldStore()
    try {
      fixture.store.createWorld({ worldId: "a", branchId: "b:c", owner: "user:one" })
      fixture.store.createWorld({ worldId: "a:b", branchId: "c", owner: "user:two" })
      const content = fixture.store.cas.put(Buffer.from("shared"), "text/plain")
      for (const [worldId, branchId] of [["a", "b:c"], ["a:b", "c"]] as const) {
        fixture.store.compareAndCommit({
          worldId,
          branchId,
          baseRevision: 0n,
          actor: "agent:a",
          mutations: [{
            type: "object.put",
            objectId: "d",
            objectType: "file",
            contentRef: content.digest,
          }],
        })
      }
      expect(encodeCasOwnerId(["a", "b:c", "d"])).not.toBe(
        encodeCasOwnerId(["a:b", "c", "d"]),
      )
      expect(fixture.store.cas.record(content.digest)?.refCount).toBe(2)
      fixture.store.compareAndCommit({
        worldId: "a",
        branchId: "b:c",
        baseRevision: 1n,
        actor: "agent:a",
        mutations: [{ type: "object.delete", objectId: "d" }],
      })
      expect(fixture.store.cas.record(content.digest)?.refCount).toBe(1)
      expect(fixture.store.cas.gc()).not.toContain(content.digest)
      expect(fixture.store.cas.get(content.digest).toString()).toBe("shared")
      expect(fixture.store.verifyIntegrity()).toEqual([])
    } finally {
      fixture.cleanup()
    }
  })

  test("materialized tampering and valid-digest orphan events fail integrity", () => {
    const fixture = createTestWorldStore()
    try {
      fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      fixture.store.compareAndCommit({
        worldId: "w1",
        branchId: "main",
        baseRevision: 0n,
        actor: "agent:a",
        mutations: [{ type: "service.set", serviceId: "indexer", status: "ready" }],
      })
      const forgedPayload = { forged: true }
      const db = new Database(fixture.store.databasePath)
      try {
        db.run("UPDATE world_services SET status = 'forged' WHERE service_id = 'indexer'")
        db.run(
          `INSERT INTO world_events (
             event_id, world_id, branch_id, revision, event_type, actor,
             payload_digest, payload_json, occurred_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            "orphan-valid-event",
            "w1",
            "main",
            "1",
            "forged.event",
            "attacker",
            canonicalDigest(forgedPayload),
            JSON.stringify(forgedPayload),
            1,
          ],
        )
      } finally {
        db.close()
      }
      const issues = fixture.store.verifyIntegrity()
      expect(issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "LEDGER_DB_DIVERGENCE",
          detail: expect.stringContaining("materialized state"),
        }),
        expect.objectContaining({
          code: "LEDGER_DB_DIVERGENCE",
          detail: expect.stringContaining("no governed commit/snapshot semantics"),
        }),
      ]))
      const report = recoverWorldStore(fixture.store)
      expect(report.corruptedWorldIds).toEqual(["w1"])
      expect(fixture.store.getWorld("w1")?.status).toBe("corrupted")
    } finally {
      fixture.cleanup()
    }
  })

  test("unknown schema versions fail closed on reopen", () => {
    const fixture = createTestWorldStore()
    let closed = false
    try {
      fixture.store.close()
      closed = true
      const db = new Database(join(fixture.root, "world.db"))
      try {
        db.run("UPDATE world_schema_meta SET schema_version = 999")
      } finally {
        db.close()
      }
      expect(() => new WorldStore(fixture.root)).toThrow(/WORLD_SCHEMA_INCOMPATIBLE/)
    } finally {
      if (!closed) fixture.store.close()
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  test("empty or structurally spoofed installed schemas fail closed", () => {
    for (const corrupt of [
      (db: Database) => db.run("DELETE FROM world_schema_meta"),
      (db: Database) => db.run("DROP TRIGGER cas_objects_immutable_metadata"),
    ]) {
      const fixture = createTestWorldStore()
      fixture.store.close()
      const db = new Database(join(fixture.root, "world.db"))
      try {
        corrupt(db)
      } finally {
        db.close()
      }
      try {
        expect(() => new WorldStore(fixture.root)).toThrow(/WORLD_SCHEMA_INCOMPATIBLE/)
      } finally {
        rmSync(fixture.root, { recursive: true, force: true })
      }
    }
  })

  test("metadata is limited to reversible canonical JSON", () => {
    const fixture = createTestWorldStore()
    try {
      fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      const cyclic: Record<string, unknown> = {}
      cyclic.self = cyclic
      const accessor = Object.defineProperty({}, "unsafe", {
        enumerable: true,
        get: () => {
          throw new Error("accessor must not execute")
        },
      })
      const invalidValues: unknown[] = [
        undefined,
        1n,
        new Date(0),
        new Map([["key", "value"]]),
        new Uint8Array([1]),
        cyclic,
        accessor,
        Array(1),
      ]
      for (const unsafe of invalidValues) {
        expect(() => fixture.store.compareAndCommit({
          worldId: "w1",
          branchId: "main",
          baseRevision: 0n,
          actor: "agent:a",
          mutations: [{
            type: "service.set",
            serviceId: "indexer",
            status: "ready",
            metadata: { unsafe },
          }],
        })).toThrow(/canonical JSON/)
      }
      expect(fixture.store.getWorld("w1")?.currentRevision).toBe(0n)
    } finally {
      fixture.cleanup()
    }
  })

  test("an unchanged contentRef is revalidated before metadata-only updates", () => {
    const fixture = createTestWorldStore()
    try {
      fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      const content = fixture.store.cas.put(Buffer.from("trusted"), "text/plain")
      fixture.store.compareAndCommit({
        worldId: "w1",
        branchId: "main",
        baseRevision: 0n,
        actor: "agent:a",
        mutations: [{
          type: "object.put",
          objectId: "file",
          objectType: "file",
          contentRef: content.digest,
          metadata: { version: 1 },
        }],
      })
      writeFileSync(fixture.store.cas.resolveObjectPath(content.digest), "corrupt")

      expect(() => fixture.store.compareAndCommit({
        worldId: "w1",
        branchId: "main",
        baseRevision: 1n,
        actor: "agent:a",
        mutations: [{
          type: "object.put",
          objectId: "file",
          objectType: "file",
          contentRef: content.digest,
          metadata: { version: 2 },
        }],
      })).toThrow(/CAS object content is corrupt/)
      expect(fixture.store.getWorld("w1")?.currentRevision).toBe(1n)
      expect(fixture.store.listObjects("w1", "main")[0]?.metadata).toEqual({ version: 1 })
    } finally {
      fixture.cleanup()
    }
  })

  test("a fault before commit rolls back materialized state and ledger together", () => {
    const fixture = createTestWorldStore({
      faultInjector: point => {
        if (point === "after_ledger_before_commit") throw new Error("CRASH_BEFORE_COMMIT")
      },
    })
    try {
      fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      const content = fixture.store.cas.put(Buffer.from("candidate"), "text/plain")
      expect(() =>
        fixture.store.compareAndCommit({
          worldId: "w1",
          branchId: "main",
          baseRevision: 0n,
          actor: "agent:a",
          commitId: "commit-crash-before",
          mutations: [{
            type: "object.put",
            objectId: "candidate",
            objectType: "file",
            contentRef: content.digest,
          }],
        }),
      ).toThrow("CRASH_BEFORE_COMMIT")
      expect(fixture.store.getWorld("w1")?.currentRevision).toBe(0n)
      expect(fixture.store.listObjects("w1", "main")).toEqual([])
      expect(fixture.store.getCommit("commit-crash-before")).toBeUndefined()
      expect(fixture.store.ledger.list("w1").map(event => event.eventType)).toEqual([
        "world.created",
      ])
      expect(fixture.store.cas.record(content.digest)?.refCount).toBe(0)
    } finally {
      fixture.cleanup()
    }
  })

  test("a fault after DB commit loses the response but not the committed World", () => {
    const fixture = createTestWorldStore({
      faultInjector: point => {
        if (point === "after_commit_before_response") throw new Error("CRASH_AFTER_COMMIT")
      },
    })
    const request: WorldCommitRequest = {
      worldId: "w1",
      branchId: "main",
      baseRevision: 0n,
      actor: "agent:a",
      commitId: "commit-crash-after",
      mutations: [{ type: "service.set", serviceId: "indexer", status: "ready" }],
    }
    try {
      fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      expect(() => fixture.store.compareAndCommit(request)).toThrow("CRASH_AFTER_COMMIT")
      fixture.store.close()

      const reopened = new WorldStore(fixture.root)
      try {
        expect(reopened.getWorld("w1")?.currentRevision).toBe(1n)
        expect(reopened.getCommit("commit-crash-after")?.newRevision).toBe(1n)
        expect(reopened.compareAndCommit(request).newRevision).toBe(1n)
        expect(reopened.ledger.eventsForCommit("commit-crash-after")).toHaveLength(2)
        expect(reopened.verifyIntegrity()).toEqual([])
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})
