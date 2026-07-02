/** Session management — SQLite-backed with JSON fallback.
 *
 *  SessionManager wraps SessionStore (SQLite) while preserving the original
 *  JSON-based API. On first load, old JSON sessions are auto-migrated.
 *
 *  Public API (unchanged):
 *    create(metadata?) → Session
 *    save(session)      — persist to SQLite
 *    load(sessionId)    → Session | null (throws SessionCorruptedError)
 *    replace(session)   — atomic overwrite
 *    listSessions()     → [{ id, createdAt, messageCount }]
 */

import { readFileSync, existsSync, mkdirSync, renameSync, unlinkSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { isSessionSqliteAvailable, SessionStore, SessionCorruptedError, type Session, type SessionMessage } from "./sqlite-session"

export { SessionCorruptedError }
export type { Session, SessionMessage }
export type Message = SessionMessage  // backward compat alias
export { SessionStore } from "./sqlite-session"
export { searchAllSessions, listAllSessions } from "./session-search"
export { migrateAllJsonSessions, needsMigration } from "./migration"

export class SessionManager {
  private storeDir: string

  constructor(storeDir?: string) {
    this.storeDir = storeDir ?? join(homedir(), ".deepseek-code", "sessions")
    mkdirSync(this.storeDir, { recursive: true })
  }

  /** Create a new in-memory session. Returns a Session with a generated ID. */
  create(metadata: Record<string, unknown> = {}): Session {
    return {
      id: randomUUID().slice(0, 12),
      createdAt: Date.now(),
      messages: [],
      metadata,
    }
  }

  /** Persist a session to SQLite. */
  save(session: Session): void {
    const jsonPath = join(this.storeDir, `${session.id}.json`)
    const store = new SessionStore(session.id, this.storeDir)

    // Set metadata
    if (session.metadata?.topic) {
      store.setMeta("topic", String(session.metadata.topic))
    }
    if (session.createdAt) {
      store.setMeta("created_at", String(session.createdAt))
    }

    // Write all messages
    if (session.messages.length > 0) {
      store.addMessages(session.messages)
    }

    store.close()

    // Remove old JSON if SQLite is active (migration already handled). In Node's
    // SQLite-less fallback, SessionStore itself writes this JSON file.
    if (isSessionSqliteAvailable() && existsSync(jsonPath)) {
      try { renameSync(jsonPath, jsonPath + ".bak") } catch { /* best effort */ }
    }
  }

  /**
   * Load a session from SQLite.
   * Falls back to JSON if SQLite doesn't exist.
   * Returns null for "not found", throws SessionCorruptedError for corruption.
   */
  load(sessionId: string): Session | null {
    const dbPath = join(this.storeDir, `${sessionId}.db`)

    // Try SQLite first
    if (existsSync(dbPath)) {
      try {
        const store = new SessionStore(sessionId, this.storeDir)
        const messages = store.getMessages()
        const topic = store.getMeta("topic") ?? undefined
        const createdAt = Number(store.getMeta("created_at") ?? Date.now())
        store.close()

        return {
          id: sessionId,
          createdAt,
          messages,
          metadata: { topic, stagedFiles: [], messageCount: messages.length },
        }
      } catch (e) {
        throw new SessionCorruptedError(sessionId, e instanceof Error ? e.message : String(e))
      }
    }

    // Fallback: try old JSON
    const jsonPath = join(this.storeDir, `${sessionId}.json`)
    if (!existsSync(jsonPath)) return null

    try {
      const session = JSON.parse(readFileSync(jsonPath, "utf-8")) as Session
      // Auto-migrate on load
      this.save(session)
      return session
    } catch (e) {
      const tempPath = join(this.storeDir, `${sessionId}.json.tmp`)
      if (existsSync(tempPath)) {
        try {
          const recovered = JSON.parse(readFileSync(tempPath, "utf-8")) as Session
          renameSync(tempPath, jsonPath)
          this.save(recovered)
          return recovered
        } catch { /* temp also bad, fall through */ }
      }
      throw new SessionCorruptedError(sessionId, e instanceof Error ? e.message : String(e))
    }
  }

  /** Atomic replace: overwrite existing session data. */
  replace(session: Session): void {
    const dbPath = join(this.storeDir, `${session.id}.db`)

    // Delete old SQLite if it exists
    if (existsSync(dbPath)) {
      try { unlinkSync(dbPath) } catch { /* may not exist */ }
    }

    this.save(session)
  }

  /** List all sessions with summary info. */
  listSessions(): Array<{ id: string; createdAt: number; messageCount: number; topic?: string }> {
    const results: Array<{ id: string; createdAt: number; messageCount: number; topic?: string }> = []

    // Scan SQLite sessions
    let dbFiles: string[] = []
    try {
      dbFiles = readdirSync(this.storeDir).filter(f => f.endsWith(".db"))
    } catch { return [] }

    for (const file of dbFiles) {
      try {
        const sessionId = file.replace(/\.db$/, "")
        const store = new SessionStore(sessionId, this.storeDir)
        const topic = store.getMeta("topic") ?? undefined
        const createdAt = Number(store.getMeta("created_at") ?? 0)
        const messageCount = store.messageCount
        store.close()
        results.push({ id: sessionId, createdAt, messageCount, topic })
      } catch {
        // Skip corrupted
      }
    }

    // Also scan remaining JSON sessions (not yet migrated)
    let jsonFiles: string[] = []
    try {
      jsonFiles = readdirSync(this.storeDir).filter(f => f.endsWith(".json") && !f.endsWith(".tmp") && !f.endsWith(".bak"))
    } catch { /* no json */ }

    for (const file of jsonFiles) {
      const sessionId = file.replace(/\.json$/, "")
      if (results.some(r => r.id === sessionId)) continue
      try {
        const data = JSON.parse(readFileSync(join(this.storeDir, file), "utf-8")) as Session
        results.push({ id: data.id, createdAt: data.createdAt, messageCount: data.messages.length })
      } catch { /* skip corrupted */ }
    }

    return results.sort((a, b) => b.createdAt - a.createdAt)
  }
}
