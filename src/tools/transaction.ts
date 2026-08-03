import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { randomBytes } from "node:crypto"

export interface TransactionSnapshot {
  path: string
  existedBefore: boolean
  content: string | null
}

export interface FileTransaction {
  id: string
  createdAt: number
  cwd: string
  tool: string
  snapshots: TransactionSnapshot[]
}

function transactionDir(cwd = process.cwd()): string {
  return resolve(cwd, ".orcana", "transactions")
}

function transactionPath(id: string, cwd = process.cwd()): string {
  return resolve(transactionDir(cwd), `${id}.json`)
}

export function createTransaction(input: {
  tool: string
  paths: string[]
  preloadedSnapshots?: Array<{ path: string; content: string | null }>
  cwd?: string
}): FileTransaction {
  const cwd = resolve(input.cwd ?? process.cwd())
  const id = `txn_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`
  const uniquePaths = [...new Set(input.paths.map(path => resolve(cwd, path)))]
  const preloaded = new Map(
    (input.preloadedSnapshots ?? []).map(snapshot => [resolve(cwd, snapshot.path), snapshot.content]),
  )
  const snapshots = uniquePaths.map(path => {
    if (preloaded.has(path)) {
      const content = preloaded.get(path) ?? null
      return {
        path: relative(cwd, path).replace(/\\/g, "/"),
        existedBefore: content !== null,
        content,
      }
    }
    const existedBefore = existsSync(path)
    return {
      path: relative(cwd, path).replace(/\\/g, "/"),
      existedBefore,
      content: existedBefore ? readFileSync(path, "utf-8") : null,
    }
  })
  const transaction: FileTransaction = {
    id,
    createdAt: Date.now(),
    cwd,
    tool: input.tool,
    snapshots,
  }
  mkdirSync(transactionDir(cwd), { recursive: true })
  writeFileSync(transactionPath(id, cwd), JSON.stringify(transaction, null, 2), "utf-8")
  return transaction
}

export function loadTransaction(id: string, cwd = process.cwd()): FileTransaction | null {
  const path = transactionPath(id, cwd)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, "utf-8")) as FileTransaction
}

export function rollbackTransaction(id: string, cwd = process.cwd()): { restored: string[]; deleted: string[] } {
  const transaction = loadTransaction(id, cwd)
  if (!transaction) throw new Error(`Transaction not found: ${id}`)
  return rollbackSnapshots(transaction)
}

export function rollbackTransactionPaths(
  id: string,
  paths: string[],
  cwd = process.cwd(),
): { restored: string[]; deleted: string[] } {
  const transaction = loadTransaction(id, cwd)
  if (!transaction) throw new Error(`Transaction not found: ${id}`)
  const selected = new Set(paths.map(path => relative(transaction.cwd, resolve(transaction.cwd, path)).replace(/\\/g, "/")))
  return rollbackSnapshots(transaction, selected)
}

function rollbackSnapshots(
  transaction: FileTransaction,
  selected?: ReadonlySet<string>,
): { restored: string[]; deleted: string[] } {
  const restored: string[] = []
  const deleted: string[] = []

  for (const snapshot of transaction.snapshots) {
    if (selected && !selected.has(snapshot.path)) continue
    const fullPath = resolve(transaction.cwd, snapshot.path)
    if (snapshot.existedBefore) {
      mkdirSync(dirname(fullPath), { recursive: true })
      writeFileSync(fullPath, snapshot.content ?? "", "utf-8")
      restored.push(snapshot.path)
    } else if (existsSync(fullPath)) {
      rmSync(fullPath, { force: true })
      deleted.push(snapshot.path)
    }
  }

  return { restored, deleted }
}
