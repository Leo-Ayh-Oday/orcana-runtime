/** SessionStore — SQLite-backed session persistence with FTS5.
 *
 *  Replaces the JSON-file SessionManager with a single SQLite database per
 *  session. Each session lives at ~/.deepseek-code/sessions/{id}.db.
 *
 *  Design invariants:
 *    - Same public API as SessionManager (create/save/load/replace/listSessions)
 *    - Messages + rounds + checkpoints stored in schema'd tables
 *    - FTS5 index on messages for cross-session search
 *    - WAL journal mode for read concurrency
 *    - SessionCorruptedError preserved for callers that catch it
 *    - Checkpoints are in-table rows, not separate JSON files
 */

import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"

// ── Data types (same as SessionManager) ──

export interface SessionMessage {
  role: "user" | "assistant" | "system"
  content: string
  timestamp: number
  metadata: Record<string, unknown>
}

export interface Session {
  id: string
  createdAt: number
  messages: SessionMessage[]
  metadata: Record<string, unknown>
}

export class SessionCorruptedError extends Error {
  constructor(sessionId: string, cause: string) {
    super(`Session ${sessionId} is corrupted: ${cause}`)
    this.name = "SessionCorruptedError"
  }
}

// ── Round record (new: structured tool call tracking) ──

export interface RoundRecord {
  id: number
  roundNum: number
  thinkingBlocks: Array<{ thinking: string; signature: string }> | null
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> | null
  toolResults: Array<{ toolUseId: string; content: string; success: boolean }> | null
  startedAt: number
  endedAt: number | null
}

// ── Checkpoint record (mirrors existing SessionCheckpoint) ──

export interface CheckpointRecord {
  id: number
  roundNum: number
  timestamp: number
  sessionId: string
  /** PR-4.4: Unique checkpoint identifier. */
  checkpointId?: string
  masterPlan: Record<string, unknown> | null
  taskSteps: Array<{ id: string; status: string; title: string }> | null
  changedFiles: string[]
  fileSHAs: Record<string, string> | null
  coldMemorySHA: string | null
  knowledgeCount: number
  lastVerification: { kind: string; passed: boolean; command: string } | null
  conversationTokens: number
  prevRound: number
  summary: string
}

// ── Search result ──

export interface SessionSearchHit {
  sessionId: string
  messageRowId: number
  role: string
  content: string
  timestamp: number
  snippet: string
}

// ── SQL schema ──

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  role      TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  content   TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  metadata  TEXT DEFAULT '{}'
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  role UNINDEXED,
  content,
  content=messages,
  content_rowid=id
);

CREATE TABLE IF NOT EXISTS rounds (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  round_num       INTEGER NOT NULL,
  thinking_blocks TEXT,
  tool_calls      TEXT,
  tool_results    TEXT,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  round_num           INTEGER NOT NULL,
  timestamp           INTEGER NOT NULL,
  session_id          TEXT NOT NULL,
  master_plan         TEXT,
  task_steps          TEXT,
  changed_files       TEXT DEFAULT '[]',
  file_shas           TEXT,
  cold_memory_sha     TEXT,
  knowledge_count     INTEGER DEFAULT 0,
  last_verification   TEXT,
  conversation_tokens INTEGER DEFAULT 0,
  prev_round          INTEGER DEFAULT 0,
  summary             TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_rounds_round_num ON rounds(round_num);
CREATE INDEX IF NOT EXISTS idx_checkpoints_round ON checkpoints(round_num);
`

export class SessionStore {
  private db: Database
  private storeDir: string
  private sessionId: string

  constructor(sessionId: string, storeDir?: string) {
    this.storeDir = storeDir ?? join(homedir(), ".deepseek-code", "sessions")
    this.sessionId = sessionId
    mkdirSync(this.storeDir, { recursive: true })

    const path = this.dbPath
    this.db = new Database(path)
    this.db.run("PRAGMA journal_mode=WAL")
    this.db.run("PRAGMA synchronous=NORMAL")
    this.db.run("PRAGMA foreign_keys=ON")

    this.db.run(SCHEMA_SQL)

    // Set session metadata
    this.setMeta("id", sessionId)
    if (!this.getMeta("created_at")) {
      this.setMeta("created_at", String(Date.now()))
    }
  }

  private get dbPath(): string {
    return join(this.storeDir, `${this.sessionId}.db`)
  }

  // ── Metadata ──

  setMeta(key: string, value: string): void {
    this.db.run(
      "INSERT INTO session_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value],
    )
  }

  getMeta(key: string): string | null {
    const row = this.db.query("SELECT value FROM session_meta WHERE key = ?").get(key) as { value: string } | null
    return row?.value ?? null
  }

  // ── Messages (primary API) ──

  /** Append a message. Returns the row ID. */
  addMessage(msg: SessionMessage): number {
    const result = this.db.run(
      "INSERT INTO messages (role, content, timestamp, metadata) VALUES (?, ?, ?, ?)",
      [msg.role, msg.content, msg.timestamp, JSON.stringify(msg.metadata)],
    )
    // Rebuild FTS index
    this.db.run("INSERT INTO messages_fts(content, rowid, role) VALUES (?, last_insert_rowid(), ?)", [msg.content, msg.role])
    return Number(result.lastInsertRowid ?? 0)
  }

  /** Append multiple messages in a transaction. */
  addMessages(messages: SessionMessage[]): void {
    const insert = this.db.prepare(
      "INSERT INTO messages (role, content, timestamp, metadata) VALUES (?, ?, ?, ?)",
    )
    const ftsInsert = this.db.prepare(
      "INSERT INTO messages_fts(content, rowid, role) VALUES (?, last_insert_rowid(), ?)",
    )
    this.db.run("BEGIN")
    try {
      for (const msg of messages) {
        insert.run(msg.role, msg.content, msg.timestamp, JSON.stringify(msg.metadata))
        ftsInsert.run(msg.content, msg.role)
      }
      this.db.run("COMMIT")
    } catch (e) {
      this.db.run("ROLLBACK")
      throw e
    }
  }

  /** Get all messages ordered by timestamp. */
  getMessages(limit?: number, offset?: number): SessionMessage[] {
    let sql = "SELECT role, content, timestamp, metadata FROM messages ORDER BY id ASC"
    const params: Array<number> = []
    if (limit) { sql += " LIMIT ?"; params.push(limit) }
    if (offset) { sql += " OFFSET ?"; params.push(offset) }

    return (this.db.query(sql).all(...params) as Array<{
      role: string
      content: string
      timestamp: number
      metadata: string
    }>).map(row => ({
      role: row.role as SessionMessage["role"],
      content: row.content,
      timestamp: row.timestamp,
      metadata: this.safeJsonParse(row.metadata, {}),
    }))
  }

  /** Count messages. */
  get messageCount(): number {
    const row = this.db.query("SELECT COUNT(*) as c FROM messages").get() as { c: number }
    return row.c
  }

  // ── Rounds ──

  /** Start a new round. Returns the round row ID. */
  startRound(roundNum: number): number {
    const result = this.db.run(
      "INSERT INTO rounds (round_num, started_at) VALUES (?, ?)",
      [roundNum, Date.now()],
    )
    return Number(result.lastInsertRowid ?? 0)
  }

  /** Complete a round with thinking blocks, tool calls, and tool results. */
  completeRound(roundId: number, data: {
    thinkingBlocks?: Array<{ thinking: string; signature: string }>
    toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>
    toolResults?: Array<{ toolUseId: string; content: string; success: boolean }>
  }): void {
    this.db.run(
      `UPDATE rounds SET
        thinking_blocks = ?,
        tool_calls = ?,
        tool_results = ?,
        ended_at = ?
       WHERE id = ?`,
      [
        data.thinkingBlocks ? JSON.stringify(data.thinkingBlocks) : null,
        data.toolCalls ? JSON.stringify(data.toolCalls) : null,
        data.toolResults ? JSON.stringify(data.toolResults) : null,
        Date.now(),
        roundId,
      ],
    )
  }

  /** Get rounds for this session. */
  getRounds(): RoundRecord[] {
    return (this.db.query(
      "SELECT id, round_num, thinking_blocks, tool_calls, tool_results, started_at, ended_at FROM rounds ORDER BY round_num ASC",
    ).all() as Array<Record<string, unknown>>).map(row => ({
      id: Number(row.id),
      roundNum: Number(row.round_num),
      thinkingBlocks: this.safeJsonParse(String(row.thinking_blocks ?? "null"), null),
      toolCalls: this.safeJsonParse(String(row.tool_calls ?? "null"), null),
      toolResults: this.safeJsonParse(String(row.tool_results ?? "null"), null),
      startedAt: Number(row.started_at),
      endedAt: row.ended_at ? Number(row.ended_at) : null,
    }))
  }

  // ── Checkpoints ──

  /** Save a checkpoint row. Keeps only the 3 most recent. */
  saveCheckpoint(cp: Omit<CheckpointRecord, "id">): number {
    const result = this.db.run(
      `INSERT INTO checkpoints
        (round_num, timestamp, session_id, master_plan, task_steps,
         changed_files, file_shas, cold_memory_sha, knowledge_count,
         last_verification, conversation_tokens, prev_round, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cp.roundNum, cp.timestamp, cp.sessionId,
        cp.masterPlan ? JSON.stringify(cp.masterPlan) : null,
        cp.taskSteps ? JSON.stringify(cp.taskSteps) : null,
        JSON.stringify(cp.changedFiles),
        cp.fileSHAs ? JSON.stringify(cp.fileSHAs) : null,
        cp.coldMemorySHA,
        cp.knowledgeCount,
        cp.lastVerification ? JSON.stringify(cp.lastVerification) : null,
        cp.conversationTokens,
        cp.prevRound,
        cp.summary,
      ],
    )

    // Keep only last 3
    const rowId = Number(result.lastInsertRowid ?? 0)
    this.db.run(
      "DELETE FROM checkpoints WHERE id NOT IN (SELECT id FROM checkpoints ORDER BY round_num DESC LIMIT 3)",
    )
    return rowId
  }

  /** Load the most recent checkpoint (or a specific round). */
  loadCheckpoint(round?: number): CheckpointRecord | null {
    let row: Record<string, unknown> | null
    if (round !== undefined) {
      row = this.db.query(
        "SELECT * FROM checkpoints WHERE round_num = ? ORDER BY id DESC LIMIT 1",
      ).get(round) as Record<string, unknown> | null
    } else {
      row = this.db.query(
        "SELECT * FROM checkpoints ORDER BY round_num DESC LIMIT 1",
      ).get() as Record<string, unknown> | null
    }
    if (!row) return null
    return this.hydrateCheckpoint(row)
  }

  /** Load the last checkpoint (alias). */
  lastCheckpoint(): CheckpointRecord | null {
    return this.loadCheckpoint()
  }

  /** List all checkpoints. */
  listCheckpoints(): Array<{ roundNum: number; timestamp: number; summary: string }> {
    return (this.db.query(
      "SELECT round_num, timestamp, summary FROM checkpoints ORDER BY round_num ASC",
    ).all() as Array<Record<string, unknown>>).map(row => ({
      roundNum: Number(row.round_num),
      timestamp: Number(row.timestamp),
      summary: String(row.summary ?? ""),
    }))
  }

  private hydrateCheckpoint(row: Record<string, unknown>): CheckpointRecord {
    return {
      id: Number(row.id),
      roundNum: Number(row.round_num),
      timestamp: Number(row.timestamp),
      sessionId: String(row.session_id ?? ""),
      masterPlan: this.safeJsonParse(String(row.master_plan ?? "null"), null),
      taskSteps: this.safeJsonParse(String(row.task_steps ?? "null"), null),
      changedFiles: this.safeJsonParse(String(row.changed_files ?? "[]"), []),
      fileSHAs: this.safeJsonParse(String(row.file_shas ?? "null"), null),
      coldMemorySHA: row.cold_memory_sha ? String(row.cold_memory_sha) : null,
      knowledgeCount: Number(row.knowledge_count ?? 0),
      lastVerification: this.safeJsonParse(String(row.last_verification ?? "null"), null),
      conversationTokens: Number(row.conversation_tokens ?? 0),
      prevRound: Number(row.prev_round ?? 0),
      summary: String(row.summary ?? ""),
    }
  }

  // ── FTS5 Search ──

  /** Search messages within this session. */
  searchMessages(query: string, limit = 10): Array<{ rowId: number; role: string; content: string; timestamp: number }> {
    const safe = query.replace(/['"*()^~@:]/g, " ").trim()
    if (!safe) return []

    const tokens = safe.split(/\s+/)
    const last = tokens.pop()
    const ftsQuery = [...tokens, last ? `${last}*` : ""].filter(Boolean).join(" ")

    try {
      const rows = this.db.query(`
        SELECT m.id, m.role, m.content, m.timestamp
        FROM messages_fts fts
        JOIN messages m ON m.id = fts.rowid
        WHERE messages_fts MATCH ?1
        ORDER BY rank
        LIMIT ?2
      `).all(ftsQuery, limit) as Array<Record<string, unknown>>

      return rows.map(row => ({
        rowId: Number(row.id),
        role: String(row.role),
        content: String(row.content),
        timestamp: Number(row.timestamp),
      }))
    } catch {
      return this.fallbackSearch(safe, limit)
    }
  }

  private fallbackSearch(query: string, limit: number): Array<{ rowId: number; role: string; content: string; timestamp: number }> {
    const terms = query.split(/\s+/).filter(Boolean)
    if (terms.length === 0) return []

    const likes = terms.map(() => "content LIKE ?").join(" AND ")
    const params = terms.map(t => `%${t}%`)
    return (this.db.query(`
      SELECT id, role, content, timestamp FROM messages WHERE ${likes} LIMIT ?
    `).all(...params, limit) as Array<Record<string, unknown>>).map(row => ({
      rowId: Number(row.id),
      role: String(row.role),
      content: String(row.content),
      timestamp: Number(row.timestamp),
    }))
  }

  // ── Lifecycle ──

  /** Close the database connection. */
  close(): void {
    this.db.close()
  }

  /** Delete this session's database file. */
  delete(): void {
    this.close()
    try {
      const { unlinkSync } = require("node:fs") as typeof import("node:fs")
      unlinkSync(this.dbPath)
    } catch { /* already gone */ }
  }

  // ── Utilities ──

  private safeJsonParse<T>(text: string, fallback: T): T {
    try {
      return JSON.parse(text) as T
    } catch {
      return fallback
    }
  }
}

// ── Cross-session helper ──

/** List all session IDs by scanning *.db files in the store directory. */
export function listSessionIds(storeDir?: string): string[] {
  const dir = storeDir ?? join(homedir(), ".deepseek-code", "sessions")
  mkdirSync(dir, { recursive: true })
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith(".db"))
      .map(f => f.replace(/\.db$/, ""))
  } catch {
    return []
  }
}
