import { Database, type SQLQueryBindings } from "bun:sqlite"

export type WorldDatabase = Database

type RunResult = { changes: number; lastInsertRowid: number | bigint }
type RunFn = (sql: string, ...bindings: SQLQueryBindings[]) => RunResult
type QueryFn = (sql: string) => {
  get: (...bindings: SQLQueryBindings[]) => unknown
  all: (...bindings: SQLQueryBindings[]) => unknown[]
}

export function dbRun(
  db: Database,
  sql: string,
  ...bindings: SQLQueryBindings[]
): RunResult {
  return (db.run as unknown as RunFn)(sql, ...bindings)
}

export function dbGet<T>(
  db: Database,
  sql: string,
  ...bindings: SQLQueryBindings[]
): T | undefined {
  const row = (db.query as unknown as QueryFn)(sql).get(...bindings)
  return row === null || row === undefined ? undefined : (row as T)
}

export function dbAll<T>(
  db: Database,
  sql: string,
  ...bindings: SQLQueryBindings[]
): T[] {
  return (db.query as unknown as QueryFn)(sql).all(...bindings) as T[]
}

export function withDatabaseTransaction<T>(db: Database, fn: () => T): T {
  if (db.inTransaction) return fn()
  return db.transaction(fn)()
}

export function withImmediateTransaction<T>(db: Database, fn: () => T): T {
  if (db.inTransaction) return fn()
  db.exec("BEGIN IMMEDIATE")
  let committed = false
  try {
    const result = fn()
    db.exec("COMMIT")
    committed = true
    return result
  } finally {
    if (!committed && db.inTransaction) db.exec("ROLLBACK")
  }
}
