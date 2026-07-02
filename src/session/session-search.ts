/** Cross-session search — FTS5 full-text search across all sessions.
 *
 *  Opens each session's SQLite database, searches messages_fts,
 *  and returns ranked results. Sessions are opened read-only and
 *  closed immediately after search.
 *
 *  Powers the /search CLI command and the "上次怎么修的" use case.
 */

import { join } from "node:path"
import { homedir } from "node:os"
import { isSessionSqliteAvailable, listSessionIds, type SessionSearchHit } from "./sqlite-session"

type SqliteDatabase = {
  run: (sql: string) => unknown
  query: (sql: string) => {
    get: (...args: unknown[]) => unknown
    all: (...args: unknown[]) => unknown[]
  }
  close: () => void
}

let DatabaseCtor: (new (path: string, options?: { readonly?: boolean }) => SqliteDatabase) | null = null
try {
  DatabaseCtor = (await import("bun:sqlite")).Database as new (path: string, options?: { readonly?: boolean }) => SqliteDatabase
} catch {
  // Node.js runtime: cross-session FTS is unavailable; callers get empty results.
}

export interface CrossSessionHit {
  sessionId: string
  score: number
  role: string
  contentSnippet: string   // first 200 chars of matched content
  timestamp: number
  /** The session metadata (topic, if available) */
  sessionTopic?: string
  messageCount?: number
}

/** Search ALL sessions for a query. Returns results ranked by FTS5 relevance. */
export function searchAllSessions(
  query: string,
  options: {
    storeDir?: string
    limit?: number
    maxSessions?: number
  } = {},
): CrossSessionHit[] {
  if (!isSessionSqliteAvailable() || !DatabaseCtor) return []

  const dir = options.storeDir ?? join(homedir(), ".deepseek-code", "sessions")
  const limit = options.limit ?? 10
  const maxSessions = options.maxSessions ?? 50

  const sessionIds = listSessionIds(dir).slice(0, maxSessions)
  if (sessionIds.length === 0) return []

  const safe = query.replace(/['"*()^~@:]/g, " ").trim()
  if (!safe) return []

  const tokens = safe.split(/\s+/)
  const last = tokens.pop()
  const ftsQuery = [...tokens, last ? `${last}*` : ""].filter(Boolean).join(" ")

  const allHits: CrossSessionHit[] = []

  for (const sid of sessionIds) {
    const path = join(dir, `${sid}.db`)
    let db: SqliteDatabase | null = null
    try {
      db = new DatabaseCtor(path, { readonly: true })
      db.run("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL")

      // Try FTS5 first
      let rows: Array<Record<string, unknown>>
      try {
        rows = db.query(`
          SELECT m.role, m.content, m.timestamp, rank
          FROM messages_fts fts
          JOIN messages m ON m.id = fts.rowid
          WHERE messages_fts MATCH ?1
          ORDER BY rank
          LIMIT ?2
        `).all(ftsQuery, 5) as Array<Record<string, unknown>>
      } catch {
        // FTS5 parse failed → LIKE fallback
        const likes = tokens.map(() => "content LIKE ?").join(" AND ")
        const params = tokens.map(t => `%${t}%`)
        rows = db.query(`
          SELECT role, content, timestamp, 0 as rank
          FROM messages
          WHERE ${likes}
          LIMIT ?
        `).all(...params, 5) as Array<Record<string, unknown>>
      }

      // Get session topic for context
      let sessionTopic: string | undefined
      try {
        const meta = db.query("SELECT value FROM session_meta WHERE key = 'topic'").get() as { value: string } | null
        sessionTopic = meta?.value?.slice(0, 80) ?? undefined
      } catch { /* no topic */ }

      let messageCount: number | undefined
      try {
        const count = db.query("SELECT COUNT(*) as c FROM messages").get() as { c: number } | null
        messageCount = count?.c
      } catch { /* no count */ }

      for (const row of rows) {
        const content = String(row.content ?? "")
        allHits.push({
          sessionId: sid,
          score: 1 / (1 + Math.abs(Number(row.rank ?? 0))),
          role: String(row.role ?? ""),
          contentSnippet: content.slice(0, 200),
          timestamp: Number(row.timestamp ?? 0),
          sessionTopic,
          messageCount,
        })
      }
    } catch {
      // Skip corrupted/inaccessible sessions
    } finally {
      try { db?.close() } catch { /* best effort */ }
    }
  }

  // Sort by score descending, take top N
  return allHits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/** List all sessions with metadata (for /sessions CLI). */
export function listAllSessions(
  options: { storeDir?: string; limit?: number } = {},
): Array<{ id: string; createdAt: number; messageCount: number; topic?: string }> {
  if (!isSessionSqliteAvailable() || !DatabaseCtor) return []

  const dir = options.storeDir ?? join(homedir(), ".deepseek-code", "sessions")
  const limit = options.limit ?? 20

  return listSessionIds(dir)
    .slice(0, limit)
    .map(sid => {
      const path = join(dir, `${sid}.db`)
      let db: SqliteDatabase | null = null
      try {
        db = new DatabaseCtor(path, { readonly: true })
        const meta = db.query("SELECT value FROM session_meta WHERE key = 'created_at' OR key = 'topic'").all() as Array<{ key: string; value: string }>
        const count = (db.query("SELECT COUNT(*) as c FROM messages").get() as { c: number })?.c ?? 0

        let createdAt = 0
        let topic: string | undefined
        for (const m of meta) {
          if (m.key === "created_at") createdAt = Number(m.value)
          if (m.key === "topic") topic = m.value.slice(0, 80)
        }

        return { id: sid, createdAt, messageCount: count, topic }
      } catch {
        return { id: sid, createdAt: 0, messageCount: 0 }
      } finally {
        try { db?.close() } catch { /* */ }
      }
    })
    .filter(s => s.createdAt > 0)
    .sort((a, b) => b.createdAt - a.createdAt)
}
