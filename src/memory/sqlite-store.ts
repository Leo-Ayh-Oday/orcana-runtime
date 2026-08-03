/** SQLite FTS5 store — fast full-text search for knowledge and memory.
 *
 *  Prefers Bun's built-in `bun:sqlite` (zero external dependencies).
 *  Gracefully degrades in Node.js — FTS5 becomes unavailable and all methods
 *  return empty results, so callers fall back to token-overlap search.
 *
 *  JSONL remains the source-of-truth persistence layer; SQLite is the retrieval
 *  acceleration layer.
 */

import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

// bun:sqlite is a Bun built-in. In Node.js, FTS5 is unavailable and
// callers fall back to token-overlap search via KnowledgeBase.
let _DbCtor: (new (path: string) => any) | null = null
try {
  _DbCtor = (await import("bun:sqlite")).Database
} catch {
  // Node.js runtime — FTS5 unavailable, class becomes a graceful no-op
}

export interface FtsEntry {
  id: string
  topic: string
  rule: string
  source: string
  content: string
  timestamp: number
  confidence: number
}

export interface SearchHit {
  id: string
  topic: string
  rule: string
  source: string
  score: number
  rank: number
  confidence: number
  timestamp: number
}

export class SqliteStore {
  private db: any | null = null
  private storePath: string
  private _available: boolean

  constructor(storeName: string, storeDir?: string) {
    const dir = storeDir ?? join(homedir(), ".orcana", "fts")
    mkdirSync(dir, { recursive: true })
    this.storePath = join(dir, `${storeName}.sqlite`)
    this._available = false

    if (!_DbCtor) return

    try {
      const exists = existsSync(this.storePath)
      this.db = new _DbCtor(this.storePath)
      this.db.run("PRAGMA journal_mode=WAL")
      this.db.run("PRAGMA synchronous=NORMAL")

      if (!exists) {
        this.db.run(`
          CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
            id UNINDEXED,
            topic,
            rule,
            source UNINDEXED,
            content
          )
        `)
      }
      this._available = true
    } catch {
      this.db = null
    }
  }

  get available(): boolean {
    return this._available && this.db !== null
  }

  /** Rebuild FTS5 index from existing JSONL entries. */
  rebuildFromJsonl(entries: Array<{ id: string; topic: string; rule: string; source: string }>): void {
    if (!this.available) return
    const del = this.db!.prepare("DELETE FROM memory_fts WHERE id = ?")
    const ins = this.db!.prepare("INSERT INTO memory_fts (id, topic, rule, source, content) VALUES (?, ?, ?, ?, ?)")
    this.db!.run("BEGIN")
    try {
      for (const e of entries) {
        del.run(e.id)
        ins.run(e.id, e.topic, e.rule, e.source, `${e.topic} ${e.rule} ${e.source}`)
      }
      this.db!.run("COMMIT")
    } catch (e) {
      try { this.db!.run("ROLLBACK") } catch { /* ignore */ }
      throw e
    }
  }

  index(entry: FtsEntry): void {
    if (!this.available) return
    this.db!.run("DELETE FROM memory_fts WHERE id = ?", [entry.id])
    this.db!.run(
      "INSERT INTO memory_fts (id, topic, rule, source, content) VALUES (?, ?, ?, ?, ?)",
      [entry.id, entry.topic, entry.rule, entry.source, entry.content],
    )
  }

  indexBatch(entries: FtsEntry[]): void {
    if (!this.available) return
    const del = this.db!.prepare("DELETE FROM memory_fts WHERE id = ?")
    const ins = this.db!.prepare("INSERT INTO memory_fts (id, topic, rule, source, content) VALUES (?, ?, ?, ?, ?)")
    this.db!.run("BEGIN")
    try {
      for (const e of entries) {
        del.run(e.id)
        ins.run(e.id, e.topic, e.rule, e.source, e.content)
      }
      this.db!.run("COMMIT")
    } catch (e) {
      try { this.db!.run("ROLLBACK") } catch { /* ignore */ }
      throw e
    }
  }

  remove(id: string): void {
    if (!this.available) return
    this.db!.run("DELETE FROM memory_fts WHERE id = ?", [id])
  }

  search(query: string, limit = 10): SearchHit[] {
    if (!this.available || !query.trim()) return []

    const safe = query.replace(/['"*()^~@:]/g, " ").trim()
    if (!safe) return []

    const tokens = safe.split(/\s+/)
    const last = tokens.pop()
    const ftsQuery = [...tokens, last ? `${last}*` : ""].filter(Boolean).join(" ")

    try {
      const rows = this.db!.query(`
        SELECT id, topic, rule, source, content, rank, bm25(memory_fts) AS bm25_score
        FROM memory_fts
        WHERE memory_fts MATCH ?1
        ORDER BY bm25_score
        LIMIT ?2
      `).all(ftsQuery, limit) as Array<Record<string, unknown>>

      return rows.map(row => ({
        id: String(row.id ?? ""),
        topic: String(row.topic ?? ""),
        rule: String(row.rule ?? ""),
        source: String(row.source ?? ""),
        score: 1 / (1 + Math.abs(Number(row.bm25_score ?? 0))),
        rank: Number(row.rank ?? 0),
        confidence: 0.5,
        timestamp: Date.now(),
      }))
    } catch {
      return this.fallbackSearch(safe, limit)
    }
  }

  private fallbackSearch(query: string, limit: number): SearchHit[] {
    if (!this.available) return []
    const terms = query.split(/\s+/).filter(Boolean)
    if (terms.length === 0) return []

    const likes = terms.map(() => "content LIKE ?").join(" AND ")
    const params = terms.map(t => `%${t}%`)
    try {
      const rows = this.db!.query(`
        SELECT id, topic, rule, source
        FROM memory_fts
        WHERE ${likes}
        LIMIT ?
      `).all(...params, limit) as Array<Record<string, unknown>>

      return rows.map((row, i) => ({
        id: String(row.id ?? ""),
        topic: String(row.topic ?? ""),
        rule: String(row.rule ?? ""),
        source: String(row.source ?? ""),
        score: 0.5 - i * 0.05,
        rank: i,
        confidence: 0.5,
        timestamp: Date.now(),
      }))
    } catch {
      return []
    }
  }

  get count(): number {
    if (!this.available) return 0
    try {
      return (this.db!.query("SELECT COUNT(*) as c FROM memory_fts").get() as { c: number }).c
    } catch {
      return 0
    }
  }

  close(): void {
    if (this.db) {
      try { this.db.close() } catch { /* ignore */ }
    }
  }
}
