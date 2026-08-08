/** Session migration — converts old JSON-format sessions to SQLite.
 *
 *  Triggered automatically on startup when an old {id}.json file is detected.
 *  Post-migration, the JSON file is renamed to {id}.json.bak as a safety net.
 *
 *  Migration is idempotent: if the .db already exists, it's skipped.
 */

import { existsSync, readFileSync, renameSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { SessionStore, type Session, SessionCorruptedError, isSessionSqliteAvailable } from "./sqlite-session"

export interface MigrationResult {
  migrated: number
  skipped: number
  errors: string[]
}

/**
 * Scan the sessions directory and migrate all old JSON sessions to SQLite.
 * Returns a summary of what happened.
 */
export function migrateAllJsonSessions(storeDir?: string): MigrationResult {
  const dir = storeDir ?? join(homedir(), ".orcana", "sessions")
  const result: MigrationResult = { migrated: 0, skipped: 0, errors: [] }

  let jsonFiles: string[] = []
  try {
    jsonFiles = readdirSync(dir).filter(f => f.endsWith(".json") && !f.endsWith(".tmp") && !f.endsWith(".bak"))
  } catch {
    return result
  }

  for (const file of jsonFiles) {
    try {
      const sessionId = file.replace(/\.json$/, "")
      const migrated = migrateSession(sessionId, dir)
      if (migrated) result.migrated++
      else result.skipped++
    } catch (e) {
      result.errors.push(`${file}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return result
}

/**
 * Migrate a single session from JSON to SQLite.
 * Returns true if migration happened, false if skipped (already migrated).
 */
export function migrateSession(sessionId: string, storeDir?: string): boolean {
  const dir = storeDir ?? join(homedir(), ".orcana", "sessions")
  const jsonPath = join(dir, `${sessionId}.json`)
  const dbPath = join(dir, `${sessionId}.db`)

  // SQLite 不可用（纯 node 运行时，npm 发布主路径）时禁止迁移：SessionStore
  // 会退化为内存 fallback，不产生 .db——此时 rename json→bak 等于丢数据
  // （load 只认 .json/.db）。2026-08-08 续考事故：node 下迁移把会话 rename
  // 成 .bak 后 load 报"不存在"，且每次启动重复迁移内容翻倍。
  if (!isSessionSqliteAvailable()) return false

  // Already migrated
  if (existsSync(dbPath)) return false
  // No JSON source
  if (!existsSync(jsonPath)) return false

  // Load old JSON
  let session: Session
  try {
    const raw = readFileSync(jsonPath, "utf-8")
    session = JSON.parse(raw) as Session
  } catch {
    throw new SessionCorruptedError(sessionId, "JSON parse failed or missing")
  }

  // Create SQLite store and populate
  const store = new SessionStore(sessionId, dir)
  store.setMeta("topic", String(session.metadata?.topic ?? ""))

  if (session.messages?.length > 0) {
    store.addMessages(session.messages)
  }

  // Migrate checkpoints if they exist
  migrateCheckpoints(sessionId, store)

  store.close()

  // Rename old JSON to .bak
  renameSync(jsonPath, join(dir, `${sessionId}.json.bak`))
  return true
}

/** Check if any old JSON sessions need migration. */
export function needsMigration(storeDir?: string): boolean {
  // 与 migrateSession 同守卫：sqlite 不可用（纯 node 运行时）时迁移无意义
  // 且 rename 会丢数据——此时永远不需要"迁移"。
  if (!isSessionSqliteAvailable()) return false
  const dir = storeDir ?? join(homedir(), ".orcana", "sessions")
  try {
    return readdirSync(dir).some(f => f.endsWith(".json") && !f.endsWith(".tmp") && !f.endsWith(".bak"))
  } catch {
    return false
  }
}

/** Try to migrate checkpoints from old JSON format into the SQLite store. */
function migrateCheckpoints(sessionId: string, store: SessionStore): void {
  const ckptDir = join(homedir(), ".orcana", "checkpoints", sessionId)
  if (!existsSync(ckptDir)) return

  let files: string[] = []
  try {
    files = readdirSync(ckptDir).filter(f => f.endsWith(".json") && !f.endsWith(".tmp")).sort()
  } catch {
    return
  }

  for (const file of files) {
    try {
      const raw = readFileSync(join(ckptDir, file), "utf-8")
      const cp = JSON.parse(raw) as Record<string, unknown>
      store.saveCheckpoint({
        roundNum: Number(cp.round ?? 0),
        timestamp: Number(cp.timestamp ?? 0),
        sessionId,
        masterPlan: (cp.masterPlan as Record<string, unknown>) ?? null,
        taskSteps: (cp.taskSteps as Array<{ id: string; status: string; title: string }>) ?? null,
        changedFiles: (cp.changedFiles as string[]) ?? [],
        fileSHAs: (cp.fileSHAs as Record<string, string>) ?? null,
        coldMemorySHA: (cp.coldMemorySHA as string) ?? null,
        knowledgeCount: Number(cp.knowledgeCount ?? 0),
        lastVerification: (cp.lastVerification as { kind: string; passed: boolean; command: string }) ?? null,
        conversationTokens: Number(cp.conversationTokens ?? 0),
        prevRound: Number(cp.prevRound ?? 0),
        summary: String(cp.summary ?? ""),
      })
    } catch {
      // Skip corrupted checkpoints
    }
  }
}
