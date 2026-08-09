import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { writeFileSync } from "node:fs"
import {
  canonicalJson,
  createDirectoryManifest,
  createFileManifest,
  createWorldManifest,
  type WorldManifest,
} from "../../../src/kernel/world"
import { createTestWorldStore } from "./helpers"

describe("AK-1 World CAS", () => {
  test("put/get is content addressed and idempotent", () => {
    const fixture = createTestWorldStore()
    try {
      const first = fixture.store.cas.put(Buffer.from("same"), "text/plain")
      const second = fixture.store.cas.put(Buffer.from("same"), "text/plain")
      expect(second.digest).toBe(first.digest)
      expect(fixture.store.cas.list()).toHaveLength(1)
      expect(fixture.store.cas.get(first.digest).toString()).toBe("same")
    } finally {
      fixture.cleanup()
    }
  })

  test("link/unlink and cascading GC remove unreachable manifests and chunks", () => {
    const fixture = createTestWorldStore()
    try {
      const file = createFileManifest(fixture.store.cas, Buffer.from("abcdefghij"), "text/plain", 4)
      expect(file.manifest.chunks.map(chunk => chunk.size)).toEqual([4, 4, 2])
      fixture.store.cas.link("world_object", "w:main:file", file.digest)
      expect(fixture.store.cas.record(file.digest)?.refCount).toBe(1)
      fixture.store.cas.unlink("world_object", "w:main:file", file.digest)
      const removed = fixture.store.cas.gc()
      expect(removed).toContain(file.digest)
      for (const chunk of file.manifest.chunks) expect(removed).toContain(chunk.digest)
      expect(fixture.store.cas.list()).toEqual([])
    } finally {
      fixture.cleanup()
    }
  })

  test("Directory and World manifests are deterministic across input order", () => {
    const fixture = createTestWorldStore()
    try {
      const a = fixture.store.cas.put(Buffer.from("a"), "text/plain")
      const b = fixture.store.cas.put(Buffer.from("b"), "text/plain")
      const left = createDirectoryManifest(fixture.store.cas, [
        { name: "b", kind: "file", digest: b.digest },
        { name: "a", kind: "file", digest: a.digest },
      ])
      const right = createDirectoryManifest(fixture.store.cas, [
        { name: "a", kind: "file", digest: a.digest },
        { name: "b", kind: "file", digest: b.digest },
      ])
      expect(left.digest).toBe(right.digest)

      const unicode = createDirectoryManifest(fixture.store.cas, [
        { name: "ä", kind: "file", digest: a.digest },
        { name: "Z", kind: "file", digest: b.digest },
        { name: "😀", kind: "file", digest: a.digest },
      ])
      expect(unicode.manifest.entries.map(entry => entry.name)).toEqual(["Z", "ä", "😀"])

      const manifest: WorldManifest = {
        schemaVersion: 1,
        type: "world",
        worldId: "w",
        branchId: "main",
        revision: "0",
        worldStatus: "active",
        rootObjectId: "root",
        filesystemDigest: left.digest,
        memoryDigest: left.digest,
        taskStateDigest: left.digest,
        capabilityStateDigest: left.digest,
        serviceStateDigest: left.digest,
        artifactStateDigest: left.digest,
      }
      const ordinaryWorld = fixture.store.cas.put(
        Buffer.from(canonicalJson(manifest)),
        "application/json",
      )
      expect(createWorldManifest(fixture.store.cas, manifest).digest).toBe(
        createWorldManifest(fixture.store.cas, { ...manifest }).digest,
      )
      expect(fixture.store.cas.record(ordinaryWorld.digest)).toEqual(expect.objectContaining({
        isManifest: true,
        mediaTypes: ["application/json", "application/vnd.orcana.manifest+json"],
      }))
    } finally {
      fixture.cleanup()
    }
  })

  test("manifest attestation promotes identical ordinary bytes without MIME poisoning", () => {
    const fixture = createTestWorldStore()
    try {
      fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      const ordinaryChunk = fixture.store.cas.put(Buffer.from("x"), "text/plain")
      const file = createFileManifest(fixture.store.cas, Buffer.from("x"), "text/plain")
      expect(file.manifest.chunks[0]?.digest).toBe(ordinaryChunk.digest)
      expect(fixture.store.cas.record(ordinaryChunk.digest)?.mediaTypes).toEqual([
        "application/octet-stream",
        "text/plain",
      ])
      const content = Buffer.from(canonicalJson({
        schemaVersion: 1,
        type: "directory",
        entries: [],
      }))
      const ordinary = fixture.store.cas.put(content, "application/json")
      expect(ordinary.isManifest).toBe(false)

      const manifest = createDirectoryManifest(fixture.store.cas, [])
      expect(manifest.digest).toBe(ordinary.digest)
      expect(fixture.store.cas.record(manifest.digest)).toEqual(expect.objectContaining({
        mediaType: "application/json",
        isManifest: true,
      }))
      fixture.store.compareAndCommit({
        worldId: "w1",
        branchId: "main",
        baseRevision: 0n,
        actor: "agent:test",
        mutations: [
          {
            type: "object.put",
            objectId: "manifest",
            objectType: "directory",
            contentRef: manifest.digest,
          },
          {
            type: "object.put",
            objectId: "file-manifest",
            objectType: "file",
            contentRef: file.digest,
          },
        ],
      })
      expect(fixture.store.verifyIntegrity()).toEqual([])

      const db = new Database(fixture.store.databasePath)
      try {
        expect(() => db.run(
          "UPDATE cas_objects SET is_manifest = 0 WHERE digest = ?",
          [manifest.digest],
        )).toThrow(/CAS_MANIFEST_ATTESTATION_IMMUTABLE/)
      } finally {
        db.close()
      }
    } finally {
      fixture.cleanup()
    }
  })

  test("manifest validation rejects missing objects and unsafe names", () => {
    const fixture = createTestWorldStore()
    try {
      const missing = `sha256:${"a".repeat(64)}` as const
      expect(() =>
        createDirectoryManifest(fixture.store.cas, [
          { name: "missing", kind: "file", digest: missing },
        ]),
      ).toThrow(/missing CAS object/)
      const present = fixture.store.cas.put(Buffer.from("x"))
      expect(() =>
        createDirectoryManifest(fixture.store.cas, [
          { name: "../escape", kind: "file", digest: present.digest },
        ]),
      ).toThrow(/invalid directory manifest entry/)
    } finally {
      fixture.cleanup()
    }
  })

  test("manifest attestation rejects malformed and noncanonical bytes without promotion", () => {
    const fixture = createTestWorldStore()
    try {
      const malformed = Buffer.from(canonicalJson({
        schemaVersion: 1,
        type: "file",
        chunks: [],
      }))
      const ordinary = fixture.store.cas.put(malformed, "application/json")
      expect(() => fixture.store.cas.putManifest(malformed, [])).toThrow(/invalid keys/)
      expect(fixture.store.cas.record(ordinary.digest)).toEqual(expect.objectContaining({
        isManifest: false,
        mediaTypes: ["application/json"],
      }))
      expect(fixture.store.cas.linksForOwner("cas_object", ordinary.digest)).toEqual([])

      const countBefore = fixture.store.cas.list().length
      const noncanonical = Buffer.from(
        '{"type":"directory","schemaVersion":1,"entries":[]}',
      )
      expect(() => fixture.store.cas.putManifest(noncanonical, [])).toThrow(
        /not canonically encoded/,
      )
      expect(fixture.store.cas.list()).toHaveLength(countBefore)
    } finally {
      fixture.cleanup()
    }
  })

  test("manifest attestation derives and enforces the exact reference set", () => {
    const fixture = createTestWorldStore()
    try {
      const missing = `sha256:${"a".repeat(64)}` as const
      const missingManifest = Buffer.from(canonicalJson({
        schemaVersion: 1,
        type: "directory",
        entries: [{ name: "missing", kind: "file", digest: missing }],
      }))
      const countBeforeMissing = fixture.store.cas.list().length
      expect(() => fixture.store.cas.putManifest(missingManifest, [missing])).toThrow(
        /references invalid CAS object/,
      )
      expect(fixture.store.cas.list()).toHaveLength(countBeforeMissing)

      const extra = fixture.store.cas.put(Buffer.from("extra"), "text/plain")
      const emptyManifest = Buffer.from(canonicalJson({
        schemaVersion: 1,
        type: "directory",
        entries: [],
      }))
      expect(() => fixture.store.cas.putManifest(emptyManifest, [extra.digest])).toThrow(
        /supplied references do not match/,
      )

      const child = fixture.store.cas.put(Buffer.from("child"), "text/plain")
      const childManifest = Buffer.from(canonicalJson({
        schemaVersion: 1,
        type: "directory",
        entries: [{ name: "child", kind: "file", digest: child.digest }],
      }))
      expect(() => fixture.store.cas.putManifest(childManifest, [])).toThrow(
        /supplied references do not match/,
      )
      expect(fixture.store.cas.record(extra.digest)?.refCount).toBe(0)
      expect(fixture.store.cas.record(child.digest)?.refCount).toBe(0)
    } finally {
      fixture.cleanup()
    }
  })

  test("a registered but corrupted object cannot become reachable", () => {
    const fixture = createTestWorldStore()
    try {
      const object = fixture.store.cas.put(Buffer.from("trusted"), "text/plain")
      writeFileSync(fixture.store.cas.resolveObjectPath(object.digest), "corrupt")
      expect(() => fixture.store.cas.link("test", "owner", object.digest)).toThrow(
        /cannot link invalid CAS object/,
      )
      expect(fixture.store.cas.record(object.digest)?.refCount).toBe(0)
    } finally {
      fixture.cleanup()
    }
  })

  test("mark-and-sweep collects unreachable CAS cycles and ghost roots", () => {
    const fixture = createTestWorldStore()
    try {
      const left = fixture.store.cas.put(Buffer.from("left"), "text/plain")
      const right = fixture.store.cas.put(Buffer.from("right"), "text/plain")
      const self = fixture.store.cas.put(Buffer.from("self"), "text/plain")
      fixture.store.cas.link("cas_object", left.digest, right.digest)
      fixture.store.cas.link("cas_object", right.digest, left.digest)
      fixture.store.cas.link("cas_object", self.digest, self.digest)
      fixture.store.cas.link("not_authoritative", "ghost", left.digest)
      expect(fixture.store.cas.record(left.digest)?.refCount).toBe(2)
      expect(fixture.store.cas.record(right.digest)?.refCount).toBe(1)
      const removed = fixture.store.cas.gc()
      expect(removed).toEqual(expect.arrayContaining([left.digest, right.digest, self.digest]))
      expect(fixture.store.cas.list()).toEqual([])
    } finally {
      fixture.cleanup()
    }
  })
})
