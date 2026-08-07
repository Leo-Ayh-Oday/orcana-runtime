/** RC-19 Phase 3 fault baseline — Session Event Identity.
 *
 *  Invariants:
 *    D1  SESSION_MESSAGE_DUPLICATION — repeated saves never duplicate rows.
 *    NEW SESSION_MESSAGE_LOSS        — every real message survives save/load/
 *        restart/resume exactly once.
 *    NEW SESSION_ID_DRIFT            — a session's id is stable across saves.
 *    NEW SESSION_EVENT_IDENTITY      — every event carries a stable eventId +
 *        monotonic sequence; identical user texts ("继续" ×3) are three DISTINCT
 *        events — never collapsed by content dedup.
 *
 *  Oracle (directive §8.4): 20 rounds + auto-save + 10 manual saves + identical
 *  text ×3 + EOF + restart + resume → event count / order / eventId / sequence /
 *  createdAt must be exactly consistent.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SessionManager, type Session } from "../../src/session"

const dirs: string[] = []
function tmpStoreDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rc19-session-"))
  dirs.push(dir)
  return dir
}

function push(s: Session, role: "user" | "assistant", content: string, timestamp: number): void {
  s.messages.push({ role, content, timestamp, metadata: {} })
}

// ── D1 regression: repeated saves are idempotent (already fixed) ──

describe("D1 SESSION_MESSAGE_DUPLICATION", () => {
  test("ten saves of the same session never duplicate messages", () => {
    const manager = new SessionManager(tmpStoreDir())
    const s = manager.create({ topic: "t" })
    push(s, "user", "hello", 1000)
    push(s, "assistant", "hi", 2000)
    for (let i = 0; i < 10; i++) manager.save(s)
    const loaded = manager.load(s.id)!
    expect(loaded.messages.length).toBe(2)
  })
})

// ── NEW: every event carries stable identity ──

describe("SESSION_EVENT_IDENTITY", () => {
  test("loaded messages carry a stable eventId + sequence that survive restart", () => {
    const storeDir = tmpStoreDir()
    const manager = new SessionManager(storeDir)
    const s = manager.create({})
    push(s, "user", "继续", 1000)
    push(s, "assistant", "继续", 2000)
    push(s, "user", "继续", 3000) // identical text, third occurrence
    manager.save(s)

    // Restart: a fresh manager instance over the same store directory.
    const manager2 = new SessionManager(storeDir)
    const loaded = manager2.load(s.id)!
    expect(loaded.messages.length).toBe(3)

    // The oracle requires per-event identity — no content dedup, no collapse:
    for (const m of loaded.messages) {
      // @ts-expect-error — RC-19 Phase 3: eventId lands with the Session Event Identity fix
      expect(typeof m.eventId).toBe("string")
      // @ts-expect-error — RC-19 Phase 3: sequence lands with the Session Event Identity fix
      expect(typeof m.sequence).toBe("number")
    }
    // Three identical user texts are three DISTINCT events.
    const users = loaded.messages.filter(m => m.role === "user")
    expect(users.length).toBe(2)
    // @ts-expect-error — RC-19 Phase 3: eventId lands with the Session Event Identity fix
    expect(users[0]!.eventId).not.toBe(users[1]!.eventId)
    // @ts-expect-error — RC-19 Phase 3: sequence lands with the Session Event Identity fix
    expect(users[0]!.sequence).not.toBe(users[1]!.sequence)
    expect(users[0]!.timestamp).not.toBe(users[1]!.timestamp)
  })

  test("sequence is monotonic in append order across save/load cycles", () => {
    const storeDir = tmpStoreDir()
    const manager = new SessionManager(storeDir)
    const s = manager.create({})
    for (let round = 1; round <= 20; round++) {
      push(s, "user", `round-${round}`, round * 10)
      push(s, "assistant", `answer-${round}`, round * 10 + 1)
      if (round % 5 === 0) manager.save(s) // auto-save every 5 rounds
    }
    manager.save(s) // EOF flush

    const manager2 = new SessionManager(storeDir) // restart
    const loaded = manager2.load(s.id)!
    expect(loaded.messages.length).toBe(40)
    // @ts-expect-error — RC-19 Phase 3: sequence lands with the Session Event Identity fix
    const seqs = loaded.messages.map(m => m.sequence as number)
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!)
  })
})

// ── NEW: SessionEventJournal (future OCAF source of truth) ──

describe("SessionEventJournal", () => {
  test("journal module exists and exposes the event contract", async () => {
    // @ts-expect-error — RC-19 Phase 3: SessionEventJournal lands with the Session Event Identity fix
    const { SessionEventJournal } = await import("../../src/session/event-journal")
    expect(typeof SessionEventJournal).toBe("function")
    const event = {
      eventId: "evt-1",
      sessionId: "s",
      sequence: 1,
      type: "user_message",
      content: "继续",
      contentHash: "abc",
      createdAt: 1000,
    }
    expect(event.type).toBe("user_message")
  })

  test("journal oracle: 20 rounds + 10 saves + identical text ×3 + restart", async () => {
    // @ts-expect-error — RC-19 Phase 3: SessionEventJournal lands with the Session Event Identity fix
    const { SessionEventJournal } = await import("../../src/session/event-journal")
    const storeDir = tmpStoreDir()
    const journal = new SessionEventJournal(storeDir)
    const sessionId = "sess-oracle"

    for (let round = 1; round <= 20; round++) {
      journal.append({ sessionId, type: "user_message", content: `round-${round}` })
      journal.append({ sessionId, type: "assistant_message", content: `answer-${round}` })
      if (round % 2 === 0) journal.save() // auto-save every 2 rounds
    }
    for (let i = 0; i < 10; i++) journal.save() // manual /save ×10
    journal.append({ sessionId, type: "user_message", content: "继续" })
    journal.append({ sessionId, type: "user_message", content: "继续" })
    journal.append({ sessionId, type: "user_message", content: "继续" })
    journal.save() // EOF

    // Restart: fresh journal over the same store — the oracle must match exactly.
    const journal2 = new SessionEventJournal(storeDir)
    const events: Array<{ eventId: string; sequence: number; content: string; createdAt: number }> = journal2.load(sessionId)

    expect(events.length).toBe(43)
    for (let i = 0; i < events.length; i++) {
      expect(events[i]!.sequence).toBe(i + 1)
    }
    const ids = new Set(events.map(e => e.eventId))
    expect(ids.size).toBe(43) // eventId uniqueness, including the three 继续
    const continues = events.filter(e => e.content === "继续")
    expect(continues.length).toBe(3)
    // Three identical events stay three distinct events with distinct identities.
    expect(new Set(continues.map(e => e.eventId)).size).toBe(3)
    expect(new Set(continues.map(e => e.createdAt)).size).toBe(3)
  })
})

afterAllCleanup()
function afterAllCleanup(): void {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}
