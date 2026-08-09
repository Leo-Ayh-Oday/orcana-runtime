import { randomUUID } from "node:crypto"
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs"
import { join, resolve } from "node:path"
import type { Database } from "bun:sqlite"
import { canonicalJson, compareCanonicalStrings, sha256Digest } from "./canonical"
import type {
  CasDigest,
  CasLink,
  CasObjectRecord,
  WorldFaultPoint,
  WorldIntegrityIssue,
} from "./contracts"
import { dbAll, dbGet, dbRun, withImmediateTransaction } from "./database"
import { assertWorldSchemaCompatible } from "./schema"

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

interface AuthoritativeCasReference {
  readonly ownerType: "world_object" | "world_artifact" | "world_service" | "snapshot"
  readonly ownerId: string
  readonly digest: CasDigest
  readonly worldId: string
}

interface MaterializedReferenceRow {
  worldId: string
  branchId: string
  objectId: string
  digest: string
}

interface SnapshotReferenceRow {
  worldId: string
  snapshotId: string
  manifestDigest: string
  filesystemDigest: string
  memoryDigest: string
  taskStateDigest: string
  capabilityStateDigest: string
  serviceStateDigest: string
  artifactStateDigest: string
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

export function encodeCasOwnerId(parts: readonly string[]): string {
  return canonicalJson(parts)
}

function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

function descriptorPath(fd: number, entry?: string): string {
  const root = `/proc/self/fd/${fd}`
  return entry === undefined ? root : join(root, entry)
}

function openDirectoryNoFollow(path: string): number {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  if (!fstatSync(fd).isDirectory()) {
    closeSync(fd)
    throw new CasIntegrityError(`CAS path is not a directory: ${path}`)
  }
  return fd
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
  private readonly trustedRoot: string
  private readonly rootFd: number
  private closed = false

  constructor(
    private readonly db: Database,
    root: string,
    private readonly now: () => number = () => Date.now(),
    private readonly faultInjector?: (point: WorldFaultPoint) => void,
    trustedRootFd?: number,
  ) {
    const configuredRoot = resolve(root)
    if (trustedRootFd === undefined) {
      const rootStat = lstatSync(configuredRoot)
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new CasIntegrityError(`CAS root must be a real directory: ${configuredRoot}`)
      }
      this.rootFd = openDirectoryNoFollow(configuredRoot)
    } else {
      const trusted = fstatSync(trustedRootFd)
      if (!trusted.isDirectory()) throw new CasIntegrityError("trusted CAS root fd is not a directory")
      this.rootFd = openSync(
        descriptorPath(trustedRootFd),
        constants.O_RDONLY | constants.O_DIRECTORY,
      )
    }
    this.trustedRoot = realpathSync(descriptorPath(this.rootFd))
    this.objectsRoot = join(this.trustedRoot, "cas", "sha256")
    this.stagingRoot = join(this.trustedRoot, "recovery", "cas-staging")
    try {
      const objectsFd = this.openTrustedDirectory(["cas", "sha256"], true)
      try {
        const stagingFd = this.openTrustedDirectory(["recovery", "cas-staging"], true)
        closeSync(stagingFd)
      } finally {
        closeSync(objectsFd)
      }
    } catch (error) {
      closeSync(this.rootFd)
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    closeSync(this.rootFd)
  }

  private openTrustedDirectory(segments: readonly string[], create: boolean): number {
    if (this.closed) throw new CasIntegrityError("CAS is closed")
    if (segments.length === 0) throw new CasIntegrityError("CAS directory path must be non-empty")
    let currentFd = this.rootFd
    let ownsCurrent = false
    try {
      for (const segment of segments) {
        if (!segment || segment === "." || segment === ".." || /[\\/]/.test(segment)) {
          throw new CasIntegrityError(`invalid CAS directory segment: ${segment}`)
        }
        const entryPath = descriptorPath(currentFd, segment)
        let created = false
        if (create) {
          try {
            mkdirSync(entryPath, { mode: 0o700 })
            created = true
          } catch (error) {
            if (!isFsError(error, "EEXIST")) throw error
          }
        }
        const nextFd = openDirectoryNoFollow(entryPath)
        if (created) {
          fsyncSync(nextFd)
          fsyncSync(currentFd)
        }
        if (ownsCurrent) closeSync(currentFd)
        currentFd = nextFd
        ownsCurrent = true
      }
      return currentFd
    } catch (error) {
      if (ownsCurrent) closeSync(currentFd)
      throw error
    }
  }

  private openDigestDirectory(digest: CasDigest, create: boolean): number {
    const hex = digestHex(digest)
    const objectsFd = this.openTrustedDirectory(["cas", "sha256"], false)
    try {
      const prefix = hex.slice(0, 2)
      const prefixPath = descriptorPath(objectsFd, prefix)
      let created = false
      if (create) {
        try {
          mkdirSync(prefixPath, { mode: 0o700 })
          created = true
        } catch (error) {
          if (!isFsError(error, "EEXIST")) throw error
        }
      }
      const prefixFd = openDirectoryNoFollow(prefixPath)
      if (created) {
        fsyncSync(prefixFd)
        fsyncSync(objectsFd)
      }
      return prefixFd
    } finally {
      closeSync(objectsFd)
    }
  }

  private readObjectFile(digest: CasDigest): Buffer {
    const hex = digestHex(digest)
    let prefixFd: number
    try {
      prefixFd = this.openDigestDirectory(digest, false)
    } catch (error) {
      if (isFsError(error, "ENOENT")) {
        throw new CasIntegrityError(`CAS object file is missing: ${digest}`)
      }
      throw new CasIntegrityError(`CAS object path is unsafe: ${digest}: ${String(error)}`)
    }
    try {
      let fileFd: number
      try {
        fileFd = openSync(
          descriptorPath(prefixFd, hex),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        )
      } catch (error) {
        if (isFsError(error, "ENOENT")) {
          throw new CasIntegrityError(`CAS object file is missing: ${digest}`)
        }
        throw new CasIntegrityError(`CAS object path is unsafe: ${digest}: ${String(error)}`)
      }
      try {
        if (!fstatSync(fileFd).isFile()) {
          throw new CasIntegrityError(`CAS object path is not a regular file: ${digest}`)
        }
        return readFileSync(fileFd)
      } finally {
        closeSync(fileFd)
      }
    } finally {
      closeSync(prefixFd)
    }
  }

  private removeObjectFile(digest: CasDigest): void {
    const hex = digestHex(digest)
    let prefixFd: number
    try {
      prefixFd = this.openDigestDirectory(digest, false)
    } catch (error) {
      if (isFsError(error, "ENOENT")) return
      throw error
    }
    try {
      const path = descriptorPath(prefixFd, hex)
      let stat: ReturnType<typeof lstatSync>
      try {
        stat = lstatSync(path)
      } catch (error) {
        if (isFsError(error, "ENOENT")) return
        throw error
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new CasIntegrityError(`refusing to remove unsafe CAS object path: ${digest}`)
      }
      rmSync(path)
      fsyncSync(prefixFd)
    } finally {
      closeSync(prefixFd)
    }
  }

  resolveObjectPath(digest: CasDigest): string {
    const hex = digestHex(digest)
    return join(this.objectsRoot, hex.slice(0, 2), hex)
  }

  put(content: Uint8Array, mediaType = "application/octet-stream"): CasObjectRecord {
    return withImmediateTransaction(this.db, () => {
      const bytes = Buffer.from(content)
      const digest = sha256Digest(bytes)
      const hex = digestHex(digest)
      const prefixFd = this.openDigestDirectory(digest, true)
      let stagingFd: number
      try {
        stagingFd = this.openTrustedDirectory(["recovery", "cas-staging"], false)
      } catch (error) {
        closeSync(prefixFd)
        throw error
      }
      try {
        const destination = descriptorPath(prefixFd, hex)
        let existingBytes: Buffer | undefined
        try {
          const existingFd = openSync(
            destination,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          )
          try {
            if (!fstatSync(existingFd).isFile()) {
              throw new CasIntegrityError(`CAS object path is not a regular file: ${digest}`)
            }
            existingBytes = readFileSync(existingFd)
          } finally {
            closeSync(existingFd)
          }
        } catch (error) {
          if (!isFsError(error, "ENOENT")) throw error
        }
        if (existingBytes !== undefined) {
          if (sha256Digest(existingBytes) !== digest || !existingBytes.equals(bytes)) {
            throw new CasIntegrityError(`CAS collision or corrupt existing object: ${digest}`)
          }
        } else {
          const temporaryName = `${hex}.${process.pid}.${randomUUID()}.tmp`
          const temporary = descriptorPath(stagingFd, temporaryName)
          const fd = openSync(
            temporary,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          )
          try {
            writeAll(fd, bytes)
            fsyncSync(fd)
            this.faultInjector?.("after_cas_temp_fsync")
          } finally {
            closeSync(fd)
          }
          renameSync(temporary, destination)
          fsyncSync(prefixFd)
          fsyncSync(stagingFd)
          this.faultInjector?.("after_cas_rename_before_metadata")
        }
      } finally {
        closeSync(prefixFd)
        closeSync(stagingFd)
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
      this.faultInjector?.("after_cas_metadata_before_return")
      return record
    })
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
    try {
      this.get(digest)
      return true
    } catch (error) {
      if (error instanceof CasIntegrityError) return false
      throw error
    }
  }

  get(digest: CasDigest): Buffer {
    const record = this.record(digest)
    if (!record) throw new CasIntegrityError(`CAS object is not registered: ${digest}`)
    const content = this.readObjectFile(digest)
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
    withImmediateTransaction(this.db, () => {
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
      if (uniqueDigests.length > 0) this.faultInjector?.("before_cas_link_insert")
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
    withImmediateTransaction(this.db, () => {
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
    withImmediateTransaction(this.db, () => {
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
    withImmediateTransaction(this.db, () => {
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

  private authoritativeReferences(): AuthoritativeCasReference[] {
    const references: AuthoritativeCasReference[] = []
    const appendMaterialized = (
      ownerType: AuthoritativeCasReference["ownerType"],
      table: "world_objects" | "world_artifacts" | "world_services",
      idColumn: "object_id" | "artifact_id" | "service_id",
      digestColumn: "content_ref" | "definition_digest",
    ): void => {
      const rows = dbAll<MaterializedReferenceRow>(
        this.db,
        `SELECT world_id AS worldId, branch_id AS branchId,
                ${idColumn} AS objectId, ${digestColumn} AS digest
         FROM ${table} WHERE ${digestColumn} IS NOT NULL`,
      )
      for (const row of rows) {
        references.push({
          ownerType,
          ownerId: encodeCasOwnerId([row.worldId, row.branchId, row.objectId]),
          digest: row.digest as CasDigest,
          worldId: row.worldId,
        })
      }
    }
    appendMaterialized("world_object", "world_objects", "object_id", "content_ref")
    appendMaterialized("world_artifact", "world_artifacts", "artifact_id", "content_ref")
    appendMaterialized("world_service", "world_services", "service_id", "definition_digest")

    const snapshots = dbAll<SnapshotReferenceRow>(
      this.db,
      `SELECT world_id AS worldId, snapshot_id AS snapshotId,
              manifest_digest AS manifestDigest, filesystem_digest AS filesystemDigest,
              memory_digest AS memoryDigest, task_state_digest AS taskStateDigest,
              capability_state_digest AS capabilityStateDigest,
              service_state_digest AS serviceStateDigest,
              artifact_state_digest AS artifactStateDigest
       FROM world_snapshots`,
    )
    for (const snapshot of snapshots) {
      const digests = new Set([
        snapshot.manifestDigest,
        snapshot.filesystemDigest,
        snapshot.memoryDigest,
        snapshot.taskStateDigest,
        snapshot.capabilityStateDigest,
        snapshot.serviceStateDigest,
        snapshot.artifactStateDigest,
      ])
      for (const digest of digests) {
        references.push({
          ownerType: "snapshot",
          ownerId: snapshot.snapshotId,
          digest: digest as CasDigest,
          worldId: snapshot.worldId,
        })
      }
    }
    return references.sort((left, right) => {
      const ownerType = compareCanonicalStrings(left.ownerType, right.ownerType)
      if (ownerType !== 0) return ownerType
      const ownerId = compareCanonicalStrings(left.ownerId, right.ownerId)
      return ownerId !== 0 ? ownerId : compareCanonicalStrings(left.digest, right.digest)
    })
  }

  private reachableDigests(references = this.authoritativeReferences()): Set<CasDigest> {
    const reachable = new Set<CasDigest>()
    const pending = references.map(reference => reference.digest)
    while (pending.length > 0) {
      const digest = pending.pop()!
      if (reachable.has(digest)) continue
      reachable.add(digest)
      for (const link of this.linksForOwner("cas_object", digest)) pending.push(link.digest)
    }
    return reachable
  }

  private manifestReferenceIssues(record: CasObjectRecord, content: Buffer): WorldIntegrityIssue[] {
    if (record.mediaType !== "application/vnd.orcana.manifest+json") return []
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(content.toString("utf8")) as Record<string, unknown>
    } catch {
      return [{ code: "CAS_CONTENT_CORRUPT", detail: `invalid manifest JSON ${record.digest}` }]
    }
    if (!manifest || typeof manifest !== "object" || manifest.schemaVersion !== 1) {
      return [{ code: "CAS_CONTENT_CORRUPT", detail: `invalid manifest envelope ${record.digest}` }]
    }
    const recognizedType = manifest.type === "file" ||
      manifest.type === "directory" ||
      manifest.type === "world-section" ||
      manifest.type === "world"
    if (!recognizedType) {
      return [{ code: "CAS_CONTENT_CORRUPT", detail: `unknown manifest type ${record.digest}` }]
    }
    const declared: string[] = []
    if (manifest.type === "file") {
      if (!Array.isArray(manifest.chunks)) {
        return [{ code: "CAS_CONTENT_CORRUPT", detail: `invalid file manifest ${record.digest}` }]
      }
      for (const chunk of manifest.chunks) {
        if (chunk && typeof chunk === "object" && typeof (chunk as { digest?: unknown }).digest === "string") {
          declared.push((chunk as { digest: string }).digest)
        }
      }
      if (declared.length !== manifest.chunks.length) {
        return [{ code: "CAS_CONTENT_CORRUPT", detail: `invalid file manifest ${record.digest}` }]
      }
    } else if (manifest.type === "directory") {
      if (!Array.isArray(manifest.entries)) {
        return [{ code: "CAS_CONTENT_CORRUPT", detail: `invalid directory manifest ${record.digest}` }]
      }
      for (const entry of manifest.entries) {
        if (entry && typeof entry === "object" && typeof (entry as { digest?: unknown }).digest === "string") {
          declared.push((entry as { digest: string }).digest)
        }
      }
      if (declared.length !== manifest.entries.length) {
        return [{ code: "CAS_CONTENT_CORRUPT", detail: `invalid directory manifest ${record.digest}` }]
      }
    } else if (manifest.type === "world-section") {
      if (!Array.isArray(manifest.entries)) {
        return [{ code: "CAS_CONTENT_CORRUPT", detail: `invalid section manifest ${record.digest}` }]
      }
      for (const entry of manifest.entries) {
        const contentRef = entry && typeof entry === "object"
          ? (entry as { contentRef?: unknown }).contentRef
          : undefined
        if (typeof contentRef === "string") declared.push(contentRef)
      }
    } else if (manifest.type === "world") {
      for (const field of [
        "filesystemDigest",
        "memoryDigest",
        "taskStateDigest",
        "capabilityStateDigest",
        "serviceStateDigest",
        "artifactStateDigest",
      ]) {
        if (typeof manifest[field] !== "string") {
          return [{ code: "CAS_CONTENT_CORRUPT", detail: `invalid world manifest ${record.digest}` }]
        }
        declared.push(manifest[field] as string)
      }
    }
    const expected = [...new Set(declared)].sort(compareCanonicalStrings)
    const actual = this.linksForOwner("cas_object", record.digest)
      .map(link => link.digest)
      .sort(compareCanonicalStrings)
    if (expected.length !== actual.length || expected.some((digest, index) => digest !== actual[index])) {
      return [{
        code: "CAS_REFERENCE_DIVERGENCE",
        detail: `manifest ${record.digest} declared references do not match CAS links`,
      }]
    }
    return []
  }

  gc(): CasDigest[] {
    return withImmediateTransaction(this.db, () => {
      assertWorldSchemaCompatible(this.db)
      const blocking = this.verifyIntegrity().filter(issue => issue.code !== "UNREACHABLE_OBJECT_LEAK")
      if (blocking.length > 0) {
        throw new CasIntegrityError(`CAS GC refused on integrity failure: ${blocking.map(issue => issue.code).join(", ")}`)
      }
      const reachable = this.reachableDigests()
      const removed = this.list()
        .map(record => record.digest)
        .filter(digest => !reachable.has(digest))
        .sort(compareCanonicalStrings)
      for (const digest of removed) {
        this.removeObjectFile(digest)
        this.faultInjector?.("after_gc_file_fsync_before_metadata_commit")
        dbRun(this.db, "DELETE FROM cas_links WHERE digest = ?", digest)
        dbRun(
          this.db,
          "DELETE FROM cas_links WHERE owner_type = 'cas_object' AND owner_id = ?",
          digest,
        )
        dbRun(this.db, "DELETE FROM cas_objects WHERE digest = ?", digest)
      }
      this.reconcileRefCounts()
      return removed
    })
  }

  verifyIntegrity(): WorldIntegrityIssue[] {
    const issues: WorldIntegrityIssue[] = []
    const references = this.authoritativeReferences()
    for (const reference of references) {
      const link = dbGet<{ found: number }>(
        this.db,
        `SELECT 1 AS found FROM cas_links
         WHERE owner_type = ? AND owner_id = ? AND digest = ?`,
        reference.ownerType,
        reference.ownerId,
        reference.digest,
      )
      if (!link) {
        issues.push({
          code: "CAS_REFERENCE_DIVERGENCE",
          worldId: reference.worldId,
          detail: `missing root link ${reference.ownerType}/${reference.ownerId} -> ${reference.digest}`,
        })
      }
    }

    const reachable = this.reachableDigests(references)
    for (const digest of reachable) {
      const record = this.record(digest)
      if (!record) {
        issues.push({ code: "CAS_MISSING_REFERENCED_OBJECT", detail: `unregistered ${digest}` })
        continue
      }
      let content: Buffer
      try {
        content = this.get(record.digest)
      } catch (error) {
        const missing = error instanceof CasIntegrityError && error.message.includes("is missing")
        issues.push({
          code: missing ? "CAS_MISSING_REFERENCED_OBJECT" : "CAS_CONTENT_CORRUPT",
          detail: `${missing ? "missing" : "corrupt or unsafe"} ${record.digest}`,
        })
        continue
      }
      issues.push(...this.manifestReferenceIssues(record, content))
    }

    for (const record of this.list()) {
      const actualCount = dbGet<{ count: number }>(
        this.db,
        "SELECT COUNT(*) AS count FROM cas_links WHERE digest = ?",
        record.digest,
      )?.count ?? 0
      if (actualCount !== record.refCount) {
        issues.push({
          code: "CAS_REFERENCE_DIVERGENCE",
          detail: `refCount mismatch ${record.digest}: stored=${record.refCount} actual=${actualCount}`,
        })
      }
      if (!reachable.has(record.digest)) {
        issues.push({ code: "UNREACHABLE_OBJECT_LEAK", detail: `unreachable ${record.digest}` })
      }
    }
    return issues
  }

  recover(): CasRecoveryResult {
    return withImmediateTransaction(this.db, () => {
      assertWorldSchemaCompatible(this.db)
      const stagingFd = this.openTrustedDirectory(["recovery", "cas-staging"], false)
      let objectsFd: number
      try {
        objectsFd = this.openTrustedDirectory(["cas", "sha256"], false)
      } catch (error) {
        closeSync(stagingFd)
        throw error
      }
      try {
        const temporaryFiles = readdirSync(descriptorPath(stagingFd))
        for (const file of temporaryFiles) {
          const stat = lstatSync(descriptorPath(stagingFd, file))
          if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new CasIntegrityError(`unsafe CAS staging entry: ${file}`)
          }
        }

        const registered = new Set(this.list().map(record => digestHex(record.digest)))
        const protectedUnregistered = new Set<string>()
        for (const reference of this.authoritativeReferences()) {
          try {
            protectedUnregistered.add(digestHex(reference.digest))
          } catch {
            // verifyIntegrity will report the invalid/missing authoritative reference.
          }
        }
        const fileOnlyCandidates: Array<{ file: string; digest: CasDigest }> = []
        for (const prefix of readdirSync(descriptorPath(objectsFd))) {
          if (!/^[a-f0-9]{2}$/.test(prefix)) {
            throw new CasIntegrityError(`unsafe CAS prefix entry: ${prefix}`)
          }
          const prefixPath = descriptorPath(objectsFd, prefix)
          const prefixStat = lstatSync(prefixPath)
          if (prefixStat.isSymbolicLink() || !prefixStat.isDirectory()) {
            throw new CasIntegrityError(`unsafe CAS prefix path: ${prefix}`)
          }
          const prefixFd = openDirectoryNoFollow(prefixPath)
          try {
            for (const file of readdirSync(descriptorPath(prefixFd))) {
              const stat = lstatSync(descriptorPath(prefixFd, file))
              if (
                !/^[a-f0-9]{64}$/.test(file) ||
                !file.startsWith(prefix) ||
                stat.isSymbolicLink() ||
                !stat.isFile()
              ) {
                throw new CasIntegrityError(`unsafe CAS object entry: ${prefix}/${file}`)
              }
              if (registered.has(file) || protectedUnregistered.has(file)) continue
              fileOnlyCandidates.push({
                file,
                digest: `sha256:${file}`,
              })
            }
          } finally {
            closeSync(prefixFd)
          }
        }

        const removedTemporaryFiles: string[] = []
        for (const file of temporaryFiles) {
          const path = descriptorPath(stagingFd, file)
          const stat = lstatSync(path)
          if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new CasIntegrityError(`unsafe CAS staging entry: ${file}`)
          }
          rmSync(path)
          removedTemporaryFiles.push(join(this.stagingRoot, file))
        }
        if (removedTemporaryFiles.length > 0) fsyncSync(stagingFd)

        const repairedRefCounts = this.reconcileRefCounts()
        const beforeGc = this.verifyIntegrity()
        const blocking = beforeGc.filter(issue => issue.code !== "UNREACHABLE_OBJECT_LEAK")
        const removedFileOnly: CasDigest[] = []
        if (blocking.length === 0) {
          for (const candidate of fileOnlyCandidates) {
            const prefixFd = this.openDigestDirectory(candidate.digest, false)
            try {
              const path = descriptorPath(prefixFd, candidate.file)
              const stat = lstatSync(path)
              if (stat.isSymbolicLink() || !stat.isFile()) {
                throw new CasIntegrityError(
                  `refusing to remove unsafe CAS file-only path: ${candidate.digest}`,
                )
              }
              rmSync(path)
              fsyncSync(prefixFd)
              removedFileOnly.push(candidate.digest)
            } finally {
              closeSync(prefixFd)
            }
          }
        }
        const removedUnreachableObjects = blocking.length === 0 ? this.gc() : []
        const integrityIssues = this.verifyIntegrity()
        return {
          removedTemporaryFiles,
          removedUnreachableObjects: [...removedFileOnly, ...removedUnreachableObjects],
          repairedRefCounts,
          integrityIssues,
        }
      } finally {
        closeSync(stagingFd)
        closeSync(objectsFd)
      }
    })
  }
}
