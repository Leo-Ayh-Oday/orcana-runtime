import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs"
import { dirname, join } from "node:path"
import type { Database } from "bun:sqlite"
import { sha256Digest } from "./canonical"
import type { CasDigest, CasLink, CasObjectRecord, WorldIntegrityIssue } from "./contracts"
import { dbAll, dbGet, dbRun, withDatabaseTransaction } from "./database"

interface CasObjectRow {
  digest: string
  size: number
  mediaType: string
  createdAt: number
  refCount: number
}

interface CasLinkRow {
  ownerType: string
  ownerId: string
  digest: string
  createdAt: number
}

export interface CasRecoveryResult {
  readonly removedTemporaryFiles: readonly string[]
  readonly removedUnreachableObjects: readonly CasDigest[]
  readonly repairedRefCounts: readonly CasDigest[]
  readonly integrityIssues: readonly WorldIntegrityIssue[]
}

export class CasIntegrityError extends Error {
  readonly code = "CAS_INTEGRITY_ERROR"

  constructor(message: string) {
    super(message)
    this.name = "CasIntegrityError"
  }
}

function toRecord(row: CasObjectRow): CasObjectRecord {
  return {
    digest: row.digest as CasDigest,
    size: row.size,
    mediaType: row.mediaType,
    createdAt: row.createdAt,
    refCount: row.refCount,
  }
}

function toLink(row: CasLinkRow): CasLink {
  return {
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    digest: row.digest as CasDigest,
    createdAt: row.createdAt,
  }
}

function digestHex(digest: CasDigest): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(digest)
  if (!match) throw new Error(`invalid CAS digest: ${String(digest).slice(0, 80)}`)
  return match[1]!
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset, offset)
    if (written <= 0) throw new CasIntegrityError("CAS temporary write made no progress")
    offset += written
  }
}

export class WorldCas {
  readonly objectsRoot: string
  readonly stagingRoot: string

  constructor(
    private readonly db: Database,
    root: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.objectsRoot = join(root, "cas", "sha256")
    this.stagingRoot = join(root, "recovery", "cas-staging")
    mkdirSync(this.objectsRoot, { recursive: true, mode: 0o700 })
    mkdirSync(this.stagingRoot, { recursive: true, mode: 0o700 })
  }

  resolveObjectPath(digest: CasDigest): string {
    const hex = digestHex(digest)
    return join(this.objectsRoot, hex.slice(0, 2), hex)
  }

  put(content: Uint8Array, mediaType = "application/octet-stream"): CasObjectRecord {
    const bytes = Buffer.from(content)
    const digest = sha256Digest(bytes)
    const destination = this.resolveObjectPath(digest)
    const parent = dirname(destination)
    mkdirSync(parent, { recursive: true, mode: 0o700 })

    if (existsSync(destination)) {
      const existingBytes = readFileSync(destination)
      if (sha256Digest(existingBytes) !== digest || !existingBytes.equals(bytes)) {
        throw new CasIntegrityError(`CAS collision or corrupt existing object: ${digest}`)
      }
    } else {
      const temporary = join(this.stagingRoot, `${digestHex(digest)}.${process.pid}.${randomUUID()}.tmp`)
      const fd = openSync(temporary, "wx", 0o600)
      try {
        writeAll(fd, bytes)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, destination)
      fsyncDirectory(parent)
    }

    dbRun(
      this.db,
      `INSERT INTO cas_objects (digest, size, media_type, created_at, ref_count)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(digest) DO NOTHING`,
      digest,
      bytes.byteLength,
      mediaType,
      this.now(),
    )

    const record = this.record(digest)
    if (!record || record.size !== bytes.byteLength || record.mediaType !== mediaType) {
      throw new CasIntegrityError(`CAS metadata mismatch: ${digest}`)
    }
    return record
  }

  record(digest: CasDigest): CasObjectRecord | undefined {
    digestHex(digest)
    const row = dbGet<CasObjectRow>(
      this.db,
      `SELECT digest, size, media_type AS mediaType, created_at AS createdAt, ref_count AS refCount
       FROM cas_objects WHERE digest = ?`,
      digest,
    )
    return row ? toRecord(row) : undefined
  }

  has(digest: CasDigest): boolean {
    const record = this.record(digest)
    return record !== undefined && existsSync(this.resolveObjectPath(digest))
  }

  get(digest: CasDigest): Buffer {
    const record = this.record(digest)
    if (!record) throw new CasIntegrityError(`CAS object is not registered: ${digest}`)
    const path = this.resolveObjectPath(digest)
    if (!existsSync(path)) throw new CasIntegrityError(`CAS object file is missing: ${digest}`)
    const content = readFileSync(path)
    if (content.byteLength !== record.size || sha256Digest(content) !== digest) {
      throw new CasIntegrityError(`CAS object content is corrupt: ${digest}`)
    }
    return content
  }

  link(ownerType: string, ownerId: string, digest: CasDigest): void {
    this.linkMany(ownerType, ownerId, [digest])
  }

  linkMany(ownerType: string, ownerId: string, digests: readonly CasDigest[]): void {
    if (!ownerType || !ownerId) throw new Error("CAS link owner must be non-empty")
    const uniqueDigests = [...new Set(digests)]
    for (const digest of uniqueDigests) {
      try {
        this.get(digest)
      } catch (error) {
        if (error instanceof CasIntegrityError) {
          throw new CasIntegrityError(`cannot link invalid CAS object ${digest}: ${error.message}`)
        }
        throw error
      }
    }

    withDatabaseTransaction(this.db, () => {
      for (const digest of uniqueDigests) {
        const inserted = dbRun(
          this.db,
          `INSERT INTO cas_links (owner_type, owner_id, digest, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(owner_type, owner_id, digest) DO NOTHING`,
          ownerType,
          ownerId,
          digest,
          this.now(),
        )
        if (inserted.changes === 1) {
          dbRun(this.db, "UPDATE cas_objects SET ref_count = ref_count + 1 WHERE digest = ?", digest)
        }
      }
    })
  }

  unlink(ownerType: string, ownerId: string, digest: CasDigest): void {
    digestHex(digest)
    withDatabaseTransaction(this.db, () => {
      const removed = dbRun(
        this.db,
        "DELETE FROM cas_links WHERE owner_type = ? AND owner_id = ? AND digest = ?",
        ownerType,
        ownerId,
        digest,
      )
      if (removed.changes === 1) {
        dbRun(
          this.db,
          "UPDATE cas_objects SET ref_count = MAX(ref_count - 1, 0) WHERE digest = ?",
          digest,
        )
      }
    })
  }

  unlinkOwner(ownerType: string, ownerId: string): void {
    withDatabaseTransaction(this.db, () => {
      const links = this.linksForOwner(ownerType, ownerId)
      for (const link of links) this.unlink(link.ownerType, link.ownerId, link.digest)
    })
  }

  linksForOwner(ownerType: string, ownerId: string): CasLink[] {
    return dbAll<CasLinkRow>(
      this.db,
      `SELECT owner_type AS ownerType, owner_id AS ownerId, digest, created_at AS createdAt
       FROM cas_links WHERE owner_type = ? AND owner_id = ? ORDER BY digest`,
      ownerType,
      ownerId,
    ).map(toLink)
  }

  list(): CasObjectRecord[] {
    return dbAll<CasObjectRow>(
      this.db,
      `SELECT digest, size, media_type AS mediaType, created_at AS createdAt, ref_count AS refCount
       FROM cas_objects ORDER BY digest`,
    ).map(toRecord)
  }

  reconcileRefCounts(): CasDigest[] {
    const repaired: CasDigest[] = []
    withDatabaseTransaction(this.db, () => {
      const rows = dbAll<CasObjectRow>(
        this.db,
        `SELECT o.digest, o.size, o.media_type AS mediaType, o.created_at AS createdAt,
                o.ref_count AS refCount
         FROM cas_objects o ORDER BY o.digest`,
      )
      for (const row of rows) {
        const count = dbGet<{ count: number }>(
          this.db,
          "SELECT COUNT(*) AS count FROM cas_links WHERE digest = ?",
          row.digest,
        )?.count ?? 0
        if (count !== row.refCount) {
          dbRun(this.db, "UPDATE cas_objects SET ref_count = ? WHERE digest = ?", count, row.digest)
          repaired.push(row.digest as CasDigest)
        }
      }
    })
    return repaired
  }

  gc(): CasDigest[] {
    const removed: CasDigest[] = []
    for (;;) {
      const candidate = dbGet<{ digest: string }>(
        this.db,
        "SELECT digest FROM cas_objects WHERE ref_count = 0 ORDER BY digest LIMIT 1",
      )
      if (!candidate) break
      const digest = candidate.digest as CasDigest
      rmSync(this.resolveObjectPath(digest), { force: true })
      withDatabaseTransaction(this.db, () => {
        const outgoing = this.linksForOwner("cas_object", digest)
        for (const link of outgoing) this.unlink(link.ownerType, link.ownerId, link.digest)
        dbRun(this.db, "DELETE FROM cas_objects WHERE digest = ? AND ref_count = 0", digest)
      })
      removed.push(digest)
    }
    return removed
  }

  verifyIntegrity(): WorldIntegrityIssue[] {
    const issues: WorldIntegrityIssue[] = []
    for (const record of this.list()) {
      if (record.refCount === 0) continue
      const path = this.resolveObjectPath(record.digest)
      if (!existsSync(path)) {
        issues.push({
          code: "CAS_MISSING_REFERENCED_OBJECT",
          detail: `missing ${record.digest} with refCount=${record.refCount}`,
        })
        continue
      }
      const content = readFileSync(path)
      if (content.byteLength !== record.size || sha256Digest(content) !== record.digest) {
        issues.push({
          code: "CAS_CONTENT_CORRUPT",
          detail: `corrupt ${record.digest}`,
        })
      }
    }
    return issues
  }

  recover(): CasRecoveryResult {
    const removedTemporaryFiles: string[] = []
    for (const file of readdirSync(this.stagingRoot)) {
      const path = join(this.stagingRoot, file)
      if (statSync(path).isFile()) {
        rmSync(path, { force: true })
        removedTemporaryFiles.push(path)
      }
    }

    const registered = new Set(this.list().map(record => digestHex(record.digest)))
    for (const prefix of readdirSync(this.objectsRoot)) {
      const prefixPath = join(this.objectsRoot, prefix)
      if (!statSync(prefixPath).isDirectory()) continue
      for (const file of readdirSync(prefixPath)) {
        if (!/^[a-f0-9]{64}$/.test(file) || registered.has(file)) continue
        rmSync(join(prefixPath, file), { force: true })
      }
    }

    const repairedRefCounts = this.reconcileRefCounts()
    const removedUnreachableObjects = this.gc()
    const integrityIssues = this.verifyIntegrity()
    return {
      removedTemporaryFiles,
      removedUnreachableObjects,
      repairedRefCounts,
      integrityIssues,
    }
  }
}
