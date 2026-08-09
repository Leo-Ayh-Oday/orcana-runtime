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
  isManifest: number
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

const MANIFEST_MEDIA_TYPE = "application/vnd.orcana.manifest+json"

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

function toRecord(row: CasObjectRow, mediaTypes: readonly string[]): CasObjectRecord {
  return {
    digest: row.digest as CasDigest,
    size: row.size,
    mediaType: row.mediaType,
    mediaTypes: Object.freeze([...mediaTypes]),
    isManifest: row.isManifest === 1,
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

function manifestRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CasIntegrityError(`${context} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertManifestKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  context: string,
): void {
  const allowed = new Set([...required, ...optional])
  const missing = required.filter(key => !Object.prototype.hasOwnProperty.call(value, key))
  const extra = Object.keys(value).filter(key => !allowed.has(key))
  if (missing.length > 0 || extra.length > 0) {
    throw new CasIntegrityError(
      `${context} has invalid keys (missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"})`,
    )
  }
}

function manifestString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CasIntegrityError(`${context} must be a non-empty string`)
  }
  return value
}

function manifestDigest(value: unknown, context: string): CasDigest {
  const digest = manifestString(value, context)
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new CasIntegrityError(`${context} is not a canonical CAS digest`)
  }
  return digest as CasDigest
}

function manifestInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CasIntegrityError(`${context} must be a non-negative safe integer`)
  }
  return value as number
}

function parseManifestReferences(content: Buffer, digest: CasDigest): CasDigest[] {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content)
  } catch {
    throw new CasIntegrityError(`manifest ${digest} is not valid UTF-8`)
  }
  if (!Buffer.from(text, "utf8").equals(content)) {
    throw new CasIntegrityError(`manifest ${digest} is not canonical UTF-8`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CasIntegrityError(`manifest ${digest} is not valid JSON`)
  }
  let canonical: string
  try {
    canonical = canonicalJson(parsed)
  } catch (error) {
    throw new CasIntegrityError(
      `manifest ${digest} cannot be canonically encoded: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (canonical !== text) {
    throw new CasIntegrityError(`manifest ${digest} is not canonically encoded`)
  }

  const root = manifestRecord(parsed, `manifest ${digest}`)
  if (root.schemaVersion !== 1) {
    throw new CasIntegrityError(`manifest ${digest} has unsupported schemaVersion`)
  }
  const references: CasDigest[] = []

  if (root.type === "file") {
    assertManifestKeys(root, ["schemaVersion", "type", "mediaType", "size", "chunks"], [], `file manifest ${digest}`)
    manifestString(root.mediaType, `file manifest ${digest} mediaType`)
    const size = manifestInteger(root.size, `file manifest ${digest} size`)
    if (!Array.isArray(root.chunks)) {
      throw new CasIntegrityError(`file manifest ${digest} chunks must be an array`)
    }
    let expectedOffset = 0
    for (const [index, rawChunk] of root.chunks.entries()) {
      const chunk = manifestRecord(rawChunk, `file manifest ${digest} chunk ${index}`)
      assertManifestKeys(chunk, ["digest", "offset", "size"], [], `file manifest ${digest} chunk ${index}`)
      const chunkDigest = manifestDigest(chunk.digest, `file manifest ${digest} chunk ${index} digest`)
      const offset = manifestInteger(chunk.offset, `file manifest ${digest} chunk ${index} offset`)
      const chunkSize = manifestInteger(chunk.size, `file manifest ${digest} chunk ${index} size`)
      if (chunkSize === 0 || offset !== expectedOffset || expectedOffset + chunkSize > size) {
        throw new CasIntegrityError(`file manifest ${digest} has a non-contiguous chunk layout`)
      }
      expectedOffset += chunkSize
      references.push(chunkDigest)
    }
    if (expectedOffset !== size || (size === 0 && root.chunks.length !== 0)) {
      throw new CasIntegrityError(`file manifest ${digest} chunks do not cover its declared size`)
    }
  } else if (root.type === "directory") {
    assertManifestKeys(root, ["schemaVersion", "type", "entries"], [], `directory manifest ${digest}`)
    if (!Array.isArray(root.entries)) {
      throw new CasIntegrityError(`directory manifest ${digest} entries must be an array`)
    }
    let previousName: string | undefined
    for (const [index, rawEntry] of root.entries.entries()) {
      const entry = manifestRecord(rawEntry, `directory manifest ${digest} entry ${index}`)
      assertManifestKeys(entry, ["name", "kind", "digest"], ["mode"], `directory manifest ${digest} entry ${index}`)
      const name = manifestString(entry.name, `directory manifest ${digest} entry ${index} name`)
      if (name === "." || name === ".." || /[\\/]/.test(name)) {
        throw new CasIntegrityError(`directory manifest ${digest} contains an unsafe name`)
      }
      if (previousName !== undefined && compareCanonicalStrings(previousName, name) >= 0) {
        throw new CasIntegrityError(`directory manifest ${digest} entries are not uniquely sorted`)
      }
      previousName = name
      if (entry.kind !== "file" && entry.kind !== "directory") {
        throw new CasIntegrityError(`directory manifest ${digest} entry ${index} has invalid kind`)
      }
      if (entry.mode !== undefined) manifestInteger(entry.mode, `directory manifest ${digest} entry ${index} mode`)
      references.push(manifestDigest(entry.digest, `directory manifest ${digest} entry ${index} digest`))
    }
  } else if (root.type === "world-section") {
    assertManifestKeys(root, ["schemaVersion", "type", "section", "entries"], [], `section manifest ${digest}`)
    manifestString(root.section, `section manifest ${digest} section`)
    if (!Array.isArray(root.entries)) {
      throw new CasIntegrityError(`section manifest ${digest} entries must be an array`)
    }
    let previousSortKey: readonly [string, string] | undefined
    const ids = new Set<string>()
    for (const [index, rawEntry] of root.entries.entries()) {
      const entry = manifestRecord(rawEntry, `section manifest ${digest} entry ${index}`)
      assertManifestKeys(entry, ["id", "kind"], ["path", "contentRef", "metadata"], `section manifest ${digest} entry ${index}`)
      const id = manifestString(entry.id, `section manifest ${digest} entry ${index} id`)
      manifestString(entry.kind, `section manifest ${digest} entry ${index} kind`)
      if (ids.has(id)) throw new CasIntegrityError(`section manifest ${digest} contains duplicate id ${id}`)
      ids.add(id)
      const path = entry.path === undefined
        ? ""
        : manifestString(entry.path, `section manifest ${digest} entry ${index} path`)
      const sortKey: readonly [string, string] = [path, id]
      if (previousSortKey !== undefined) {
        const pathOrder = compareCanonicalStrings(previousSortKey[0], sortKey[0])
        if (pathOrder > 0 || (pathOrder === 0 && compareCanonicalStrings(previousSortKey[1], sortKey[1]) >= 0)) {
          throw new CasIntegrityError(`section manifest ${digest} entries are not uniquely sorted`)
        }
      }
      previousSortKey = sortKey
      if (entry.contentRef !== undefined) {
        references.push(manifestDigest(entry.contentRef, `section manifest ${digest} entry ${index} contentRef`))
      }
      if (entry.metadata !== undefined) {
        manifestRecord(entry.metadata, `section manifest ${digest} entry ${index} metadata`)
      }
    }
  } else if (root.type === "world") {
    assertManifestKeys(
      root,
      [
        "schemaVersion", "type", "worldId", "branchId", "revision", "worldStatus", "rootObjectId",
        "filesystemDigest", "memoryDigest", "taskStateDigest", "capabilityStateDigest",
        "serviceStateDigest", "artifactStateDigest",
      ],
      [],
      `world manifest ${digest}`,
    )
    manifestString(root.worldId, `world manifest ${digest} worldId`)
    manifestString(root.branchId, `world manifest ${digest} branchId`)
    const revision = manifestString(root.revision, `world manifest ${digest} revision`)
    if (!/^(0|[1-9][0-9]*)$/.test(revision)) {
      throw new CasIntegrityError(`world manifest ${digest} revision is not canonical`)
    }
    if (!new Set(["active", "suspended", "archived", "corrupted"]).has(root.worldStatus as string)) {
      throw new CasIntegrityError(`world manifest ${digest} has invalid worldStatus`)
    }
    manifestString(root.rootObjectId, `world manifest ${digest} rootObjectId`)
    for (const field of [
      "filesystemDigest", "memoryDigest", "taskStateDigest", "capabilityStateDigest",
      "serviceStateDigest", "artifactStateDigest",
    ]) {
      references.push(manifestDigest(root[field], `world manifest ${digest} ${field}`))
    }
  } else {
    throw new CasIntegrityError(`manifest ${digest} has unknown type`)
  }

  return [...new Set(references)].sort(compareCanonicalStrings)
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
    this.objectsRoot = descriptorPath(this.rootFd, join("cas", "sha256"))
    this.stagingRoot = descriptorPath(this.rootFd, join("recovery", "cas-staging"))
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
        try {
          if (created) {
            fsyncSync(nextFd)
            fsyncSync(currentFd)
          }
        } catch (error) {
          closeSync(nextFd)
          throw error
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
      try {
        if (created) {
          fsyncSync(prefixFd)
          fsyncSync(objectsFd)
        }
        return prefixFd
      } catch (error) {
        closeSync(prefixFd)
        throw error
      }
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
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
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
    if (!mediaType) throw new Error("CAS media type must be non-empty")
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
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
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
        `INSERT INTO cas_objects (digest, size, media_type, is_manifest, created_at, ref_count)
         VALUES (?, ?, ?, 0, ?, 0)
         ON CONFLICT(digest) DO NOTHING`,
        digest,
        bytes.byteLength,
        mediaType,
        this.now(),
      )
      this.recordMediaRole(digest, mediaType)

      const record = this.record(digest)
      if (
        !record ||
        record.size !== bytes.byteLength ||
        !record.mediaTypes.includes(mediaType)
      ) {
        throw new CasIntegrityError(`CAS metadata mismatch: ${digest}`)
      }
      this.faultInjector?.("after_cas_metadata_before_return")
      return record
    })
  }

  putManifest(
    content: Uint8Array,
    referencedDigests: readonly CasDigest[],
  ): CasObjectRecord {
    const bytes = Buffer.from(content)
    const digest = sha256Digest(bytes)
    return withImmediateTransaction(this.db, () => {
      const derivedReferences = parseManifestReferences(bytes, digest)
      const suppliedReferences = [...new Set(referencedDigests)].sort(compareCanonicalStrings)
      if (
        derivedReferences.length !== suppliedReferences.length ||
        derivedReferences.some((reference, index) => reference !== suppliedReferences[index])
      ) {
        throw new CasIntegrityError(
          `manifest ${digest} supplied references do not match its canonical content`,
        )
      }
      for (const reference of derivedReferences) {
        try {
          this.get(reference)
        } catch (error) {
          if (error instanceof CasIntegrityError) {
            throw new CasIntegrityError(
              `manifest ${digest} references invalid CAS object ${reference}: ${error.message}`,
            )
          }
          throw error
        }
      }

      let record = this.record(digest)
      if (record) {
        const existing = this.get(digest)
        if (!existing.equals(bytes)) {
          throw new CasIntegrityError(`CAS collision or corrupt existing manifest: ${digest}`)
        }
      } else {
        record = this.put(bytes, MANIFEST_MEDIA_TYPE)
      }

      this.recordMediaRole(digest, MANIFEST_MEDIA_TYPE)

      if (!record.isManifest) {
        dbRun(
          this.db,
          "UPDATE cas_objects SET is_manifest = 1 WHERE digest = ? AND is_manifest = 0",
          digest,
        )
      }
      this.linkMany("cas_object", digest, derivedReferences)
      const attested = this.record(digest)
      if (!attested?.isManifest) {
        throw new CasIntegrityError(`CAS manifest attestation failed: ${digest}`)
      }
      const actualReferences = this.linksForOwner("cas_object", digest)
        .map(link => link.digest)
        .sort(compareCanonicalStrings)
      if (
        actualReferences.length !== derivedReferences.length ||
        actualReferences.some((reference, index) => reference !== derivedReferences[index])
      ) {
        throw new CasIntegrityError(
          `manifest ${digest} persisted references do not match its canonical content`,
        )
      }
      return attested
    })
  }

  record(digest: CasDigest): CasObjectRecord | undefined {
    digestHex(digest)
    const row = dbGet<CasObjectRow>(
      this.db,
      `SELECT digest, size, media_type AS mediaType, is_manifest AS isManifest,
              created_at AS createdAt, ref_count AS refCount
       FROM cas_objects WHERE digest = ?`,
      digest,
    )
    return row ? toRecord(row, this.mediaRoles(digest)) : undefined
  }

  private recordMediaRole(digest: CasDigest, mediaType: string): void {
    dbRun(
      this.db,
      `INSERT INTO cas_media_roles (digest, media_type, created_at)
       VALUES (?, ?, ?) ON CONFLICT(digest, media_type) DO NOTHING`,
      digest,
      mediaType,
      this.now(),
    )
  }

  private mediaRoles(digest: CasDigest): string[] {
    return dbAll<{ mediaType: string }>(
      this.db,
      `SELECT media_type AS mediaType FROM cas_media_roles
       WHERE digest = ?`,
      digest,
    ).map(row => row.mediaType).sort(compareCanonicalStrings)
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
      `SELECT digest, size, media_type AS mediaType, is_manifest AS isManifest,
              created_at AS createdAt, ref_count AS refCount
       FROM cas_objects ORDER BY digest`,
    ).map(row => toRecord(row, this.mediaRoles(row.digest as CasDigest)))
  }

  reconcileRefCounts(): CasDigest[] {
    const repaired: CasDigest[] = []
    withImmediateTransaction(this.db, () => {
      const rows = dbAll<CasObjectRow>(
        this.db,
        `SELECT o.digest, o.size, o.media_type AS mediaType, o.is_manifest AS isManifest,
                o.created_at AS createdAt,
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
    if (!record.isManifest) return []
    let expected: CasDigest[]
    try {
      expected = parseManifestReferences(content, record.digest)
    } catch (error) {
      return [{
        code: "CAS_CONTENT_CORRUPT",
        detail: error instanceof Error ? error.message : `invalid manifest ${record.digest}`,
      }]
    }
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
        dbRun(this.db, "DELETE FROM cas_media_roles WHERE digest = ?", digest)
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
      if (!record.mediaTypes.includes(record.mediaType)) {
        issues.push({
          code: "CAS_REFERENCE_DIVERGENCE",
          detail: `missing primary media role ${record.digest}: ${record.mediaType}`,
        })
      }
      if (record.isManifest && !record.mediaTypes.includes(MANIFEST_MEDIA_TYPE)) {
        issues.push({
          code: "CAS_REFERENCE_DIVERGENCE",
          detail: `missing manifest media role ${record.digest}`,
        })
      }
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
