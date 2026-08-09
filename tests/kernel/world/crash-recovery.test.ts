import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import {
  assertWorldRecovered,
  recoverWorldStore,
  sha256Digest,
  WorldStore,
} from "../../../src/kernel/world"
import { removeTestWorldRoot } from "./helpers"

const CHILD = join(import.meta.dir, "crash-child.ts")

function crash(scenario: string, root: string): void {
  const result = spawnSync(process.execPath, [CHILD, scenario, root], {
    cwd: join(import.meta.dir, "../../.."),
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test" },
  })
  expect(result.status).toBe(86)
}

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orcana-world-crash-"))
  const store = new WorldStore(root)
  store.createWorld({ worldId: "w1", owner: "user:owner" })
  store.close()
  return root
}

describe("AK-1 process crash recovery", () => {
  test("a hard exit before DB commit rolls back WorldDB and ledger", () => {
    for (const scenario of ["world-precommit", "world-ledger"]) {
      const root = createRoot()
      try {
        crash(scenario, root)
        const reopened = new WorldStore(root)
        try {
          expect(reopened.getWorld("w1")?.currentRevision).toBe(0n)
          expect(reopened.listObjects("w1", "main")).toEqual([])
          expect(reopened.getCommit(`commit-${scenario}`)).toBeUndefined()
          const report = recoverWorldStore(reopened)
          assertWorldRecovered(report)
          expect(reopened.verifyIntegrity()).toEqual([])
        } finally {
          reopened.close()
        }
      } finally {
        removeTestWorldRoot(root)
      }
    }
  })

  test("a hard exit after DB commit preserves the committed World", () => {
    const root = createRoot()
    try {
      crash("world-postcommit", root)
      const reopened = new WorldStore(root)
      try {
        expect(reopened.getWorld("w1")?.currentRevision).toBe(1n)
        expect(reopened.getCommit("commit-post-crash")?.newRevision).toBe(1n)
        expect(reopened.listServices("w1", "main")).toEqual([
          expect.objectContaining({ serviceId: "indexer", status: "ready" }),
        ])
        expect(reopened.verifyIntegrity()).toEqual([])
      } finally {
        reopened.close()
      }
    } finally {
      removeTestWorldRoot(root)
    }
  })

  test("CAS temp, file-only, and metadata-only crash residues recover", () => {
    for (const scenario of ["cas-temp", "cas-rename", "cas-metadata"]) {
      const root = createRoot()
      try {
        crash(scenario, root)
        const reopened = new WorldStore(root)
        try {
          const report = recoverWorldStore(reopened)
          assertWorldRecovered(report)
          expect(reopened.verifyIntegrity()).toEqual([])
          expect(reopened.cas.record(sha256Digest("cas crash"))).toBeUndefined()
          expect(existsSync(reopened.cas.resolveObjectPath(sha256Digest("cas crash")))).toBe(false)
          if (scenario === "cas-temp") expect(report.removedTemporaryFiles.length).toBeGreaterThan(0)
          else expect(report.removedUnreachableObjects).toContain(sha256Digest("cas crash"))
        } finally {
          reopened.close()
        }
      } finally {
        removeTestWorldRoot(root)
      }
    }
  })

  test("a hard exit after GC file fsync converges missing bytes and rolled-back metadata", () => {
    const root = createRoot()
    const digest = sha256Digest("gc crash")
    try {
      crash("gc-file", root)
      const reopened = new WorldStore(root)
      try {
        expect(reopened.cas.record(digest)).toBeDefined()
        expect(existsSync(reopened.cas.resolveObjectPath(digest))).toBe(false)
        const report = recoverWorldStore(reopened)
        assertWorldRecovered(report)
        expect(report.removedUnreachableObjects).toContain(digest)
        expect(reopened.cas.record(digest)).toBeUndefined()
        expect(existsSync(reopened.cas.resolveObjectPath(digest))).toBe(false)
        expect(reopened.verifyIntegrity()).toEqual([])
      } finally {
        reopened.close()
      }
    } finally {
      removeTestWorldRoot(root)
    }
  })

  test("snapshot manifest and row-insert crash windows leave no committed snapshot", () => {
    for (const scenario of ["snapshot-manifest", "snapshot-insert"]) {
      const root = createRoot()
      try {
        crash(scenario, root)
        const reopened = new WorldStore(root)
        try {
          expect(reopened.snapshots.list("w1", "main")).toEqual([])
          expect(reopened.ledger.list("w1").filter(event =>
            event.eventType === "world.snapshot.created",
          )).toEqual([])
          const report = recoverWorldStore(reopened)
          assertWorldRecovered(report)
          expect(reopened.verifyIntegrity()).toEqual([])
        } finally {
          reopened.close()
        }
      } finally {
        removeTestWorldRoot(root)
      }
    }
  })
})
