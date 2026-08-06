/** RC-10: Session idempotent persistence — D1 (no duplication), H5 (timestamp
 *  preservation), H7 (WAL/SHM cleanup on delete). */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionManager } from "../src/session"
import type { SessionMessage } from "../src/session"

function sessionDir(): string {
  return mkdtempSync(join(tmpdir(), "rc10-session-"))
}

function mk(role: SessionMessage["role"], content: string, timestamp: number): SessionMessage {
  return { role, content, timestamp, metadata: {} }
}

describe("RC-10 D1 SESSION_MESSAGE_DUPLICATION=0", () => {
  test("saving the same snapshot twice never duplicates rows", () => {
    const dir = sessionDir()
    const sm = new SessionManager(dir)
    try {
      const s = sm.create({ topic: "t" })
      s.messages = [mk("user", "u1", 1000), mk("assistant", "a1", 2000)]
      sm.save(s)
      sm.save(s)

      const loaded = sm.load(s.id)!
      expect(loaded.messages.length).toBe(2)
      expect(loaded.messages.map(m => m.content)).toEqual(["u1", "a1"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("incremental saves with growing history stay deduplicated", () => {
    const dir = sessionDir()
    const sm = new SessionManager(dir)
    try {
      // cli persistSession flow: load existing → set full history → save
      const s = sm.create({})
      s.messages = [mk("user", "u1", 1000)]
      sm.save(s)

      const s2 = sm.load(s.id)!
      s2.messages = [mk("user", "u1", 1000), mk("assistant", "a1", 2000)]
      sm.save(s2)

      const loaded = sm.load(s.id)!
      expect(loaded.messages.length).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("save is a snapshot: removing messages persists the removal", () => {
    const dir = sessionDir()
    const sm = new SessionManager(dir)
    try {
      const s = sm.create({})
      s.messages = [mk("user", "u1", 1000), mk("assistant", "a1", 2000)]
      sm.save(s)

      const s2 = sm.load(s.id)!
      s2.messages = [mk("user", "u1", 1000)] // history truncated (rewind)
      sm.save(s2)

      const loaded = sm.load(s.id)!
      expect(loaded.messages.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("RC-10 H5 MESSAGE_TIMESTAMP_PRESERVED", () => {
  test("persisted timestamps survive reload round-trips", () => {
    const dir = sessionDir()
    const sm = new SessionManager(dir)
    try {
      const s = sm.create({})
      s.messages = [mk("user", "u1", 111), mk("assistant", "a1", 222)]
      sm.save(s)

      const loaded = sm.load(s.id)!
      expect(loaded.messages[0]!.timestamp).toBe(111)
      expect(loaded.messages[1]!.timestamp).toBe(222)

      // second save keeps the original timestamps (not Date.now())
      sm.save(loaded)
      const again = sm.load(s.id)!
      expect(again.messages[0]!.timestamp).toBe(111)
      expect(again.messages[1]!.timestamp).toBe(222)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("RC-10 H7 SQLITE_DELETE_CLEANS_WAL_SHM", () => {
  test("deleteSession removes the db plus any WAL sidecar files", () => {
    const dir = sessionDir()
    const sm = new SessionManager(dir)
    try {
      const s = sm.create({})
      s.messages = [mk("user", "u1", 1000)]
      sm.save(s)
      const id = s.id
      expect(readdirSync(dir).some(f => f.startsWith(id))).toBe(true)

      sm.deleteSession(id)

      const remaining = readdirSync(dir)
      expect(remaining.filter(f => f.startsWith(id))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("replace rebuilds a healthy session (no stale sidecars from the old db)", () => {
    const dir = sessionDir()
    const sm = new SessionManager(dir)
    try {
      const s = sm.create({})
      s.messages = [mk("user", "u1", 1000)]
      sm.save(s)
      const id = s.id

      const s2 = sm.load(id)!
      s2.messages = [mk("user", "u1", 1000), mk("assistant", "a1", 2000)]
      sm.replace(s2)

      const loaded = sm.load(id)!
      expect(loaded.messages.length).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
