import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import {
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
      expect(createWorldManifest(fixture.store.cas, manifest).digest).toBe(
        createWorldManifest(fixture.store.cas, { ...manifest }).digest,
      )
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
})
