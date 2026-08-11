import { randomUUID } from "node:crypto"
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { Database } from "bun:sqlite"
import {
  canonicalDigest,
  canonicalJson,
  compareCanonicalStrings,
  parseCanonicalJson,
  sha256Digest,
} from "./canonical"
import { encodeCasOwnerId, WorldCas } from "./cas"
import type {
  AgentWorld,
  CasDigest,
  WorldArtifact,
  WorldBranch,
  WorldCommitReceipt,
  WorldCommitRequest,
  WorldFaultPoint,
  WorldEvent,
  WorldDeltaMutation,
  WorldDeltaManifest,
  WorldIntegrityIssue,
  WorldMutation,
  WorldObject,
  WorldServiceState,
  WorldSnapshot,
} from "./contracts"
import {
  WORLD_OBJECT_TYPES,
  WorldConflictError,
  WorldCorruptionError,
  worldDeltaManifest,
} from "./contracts"
import { dbAll, dbGet, dbRun, withImmediateTransaction } from "./database"
import { withExclusiveFileLock } from "./file-lock"
import { WorldLedger } from "./ledger"
import {
  assertWorldSchemaCompatible,
  initializeOrValidateWorldSchema,
  WORLD_SCHEMA_FINGERPRINT,
  WORLD_SCHEMA_VERSION,
} from "./schema"
import { WorldSnapshotManager } from "./snapshot"

interface WorldMetaRow {
  worldId: string
  currentRevision: string
  currentBranchId: string
  rootObjectId: string
  status: AgentWorld["status"]
  createdAt: number
  updatedAt: number
}

interface WorldBranchRow {
  worldId: string
  branchId: string
  parentBranchId: string | null
  baseRevision: string
  headRevision: string
  owner: string
  purpose: string
  status: WorldBranch["status"]
  createdAt: number
}

interface WorldObjectRow {
  worldId: string
  branchId: string
  objectId: string
  objectType: WorldObject["objectType"]
  path: string | null
  contentRef: string | null
  metadataJson: string
  updatedRevision: string
  createdAt: number
  updatedAt: number
}

interface WorldArtifactRow {
  worldId: string
  branchId: string
  artifactId: string
  mediaType: string
  contentRef: string
  metadataJson: string
  updatedRevision: string
  createdAt: number
  updatedAt: number
}

interface WorldServiceRow {
  worldId: string
  branchId: string
  serviceId: string
  status: string
  definitionDigest: string | null
  metadataJson: string
  updatedRevision: string
  createdAt: number
  updatedAt: number
}

interface WorldCommitRow {
  commitId: string
  requestDigest: string
  worldId: string
  branchId: string
  baseRevision: string
  newRevision: string
  actor: string
  deltaDigest: string
  materializedStateDigest: string
  executionReceiptIdsJson: string
  effectReceiptIdsJson: string
  committedAt: number
}

interface MaterializedStateImage {
  world: {
    worldId: string
    currentRevision: string
    currentBranchId: string
    rootObjectId: string
    status: AgentWorld["status"]
    createdAt: number
    updatedAt: number
  }
  branch: {
    branchId: string
    parentBranchId: string | null
    baseRevision: string
    headRevision: string
    owner: string
    purpose: string
    status: WorldBranch["status"]
    createdAt: number
  }
  objects: Array<{
    objectId: string
    objectType: WorldObject["objectType"]
    path: string | null
    contentRef: CasDigest | null
    metadata: Readonly<Record<string, unknown>>
    updatedRevision: string
    createdAt: number
    updatedAt: number
  }>
  artifacts: Array<{
    artifactId: string
    mediaType: string
    contentRef: CasDigest
    metadata: Readonly<Record<string, unknown>>
    updatedRevision: string
    createdAt: number
    updatedAt: number
  }>
  services: Array<{
    serviceId: string
    status: string
    definitionDigest: CasDigest | null
    metadata: Readonly<Record<string, unknown>>
    updatedRevision: string
    createdAt: number
    updatedAt: number
  }>
}

export interface WorldStoreOptions {
  readonly root: string
  readonly now?: () => number
  readonly idFactory?: (kind: "world" | "event" | "commit") => string
  readonly faultInjector?: (point: WorldFaultPoint) => void
}

export interface CreateWorldInput {
  readonly worldId?: string
  readonly branchId?: string
  readonly rootObjectId?: string
  readonly owner: string
  readonly purpose?: string
}

function worldFromRow(row: WorldMetaRow): AgentWorld {
  return {
    worldId: row.worldId,
    currentRevision: BigInt(row.currentRevision),
    currentBranchId: row.currentBranchId,
    rootObjectId: row.rootObjectId,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function branchFromRow(row: WorldBranchRow): WorldBranch {
  return {
    worldId: row.worldId,
    branchId: row.branchId,
    parentBranchId: row.parentBranchId ?? undefined,
    baseRevision: BigInt(row.baseRevision),
    headRevision: BigInt(row.headRevision),
    owner: row.owner,
    purpose: row.purpose,
    status: row.status,
    createdAt: row.createdAt,
  }
}

function objectFromRow(row: WorldObjectRow): WorldObject {
  return {
    worldId: row.worldId,
    branchId: row.branchId,
    objectId: row.objectId,
    objectType: row.objectType,
    path: row.path ?? undefined,
    contentRef: (row.contentRef ?? undefined) as CasDigest | undefined,
    metadata: parseCanonicalJson(row.metadataJson),
    updatedRevision: BigInt(row.updatedRevision),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function artifactFromRow(row: WorldArtifactRow): WorldArtifact {
  return {
    worldId: row.worldId,
    branchId: row.branchId,
    artifactId: row.artifactId,
    mediaType: row.mediaType,
    contentRef: row.contentRef as CasDigest,
    metadata: parseCanonicalJson(row.metadataJson),
    updatedRevision: BigInt(row.updatedRevision),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function serviceFromRow(row: WorldServiceRow): WorldServiceState {
  return {
    worldId: row.worldId,
    branchId: row.branchId,
    serviceId: row.serviceId,
    status: row.status,
    definitionDigest: (row.definitionDigest ?? undefined) as CasDigest | undefined,
    metadata: parseCanonicalJson(row.metadataJson),
    updatedRevision: BigInt(row.updatedRevision),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function receiptFromRow(row: WorldCommitRow): WorldCommitReceipt {
  return {
    commitId: row.commitId,
    worldId: row.worldId,
    branchId: row.branchId,
    baseRevision: BigInt(row.baseRevision),
    newRevision: BigInt(row.newRevision),
    actor: row.actor,
    deltaDigest: row.deltaDigest as CasDigest,
    materializedStateDigest: row.materializedStateDigest as CasDigest,
    executionReceiptIds: Object.freeze(parseCanonicalJson<string[]>(row.executionReceiptIdsJson)),
    effectReceiptIds: Object.freeze(parseCanonicalJson<string[]>(row.effectReceiptIdsJson)),
    committedAt: row.committedAt,
  }
}

function objectOwnerId(worldId: string, branchId: string, objectId: string): string {
  return encodeCasOwnerId([worldId, branchId, objectId])
}

function assertNoReservedMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  reservedKeys: readonly string[],
): void {
  for (const key of reservedKeys) {
    if (metadata && Object.hasOwn(metadata, key)) {
      throw new Error(`metadata key is reserved by WorldDB: ${key}`)
    }
  }
}

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
}

const WORLD_OBJECT_TYPE_SET = new Set<string>(WORLD_OBJECT_TYPES)

function assertWorldObjectType(value: unknown, name: string): void {
  if (typeof value !== "string" || !WORLD_OBJECT_TYPE_SET.has(value)) {
    throw new Error(`${name} must be a recognized WorldObjectType`)
  }
}

function assertPlainMetadata(value: unknown, name: string): void {
  if (value === undefined) return
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be a plain record`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${name} must be a plain record`)
  }
}

function validateWorldMutation(mutation: WorldMutation, index: number): void {
  const prefix = `World mutation ${index}`
  switch (mutation.type) {
    case "object.put":
      assertNonEmptyString(mutation.objectId, `${prefix} objectId`)
      assertWorldObjectType(mutation.objectType, `${prefix} objectType`)
      if (mutation.path !== undefined) {
        assertNonEmptyString(mutation.path, `${prefix} path`)
      }
      assertPlainMetadata(mutation.metadata, `${prefix} metadata`)
      return
    case "object.delete":
      assertNonEmptyString(mutation.objectId, `${prefix} objectId`)
      return
    case "artifact.put":
      assertNonEmptyString(mutation.artifactId, `${prefix} artifactId`)
      assertNonEmptyString(mutation.mediaType, `${prefix} mediaType`)
      assertPlainMetadata(mutation.metadata, `${prefix} metadata`)
      return
    case "artifact.delete":
      assertNonEmptyString(mutation.artifactId, `${prefix} artifactId`)
      return
    case "service.set":
      assertNonEmptyString(mutation.serviceId, `${prefix} serviceId`)
      assertNonEmptyString(mutation.status, `${prefix} status`)
      assertPlainMetadata(mutation.metadata, `${prefix} metadata`)
      return
    case "service.delete":
      assertNonEmptyString(mutation.serviceId, `${prefix} serviceId`)
      return
    default:
      throw new Error(`${prefix} has an unsupported type`)
  }
}

const WORLD_DELTA_MEDIA_TYPE = "application/vnd.orcana.world-delta+json"

function enableWalWithBusyRetry(db: Database, timeoutMs = 5_000): void {
  const deadline = Date.now() + timeoutMs
  const waiter = new Int32Array(new SharedArrayBuffer(4))
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode = WAL")
      return
    } catch (error) {
      const busy = error instanceof Error && "code" in error && error.code === "SQLITE_BUSY"
      if (!busy || Date.now() >= deadline) throw error
      Atomics.wait(waiter, 0, 0, 10)
    }
  }
}

function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

function fdPath(fd: number, entry?: string): string {
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
    throw new Error(`World root is not a directory: ${path}`)
  }
  return fd
}

function openOrCreateDurableWorldRoot(configuredRoot: string): number {
  const missing: string[] = []
  let existing = configuredRoot
  for (;;) {
    try {
      const stat = lstatSync(existing)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`World root must be a real directory: ${existing}`)
      }
      break
    } catch (error) {
      if (!isFsError(error, "ENOENT")) throw error
      const name = basename(existing)
      const parent = dirname(existing)
      if (!name || name === "." || name === ".." || parent === existing) {
        throw new Error(`invalid World root: ${configuredRoot}`)
      }
      missing.push(name)
      existing = parent
    }
  }

  let currentFd = openDirectoryNoFollow(existing)
  try {
    for (const name of missing.reverse()) {
      try {
        mkdirSync(fdPath(currentFd, name), { mode: 0o700 })
      } catch (error) {
        if (!isFsError(error, "EEXIST")) throw error
      }
      const nextFd = openDirectoryNoFollow(fdPath(currentFd, name))
      try {
        fsyncSync(nextFd)
        fsyncSync(currentFd)
      } catch (error) {
        closeSync(nextFd)
        throw error
      }
      closeSync(currentFd)
      currentFd = nextFd
    }
    return currentFd
  } catch (error) {
    closeSync(currentFd)
    throw error
  }
}

function ensureDurableRootDirectory(rootFd: number, name: string): void {
  const path = fdPath(rootFd, name)
  let created = false
  try {
    mkdirSync(path, { mode: 0o700 })
    created = true
  } catch (error) {
    if (!isFsError(error, "EEXIST")) throw error
  }
  const directoryFd = openDirectoryNoFollow(path)
  try {
    if (created) {
      fsyncSync(directoryFd)
      fsyncSync(rootFd)
    }
  } finally {
    closeSync(directoryFd)
  }
}

function initializeWorldDatabase(db: Database, installedAt: number): void {
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA busy_timeout = 5000")
  enableWalWithBusyRetry(db)
  db.exec("PRAGMA synchronous = FULL")
  withImmediateTransaction(db, () => {
    initializeOrValidateWorldSchema(db, installedAt)
  })
}

function createInitialWorldDatabaseImage(installedAt: number): Buffer {
  const database = new Database(":memory:")
  try {
    database.exec("PRAGMA foreign_keys = ON")
    withImmediateTransaction(database, () => {
      initializeOrValidateWorldSchema(database, installedAt)
    })
    const image = Buffer.from(database.serialize())
    // SQLite persists WAL mode in header bytes 18 and 19. Preparing the image
    // before the authority directory becomes non-writable avoids a later
    // journal deletion/recreation through an unchecked pathname.
    image[18] = 2
    image[19] = 2
    return image
  } finally {
    database.close()
  }
}

function replaceFileContents(fd: number, content: Uint8Array): void {
  ftruncateSync(fd, 0)
  let offset = 0
  while (offset < content.byteLength) {
    const written = writeSync(fd, content, offset, content.byteLength - offset, offset)
    if (written <= 0) throw new Error("WorldDB bootstrap write made no progress")
    offset += written
  }
  fsyncSync(fd)
}

interface WorldDatabaseBootstrapRecord {
  readonly schemaVersion: 1
  readonly phase: "writing" | "complete"
  readonly installedAt: number
  readonly imageDigest: CasDigest
  readonly schemaVersionTarget: number
  readonly schemaFingerprint: CasDigest
}

function parseBootstrapRecord(line: string): WorldDatabaseBootstrapRecord {
  let value: Record<string, unknown>
  try {
    value = parseCanonicalJson<Record<string, unknown>>(line)
  } catch {
    throw new Error("WORLD_DB_BOOTSTRAP_STATE_INVALID")
  }
  if (canonicalJson(value) !== line) throw new Error("WORLD_DB_BOOTSTRAP_STATE_INVALID")
  const expectedKeys = [
    "imageDigest",
    "installedAt",
    "phase",
    "schemaFingerprint",
    "schemaVersion",
    "schemaVersionTarget",
  ]
  const keys = Object.keys(value).sort(compareCanonicalStrings)
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("WORLD_DB_BOOTSTRAP_STATE_INVALID")
  }
  if (
    value.schemaVersion !== 1 ||
    (value.phase !== "writing" && value.phase !== "complete") ||
    !Number.isSafeInteger(value.installedAt) ||
    (value.installedAt as number) < 0 ||
    value.schemaVersionTarget !== WORLD_SCHEMA_VERSION ||
    value.schemaFingerprint !== WORLD_SCHEMA_FINGERPRINT ||
    typeof value.imageDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.imageDigest)
  ) {
    throw new Error("WORLD_DB_BOOTSTRAP_STATE_INVALID")
  }
  return value as unknown as WorldDatabaseBootstrapRecord
}

function readBootstrapState(
  stateFd: number,
  databaseFd: number,
): readonly WorldDatabaseBootstrapRecord[] {
  let content = readFileSync(stateFd)
  const lastNewline = content.lastIndexOf(0x0a)
  if (lastNewline !== content.byteLength - 1) {
    if (lastNewline < 0 && fstatSync(databaseFd).size > 0) {
      throw new Error("WORLD_DB_BOOTSTRAP_STATE_INVALID")
    }
    const durableLength = lastNewline < 0 ? 0 : lastNewline + 1
    ftruncateSync(stateFd, durableLength)
    fsyncSync(stateFd)
    content = content.subarray(0, durableLength)
  }
  const records = content
    .toString("utf8")
    .split("\n")
    .filter(line => line.length > 0)
    .map(parseBootstrapRecord)
  if (
    records.length > 2 ||
    (records.length >= 1 && records[0]?.phase !== "writing") ||
    (records.length === 2 && records[1]?.phase !== "complete")
  ) {
    throw new Error("WORLD_DB_BOOTSTRAP_STATE_INVALID")
  }
  if (records.length === 2) {
    const [writing, complete] = records
    if (
      writing?.installedAt !== complete?.installedAt ||
      writing?.imageDigest !== complete?.imageDigest ||
      writing?.schemaVersionTarget !== complete?.schemaVersionTarget ||
      writing?.schemaFingerprint !== complete?.schemaFingerprint
    ) {
      throw new Error("WORLD_DB_BOOTSTRAP_STATE_INVALID")
    }
  }
  return records
}

function appendBootstrapState(
  stateFd: number,
  record: WorldDatabaseBootstrapRecord,
): void {
  const content = Buffer.from(`${canonicalJson(record)}\n`, "utf8")
  let offset = fstatSync(stateFd).size
  let consumed = 0
  while (consumed < content.byteLength) {
    const written = writeSync(
      stateFd,
      content,
      consumed,
      content.byteLength - consumed,
      offset + consumed,
    )
    if (written <= 0) throw new Error("WorldDB bootstrap state write made no progress")
    consumed += written
  }
  fsyncSync(stateFd)
}

function databaseMatchesInitialPrefix(databaseFd: number, image: Buffer): boolean {
  const content = readFileSync(databaseFd)
  return content.byteLength <= image.byteLength &&
    image.subarray(0, content.byteLength).equals(content)
}

function ensureWorldDatabaseBootstrapped(
  lockFd: number,
  stateFd: number,
  sqliteEntries: readonly VerifiedSqliteEntry[],
  installedAt: number,
  faultInjector?: (point: WorldFaultPoint) => void,
): void {
  withExclusiveFileLock(lockFd, () => {
    const databaseFd = sqliteEntries.find(entry => entry.name === "world.db")!.fd
    const records = readBootstrapState(stateFd, databaseFd)
    const complete = records[1]
    if (complete) {
      if (fstatSync(databaseFd).size === 0) {
        throw new Error("WORLD_DB_BOOTSTRAP_COMPLETE_WITH_EMPTY_DATABASE")
      }
      return
    }

    for (const entry of sqliteEntries) {
      if (entry.name !== "world.db" && fstatSync(entry.fd).size !== 0) {
        throw new Error(`WORLD_DB_BOOTSTRAP_UNPROVEN_SIDECAR: ${entry.name}`)
      }
    }

    const writing = records[0]
    if (!writing && fstatSync(databaseFd).size > 0) {
      throw new Error("WORLD_DB_BOOTSTRAP_STATE_MISSING")
    }
    const effectiveInstalledAt = writing?.installedAt ?? installedAt
    const image = createInitialWorldDatabaseImage(effectiveInstalledAt)
    const imageDigest = sha256Digest(image)
    if (
      (writing && writing.imageDigest !== imageDigest) ||
      !databaseMatchesInitialPrefix(databaseFd, image)
    ) {
      throw new Error("WORLD_DB_BOOTSTRAP_STATE_DIVERGENCE")
    }

    const baseRecord = {
      schemaVersion: 1 as const,
      installedAt: effectiveInstalledAt,
      imageDigest,
      schemaVersionTarget: WORLD_SCHEMA_VERSION,
      schemaFingerprint: WORLD_SCHEMA_FINGERPRINT,
    }
    if (!writing) {
      appendBootstrapState(stateFd, { ...baseRecord, phase: "writing" })
      faultInjector?.("after_world_db_bootstrap_intent_fsync")
    }
    try {
      replaceFileContents(databaseFd, image)
    } catch (error) {
      ftruncateSync(databaseFd, 0)
      fsyncSync(databaseFd)
      throw error
    }
    faultInjector?.("after_world_db_bootstrap_image_fsync")
    appendBootstrapState(stateFd, { ...baseRecord, phase: "complete" })
  })
}

interface VerifiedSqliteEntry {
  readonly name: string
  readonly fd: number
  readonly dev: number
  readonly ino: number
}

function openVerifiedBootstrapEntry(directoryFd: number, name: string): number {
  const path = fdPath(directoryFd, name)
  let fd: number
  for (;;) {
    try {
      fd = openSync(
        path,
        constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      break
    } catch (error) {
      if (!isFsError(error, "ENOENT")) throw error
      try {
        fd = openSync(
          path,
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
          0o600,
        )
        break
      } catch (createError) {
        if (isFsError(createError, "EEXIST")) continue
        throw createError
      }
    }
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`WorldDB bootstrap entry must be a single-link regular file: ${name}`)
    }
    fsyncSync(fd)
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

const SQLITE_ENTRIES = [
  "world.db",
  "world.db-wal",
  "world.db-shm",
  "world.db-journal",
] as const

function openVerifiedSqliteEntry(rootFd: number, name: string): VerifiedSqliteEntry {
  const path = fdPath(rootFd, name)
  const fd = openSync(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  )
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`WorldDB entry must be a single-link regular file: ${name}`)
    }
    fsyncSync(fd)
    return { name, fd, dev: stat.dev, ino: stat.ino }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

function assertSqliteEntryIdentity(rootFd: number, entry: VerifiedSqliteEntry): void {
  const path = fdPath(rootFd, entry.name)
  const stat = lstatSync(path)
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.dev !== entry.dev ||
    stat.ino !== entry.ino
  ) {
    throw new Error(`WORLD_DB_IDENTITY_CHANGED: ${entry.name}`)
  }
}

export class WorldStore {
  readonly configuredRoot: string
  readonly root: string
  readonly databasePath: string
  readonly ledger: WorldLedger
  readonly cas: WorldCas
  readonly snapshots: WorldSnapshotManager
  private readonly db: Database
  private readonly rootFd: number
  private readonly now: () => number
  private readonly idFactory: (kind: "world" | "event" | "commit") => string
  private readonly faultInjector?: (point: WorldFaultPoint) => void
  private closed = false

  constructor(root: string, options: Omit<WorldStoreOptions, "root"> = {}) {
    this.now = options.now ?? (() => Date.now())
    this.idFactory = options.idFactory ?? (kind => `${kind}-${randomUUID()}`)
    this.faultInjector = options.faultInjector
    const configuredRoot = resolve(root)
    this.rootFd = openOrCreateDurableWorldRoot(configuredRoot)
    this.configuredRoot = configuredRoot
    this.root = fdPath(this.rootFd)
    let bootstrapLockFd: number | undefined
    let bootstrapStateFd: number | undefined
    try {
      for (const directory of ["ledger", "snapshots", "projections", "recovery", "cas"]) {
        ensureDurableRootDirectory(this.rootFd, directory)
      }
      const recoveryFd = openDirectoryNoFollow(fdPath(this.rootFd, "recovery"))
      try {
        ensureDurableRootDirectory(recoveryFd, "cas-staging")
        bootstrapLockFd = openVerifiedBootstrapEntry(recoveryFd, "worlddb-bootstrap.lock")
        bootstrapStateFd = openVerifiedBootstrapEntry(recoveryFd, "worlddb-bootstrap.state")
        fsyncSync(recoveryFd)
        fchmodSync(recoveryFd, 0o500)
        fsyncSync(recoveryFd)
      } finally {
        closeSync(recoveryFd)
      }
    } catch (error) {
      if (bootstrapLockFd !== undefined) closeSync(bootstrapLockFd)
      if (bootstrapStateFd !== undefined) closeSync(bootstrapStateFd)
      closeSync(this.rootFd)
      throw error
    }
    const databaseFdPath = fdPath(this.rootFd, "world.db")
    this.databasePath = databaseFdPath
    const sqliteEntries: VerifiedSqliteEntry[] = []
    let database: Database | undefined
    try {
      for (const name of SQLITE_ENTRIES) {
        sqliteEntries.push(openVerifiedSqliteEntry(this.rootFd, name))
      }
      fsyncSync(this.rootFd)
      fchmodSync(this.rootFd, 0o500)
      fsyncSync(this.rootFd)
      for (const entry of sqliteEntries) assertSqliteEntryIdentity(this.rootFd, entry)
      this.faultInjector?.("after_world_db_entries_locked")
      ensureWorldDatabaseBootstrapped(
        bootstrapLockFd!,
        bootstrapStateFd!,
        sqliteEntries,
        this.now(),
        this.faultInjector,
      )
      for (const entry of sqliteEntries) assertSqliteEntryIdentity(this.rootFd, entry)
      database = new Database(databaseFdPath)
      for (const entry of sqliteEntries) assertSqliteEntryIdentity(this.rootFd, entry)
    } catch (error) {
      database?.close()
      closeSync(this.rootFd)
      throw error
    } finally {
      for (const entry of sqliteEntries) closeSync(entry.fd)
      closeSync(bootstrapLockFd!)
      closeSync(bootstrapStateFd!)
    }
    if (!database) throw new Error(`failed to open WorldDB: ${this.databasePath}`)
    this.db = database
    try {
      initializeWorldDatabase(this.db, this.now())
    } catch (error) {
      this.db.close()
      closeSync(this.rootFd)
      throw error
    }
    this.ledger = new WorldLedger(this.db)
    let cas: WorldCas | undefined
    try {
      cas = new WorldCas(
        this.db,
        configuredRoot,
        this.now,
        this.faultInjector,
        this.rootFd,
      )
      const snapshots = new WorldSnapshotManager(
        this.db,
        cas,
        this.ledger,
        {
          getWorld: worldId => this.getWorld(worldId),
          getBranch: (worldId, branchId) => this.getBranch(worldId, branchId),
          listObjects: (worldId, branchId) => this.listObjects(worldId, branchId),
          listArtifacts: (worldId, branchId) => this.listArtifacts(worldId, branchId),
          listServices: (worldId, branchId) => this.listServices(worldId, branchId),
        },
        this.now,
        () => this.idFactory("event"),
        this.faultInjector,
      )
      this.cas = cas
      this.snapshots = snapshots
    } catch (error) {
      cas?.close()
      this.db.close()
      closeSync(this.rootFd)
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.cas.close()
    this.db.close()
    closeSync(this.rootFd)
  }

  createWorld(input: CreateWorldInput): AgentWorld {
    const worldId = input.worldId === undefined ? this.idFactory("world") : input.worldId
    const branchId = input.branchId === undefined ? "main" : input.branchId
    const rootObjectId = input.rootObjectId === undefined ? "root" : input.rootObjectId
    const owner = input.owner
    const purpose = input.purpose === undefined ? "initial world" : input.purpose
    assertNonEmptyString(worldId, "world")
    assertNonEmptyString(branchId, "branch")
    assertNonEmptyString(rootObjectId, "root object")
    assertNonEmptyString(owner, "owner")
    assertNonEmptyString(purpose, "purpose")
    const at = this.now()

    return withImmediateTransaction(this.db, () => {
      if (this.getWorld(worldId)) throw new Error(`world already exists: ${worldId}`)
      dbRun(
        this.db,
        `INSERT INTO world_meta (
           world_id, current_revision, current_branch_id, root_object_id, status, created_at, updated_at
         ) VALUES (?, '0', ?, ?, 'active', ?, ?)`,
        worldId,
        branchId,
        rootObjectId,
        at,
        at,
      )
      dbRun(
        this.db,
        `INSERT INTO world_branches (
           world_id, branch_id, parent_branch_id, base_revision, owner, purpose, status, created_at
         ) VALUES (?, ?, NULL, '0', ?, ?, 'active', ?)`,
        worldId,
        branchId,
        owner,
        purpose,
        at,
      )
      dbRun(
        this.db,
        "INSERT INTO world_heads (world_id, branch_id, revision, updated_at) VALUES (?, ?, '0', ?)",
        worldId,
        branchId,
        at,
      )
      const materializedStateDigest = this.materializedStateDigest(worldId, branchId)
      this.ledger.appendWithinTransaction({
        eventId: this.idFactory("event"),
        worldId,
        branchId,
        revision: 0n,
        eventType: "world.created",
        actor: owner,
        payload: {
          rootObjectId,
          purpose,
          materializedStateDigest,
        },
        occurredAt: at,
      })
      return this.getWorld(worldId)!
    })
  }

  getWorld(worldId: string): AgentWorld | undefined {
    const row = dbGet<WorldMetaRow>(
      this.db,
      `SELECT world_id AS worldId, current_revision AS currentRevision,
              current_branch_id AS currentBranchId, root_object_id AS rootObjectId,
              status, created_at AS createdAt, updated_at AS updatedAt
       FROM world_meta WHERE world_id = ?`,
      worldId,
    )
    return row ? worldFromRow(row) : undefined
  }

  listWorlds(): AgentWorld[] {
    return dbAll<WorldMetaRow>(
      this.db,
      `SELECT world_id AS worldId, current_revision AS currentRevision,
              current_branch_id AS currentBranchId, root_object_id AS rootObjectId,
              status, created_at AS createdAt, updated_at AS updatedAt
       FROM world_meta ORDER BY world_id`,
    ).map(worldFromRow)
  }

  getBranch(worldId: string, branchId: string): WorldBranch | undefined {
    const row = dbGet<WorldBranchRow>(
      this.db,
      `SELECT b.world_id AS worldId, b.branch_id AS branchId,
              b.parent_branch_id AS parentBranchId, b.base_revision AS baseRevision,
              h.revision AS headRevision, b.owner, b.purpose, b.status,
              b.created_at AS createdAt
       FROM world_branches b
       JOIN world_heads h ON h.world_id = b.world_id AND h.branch_id = b.branch_id
       WHERE b.world_id = ? AND b.branch_id = ?`,
      worldId,
      branchId,
    )
    return row ? branchFromRow(row) : undefined
  }

  getCommit(commitId: string): WorldCommitReceipt | undefined {
    const row = this.getCommitRow(commitId)
    return row ? receiptFromRow(row) : undefined
  }

  listObjects(worldId: string, branchId: string): WorldObject[] {
    return dbAll<WorldObjectRow>(
      this.db,
      `SELECT world_id AS worldId, branch_id AS branchId, object_id AS objectId,
              object_type AS objectType, path, content_ref AS contentRef,
              metadata_json AS metadataJson, updated_revision AS updatedRevision,
              created_at AS createdAt, updated_at AS updatedAt
       FROM world_objects WHERE world_id = ? AND branch_id = ?
       ORDER BY COALESCE(path, ''), object_id`,
      worldId,
      branchId,
    ).map(objectFromRow)
  }

  listArtifacts(worldId: string, branchId: string): WorldArtifact[] {
    return dbAll<WorldArtifactRow>(
      this.db,
      `SELECT world_id AS worldId, branch_id AS branchId, artifact_id AS artifactId,
              media_type AS mediaType, content_ref AS contentRef,
              metadata_json AS metadataJson, updated_revision AS updatedRevision,
              created_at AS createdAt, updated_at AS updatedAt
       FROM world_artifacts WHERE world_id = ? AND branch_id = ? ORDER BY artifact_id`,
      worldId,
      branchId,
    ).map(artifactFromRow)
  }

  listServices(worldId: string, branchId: string): WorldServiceState[] {
    return dbAll<WorldServiceRow>(
      this.db,
      `SELECT world_id AS worldId, branch_id AS branchId, service_id AS serviceId,
              status, definition_digest AS definitionDigest, metadata_json AS metadataJson,
              updated_revision AS updatedRevision, created_at AS createdAt, updated_at AS updatedAt
       FROM world_services WHERE world_id = ? AND branch_id = ? ORDER BY service_id`,
      worldId,
      branchId,
    ).map(serviceFromRow)
  }

  createSnapshot(worldId: string, branchId: string): WorldSnapshot {
    return this.snapshots.create(worldId, branchId)
  }

  private materializedStateImage(worldId: string, branchId: string): MaterializedStateImage {
    const world = this.getWorld(worldId)
    const branch = this.getBranch(worldId, branchId)
    if (!world || !branch) throw new Error(`unknown world branch: ${worldId}/${branchId}`)
    return {
      world: {
        worldId: world.worldId,
        currentRevision: world.currentRevision.toString(),
        currentBranchId: world.currentBranchId,
        rootObjectId: world.rootObjectId,
        status: world.status,
        createdAt: world.createdAt,
        updatedAt: world.updatedAt,
      },
      branch: {
        branchId: branch.branchId,
        parentBranchId: branch.parentBranchId ?? null,
        baseRevision: branch.baseRevision.toString(),
        headRevision: branch.headRevision.toString(),
        owner: branch.owner,
        purpose: branch.purpose,
        status: branch.status,
        createdAt: branch.createdAt,
      },
      objects: this.listObjects(worldId, branchId)
        .map(object => ({
          objectId: object.objectId,
          objectType: object.objectType,
          path: object.path ?? null,
          contentRef: object.contentRef ?? null,
          metadata: object.metadata,
          updatedRevision: object.updatedRevision.toString(),
          createdAt: object.createdAt,
          updatedAt: object.updatedAt,
        }))
        .sort((left, right) => compareCanonicalStrings(left.objectId, right.objectId)),
      artifacts: this.listArtifacts(worldId, branchId)
        .map(artifact => ({
          artifactId: artifact.artifactId,
          mediaType: artifact.mediaType,
          contentRef: artifact.contentRef,
          metadata: artifact.metadata,
          updatedRevision: artifact.updatedRevision.toString(),
          createdAt: artifact.createdAt,
          updatedAt: artifact.updatedAt,
        }))
        .sort((left, right) => compareCanonicalStrings(left.artifactId, right.artifactId)),
      services: this.listServices(worldId, branchId)
        .map(service => ({
          serviceId: service.serviceId,
          status: service.status,
          definitionDigest: service.definitionDigest ?? null,
          metadata: service.metadata,
          updatedRevision: service.updatedRevision.toString(),
          createdAt: service.createdAt,
          updatedAt: service.updatedAt,
        }))
        .sort((left, right) => compareCanonicalStrings(left.serviceId, right.serviceId)),
    }
  }

  private materializedStateDigest(worldId: string, branchId: string): CasDigest {
    return canonicalDigest(this.materializedStateImage(worldId, branchId))
  }

  private replayMaterializedEvent(
    state: MaterializedStateImage,
    event: WorldEvent,
    revision: bigint,
  ): void {
    const mutation = event.payload as WorldMutation | { type: "world.corrupted"; detail: string }
    const updatedRevision = revision.toString()
    switch (mutation.type) {
      case "object.put": {
        const existing = state.objects.find(item => item.objectId === mutation.objectId)
        const next: MaterializedStateImage["objects"][number] = {
          objectId: mutation.objectId,
          objectType: mutation.objectType,
          path: mutation.path ?? null,
          contentRef: mutation.contentRef ?? null,
          metadata: mutation.metadata ?? {},
          updatedRevision,
          createdAt: existing?.createdAt ?? event.occurredAt,
          updatedAt: event.occurredAt,
        }
        state.objects = [
          ...state.objects.filter(item => item.objectId !== mutation.objectId),
          next,
        ].sort((left, right) => compareCanonicalStrings(left.objectId, right.objectId))
        break
      }
      case "object.delete":
        state.objects = state.objects.filter(item => item.objectId !== mutation.objectId)
        break
      case "artifact.put": {
        const existing = state.artifacts.find(item => item.artifactId === mutation.artifactId)
        const next: MaterializedStateImage["artifacts"][number] = {
          artifactId: mutation.artifactId,
          mediaType: mutation.mediaType,
          contentRef: mutation.contentRef,
          metadata: mutation.metadata ?? {},
          updatedRevision,
          createdAt: existing?.createdAt ?? event.occurredAt,
          updatedAt: event.occurredAt,
        }
        state.artifacts = [
          ...state.artifacts.filter(item => item.artifactId !== mutation.artifactId),
          next,
        ].sort((left, right) => compareCanonicalStrings(left.artifactId, right.artifactId))
        break
      }
      case "artifact.delete":
        state.artifacts = state.artifacts.filter(item => item.artifactId !== mutation.artifactId)
        break
      case "service.set": {
        const existing = state.services.find(item => item.serviceId === mutation.serviceId)
        const next: MaterializedStateImage["services"][number] = {
          serviceId: mutation.serviceId,
          status: mutation.status,
          definitionDigest: mutation.definitionDigest ?? null,
          metadata: mutation.metadata ?? {},
          updatedRevision,
          createdAt: existing?.createdAt ?? event.occurredAt,
          updatedAt: event.occurredAt,
        }
        state.services = [
          ...state.services.filter(item => item.serviceId !== mutation.serviceId),
          next,
        ].sort((left, right) => compareCanonicalStrings(left.serviceId, right.serviceId))
        break
      }
      case "service.delete":
        state.services = state.services.filter(item => item.serviceId !== mutation.serviceId)
        break
      case "world.corrupted":
        state.world.status = "corrupted"
        break
    }
  }

  compareAndCommit(input: WorldCommitRequest): WorldCommitReceipt {
    const mutations = parseCanonicalJson<WorldMutation[]>(canonicalJson(input.mutations))
    if (mutations.length === 0) throw new Error("World commit requires at least one mutation")
    mutations.forEach(validateWorldMutation)
    const commitId = input.commitId ?? this.idFactory("commit")
    const executionReceiptIds = parseCanonicalJson<string[]>(
      canonicalJson(input.executionReceiptIds ?? []),
    )
    const effectReceiptIds = parseCanonicalJson<string[]>(
      canonicalJson(input.effectReceiptIds ?? []),
    )
    assertNonEmptyString(input.worldId, "World commit worldId")
    assertNonEmptyString(input.branchId, "World commit branchId")
    assertNonEmptyString(input.actor, "World commit actor")
    assertNonEmptyString(commitId, "World commit commitId")
    executionReceiptIds.forEach((receiptId, index) =>
      assertNonEmptyString(receiptId, `World commit executionReceiptIds[${index}]`))
    effectReceiptIds.forEach((receiptId, index) =>
      assertNonEmptyString(receiptId, `World commit effectReceiptIds[${index}]`))
    const request = Object.freeze({
      worldId: input.worldId,
      branchId: input.branchId,
      baseRevision: input.baseRevision,
      actor: input.actor,
      mutations,
      executionReceiptIds,
      effectReceiptIds,
      commitId,
    })
    const deltaBytes = Buffer.from(canonicalJson(worldDeltaManifest(
      request.worldId,
      request.branchId,
      request.baseRevision,
      mutations,
    )), "utf8")
    const deltaDigest = sha256Digest(deltaBytes)
    const requestDigest = canonicalDigest({
      worldId: request.worldId,
      branchId: request.branchId,
      mutations,
      baseRevision: request.baseRevision.toString(),
      actor: request.actor,
      commitId,
      executionReceiptIds,
      effectReceiptIds,
    })
    let receipt: WorldCommitReceipt

    receipt = withImmediateTransaction(this.db, () => {
      const existing = this.getCommitRow(commitId)
      if (existing) {
        if (existing.requestDigest !== requestDigest) {
          throw new Error(`commit idempotency conflict: ${commitId}`)
        }
        if (existing.deltaDigest !== deltaDigest) {
          throw new Error(`commit delta divergence: ${commitId}`)
        }
        const deltaRecord = this.cas.put(deltaBytes, WORLD_DELTA_MEDIA_TYPE)
        if (deltaRecord.digest !== deltaDigest) {
          throw new Error(`World delta CAS digest mismatch: ${commitId}`)
        }
        this.cas.link("world_commit", commitId, deltaDigest)
        return receiptFromRow(existing)
      }

      const world = this.getWorld(request.worldId)
      const branch = this.getBranch(request.worldId, request.branchId)
      if (!world || !branch) throw new Error(`unknown world branch: ${request.worldId}/${request.branchId}`)
      if (world.status === "corrupted") throw new WorldCorruptionError([])
      if (world.status !== "active") throw new Error(`world is not active: ${world.status}`)
      if (branch.status !== "active") throw new Error(`branch is not active: ${request.branchId}`)
      if (world.currentBranchId !== request.branchId) {
        throw new Error(`AK-1 only commits the current branch: ${request.branchId}`)
      }
      if (
        world.currentRevision !== request.baseRevision ||
        branch.headRevision !== request.baseRevision
      ) {
        throw new WorldConflictError(
          request.worldId,
          request.branchId,
          request.baseRevision,
          branch.headRevision,
        )
      }

      const deltaRecord = this.cas.put(deltaBytes, WORLD_DELTA_MEDIA_TYPE)
      if (deltaRecord.digest !== deltaDigest) {
        throw new Error(`World delta CAS digest mismatch: ${commitId}`)
      }

      const newRevision = request.baseRevision + 1n
      const committedAt = this.now()
      for (const mutation of mutations) {
        const eventType = this.applyMutation(
          request.worldId,
          request.branchId,
          newRevision,
          committedAt,
          mutation,
        )
        this.faultInjector?.("after_materialization_before_ledger")
        this.ledger.appendWithinTransaction({
          eventId: this.idFactory("event"),
          worldId: request.worldId,
          branchId: request.branchId,
          revision: newRevision,
          commitId,
          eventType,
          actor: request.actor,
          objectId: "objectId" in mutation
            ? mutation.objectId
            : "artifactId" in mutation
              ? mutation.artifactId
              : mutation.serviceId,
          payload: mutation,
          occurredAt: committedAt,
        })
      }

      const metaUpdated = dbRun(
        this.db,
        `UPDATE world_meta SET current_revision = ?, updated_at = ?
         WHERE world_id = ? AND current_revision = ? AND current_branch_id = ?`,
        newRevision.toString(),
        committedAt,
        request.worldId,
        request.baseRevision.toString(),
        request.branchId,
      )
      const headUpdated = dbRun(
        this.db,
        `UPDATE world_heads SET revision = ?, updated_at = ?
         WHERE world_id = ? AND branch_id = ? AND revision = ?`,
        newRevision.toString(),
        committedAt,
        request.worldId,
        request.branchId,
        request.baseRevision.toString(),
      )
      if (metaUpdated.changes !== 1 || headUpdated.changes !== 1) {
        throw new WorldConflictError(
          request.worldId,
          request.branchId,
          request.baseRevision,
          branch.headRevision,
        )
      }

      const materializedStateDigest = this.materializedStateDigest(
        request.worldId,
        request.branchId,
      )

      dbRun(
        this.db,
        `INSERT INTO world_commits (
           commit_id, request_digest, world_id, branch_id, base_revision, new_revision,
           actor, delta_digest, materialized_state_digest,
           execution_receipt_ids_json, effect_receipt_ids_json, committed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        commitId,
        requestDigest,
        request.worldId,
        request.branchId,
        request.baseRevision.toString(),
        newRevision.toString(),
        request.actor,
        deltaDigest,
        materializedStateDigest,
        canonicalJson(executionReceiptIds),
        canonicalJson(effectReceiptIds),
        committedAt,
      )
      this.cas.link("world_commit", commitId, deltaDigest)
      this.ledger.appendWithinTransaction({
        eventId: this.idFactory("event"),
        worldId: request.worldId,
        branchId: request.branchId,
        revision: newRevision,
        commitId,
        eventType: "world.commit",
        actor: request.actor,
        payload: {
          baseRevision: request.baseRevision.toString(),
          newRevision: newRevision.toString(),
          deltaDigest,
          mutationCount: mutations.length,
        },
        occurredAt: committedAt,
      })
      this.faultInjector?.("after_ledger_before_commit")

      return {
        commitId,
        worldId: request.worldId,
        branchId: request.branchId,
        baseRevision: request.baseRevision,
        newRevision,
        actor: request.actor,
        deltaDigest,
        materializedStateDigest,
        executionReceiptIds: Object.freeze(executionReceiptIds),
        effectReceiptIds: Object.freeze(effectReceiptIds),
        committedAt,
      }
    })

    this.faultInjector?.("after_commit_before_response")
    return Object.freeze(receipt)
  }

  verifyIntegrity(): WorldIntegrityIssue[] {
    const issues: WorldIntegrityIssue[] = [...this.cas.verifyIntegrity()]
    for (const world of this.listWorlds()) {
      let events: WorldEvent[]
      try {
        events = this.ledger.list(world.worldId)
      } catch (error) {
        issues.push({
          code: "LEDGER_DB_DIVERGENCE",
          worldId: world.worldId,
          detail: `ledger decode failed: ${error instanceof Error ? error.message : String(error)}`,
        })
        continue
      }
      for (const event of events) {
        if (canonicalDigest(event.payload) !== event.payloadDigest) {
          issues.push({
            code: "LEDGER_DB_DIVERGENCE",
            worldId: world.worldId,
            detail: `event ${event.eventId} payload digest mismatch`,
          })
        }
      }
      const branch = this.getBranch(world.worldId, world.currentBranchId)
      if (!branch || branch.headRevision !== world.currentRevision) {
        issues.push({
          code: "WORLD_REVISION_SPLIT_BRAIN",
          worldId: world.worldId,
          detail: `meta=${world.currentRevision} head=${branch?.headRevision ?? "missing"}`,
        })
        continue
      }
      const commits = dbAll<WorldCommitRow>(
        this.db,
        `SELECT commit_id AS commitId, request_digest AS requestDigest,
                world_id AS worldId, branch_id AS branchId,
                base_revision AS baseRevision, new_revision AS newRevision,
                actor, delta_digest AS deltaDigest,
                materialized_state_digest AS materializedStateDigest,
                execution_receipt_ids_json AS executionReceiptIdsJson,
                effect_receipt_ids_json AS effectReceiptIdsJson,
                committed_at AS committedAt
         FROM world_commits WHERE world_id = ? AND branch_id = ?`,
        world.worldId,
        world.currentBranchId,
      ).sort((left, right) => {
        const leftRevision = BigInt(left.newRevision)
        const rightRevision = BigInt(right.newRevision)
        return leftRevision < rightRevision ? -1 : leftRevision > rightRevision ? 1 : 0
      })
      const commitIds = new Set(commits.map(commit => commit.commitId))
      const genesisEvents = events.filter(event =>
        event.commitId === undefined && event.eventType === "world.created",
      )
      if (
        genesisEvents.length !== 1 ||
        genesisEvents[0]?.revision !== 0n ||
        genesisEvents[0]?.branchId !== world.currentBranchId
      ) {
        issues.push({
          code: "LEDGER_DB_DIVERGENCE",
          worldId: world.worldId,
          detail: `expected one revision-zero world.created event, found ${genesisEvents.length}`,
        })
      }
      const genesis = genesisEvents.length === 1 ? genesisEvents[0] : undefined
      const genesisPayload = genesis?.payload as {
        rootObjectId?: unknown
        purpose?: unknown
        materializedStateDigest?: unknown
      } | undefined
      let replayState: MaterializedStateImage | undefined
      const genesisPayloadKeys =
        typeof genesisPayload === "object" &&
        genesisPayload !== null &&
        !Array.isArray(genesisPayload)
          ? Object.keys(genesisPayload).sort(compareCanonicalStrings)
          : []
      const validGenesisPayload =
        genesisPayloadKeys.length === 3 &&
        genesisPayloadKeys[0] === "materializedStateDigest" &&
        genesisPayloadKeys[1] === "purpose" &&
        genesisPayloadKeys[2] === "rootObjectId" &&
        typeof genesisPayload?.rootObjectId === "string" &&
        genesisPayload.rootObjectId.length > 0 &&
        typeof genesisPayload.purpose === "string" &&
        genesisPayload.purpose.length > 0 &&
        typeof genesisPayload.materializedStateDigest === "string" &&
        /^sha256:[a-f0-9]{64}$/.test(genesisPayload.materializedStateDigest) &&
        typeof genesis?.actor === "string" &&
        genesis.actor.length > 0
      if (genesis && !validGenesisPayload) {
        issues.push({
          code: "LEDGER_DB_DIVERGENCE",
          worldId: world.worldId,
          detail: "world.created payload is malformed",
        })
      }
      if (
        genesis &&
        validGenesisPayload
      ) {
        const validPayload = genesisPayload as {
          rootObjectId: string
          purpose: string
          materializedStateDigest: string
        }
        replayState = {
          world: {
            worldId: world.worldId,
            currentRevision: "0",
            currentBranchId: world.currentBranchId,
            rootObjectId: validPayload.rootObjectId,
            status: "active",
            createdAt: genesis.occurredAt,
            updatedAt: genesis.occurredAt,
          },
          branch: {
            branchId: world.currentBranchId,
            parentBranchId: null,
            baseRevision: "0",
            headRevision: "0",
            owner: genesis.actor,
            purpose: validPayload.purpose,
            status: "active",
            createdAt: genesis.occurredAt,
          },
          objects: [],
          artifacts: [],
          services: [],
        }
        if (canonicalDigest(replayState) !== validPayload.materializedStateDigest) {
          issues.push({
            code: "LEDGER_DB_DIVERGENCE",
            worldId: world.worldId,
            detail: "revision-zero materialized digest does not match world.created",
          })
        }
      }
      const snapshotEvents = events.filter(event =>
        event.commitId === undefined && event.eventType === "world.snapshot.created",
      )
      const snapshots = this.snapshots.list(world.worldId, world.currentBranchId)
      for (const snapshot of snapshots) {
        const matching = snapshotEvents.filter(event => {
          const payload = event.payload as { snapshotId?: unknown; manifestDigest?: unknown }
          return event.objectId === snapshot.snapshotId &&
            event.revision === snapshot.revision &&
            payload.snapshotId === snapshot.snapshotId &&
            payload.manifestDigest === snapshot.manifestDigest
        })
        if (matching.length !== 1) {
          issues.push({
            code: "LEDGER_DB_DIVERGENCE",
            worldId: world.worldId,
            detail: `snapshot ${snapshot.snapshotId} has ${matching.length} matching ledger events`,
          })
        }
      }
      for (const event of snapshotEvents) {
        const payload = event.payload as { snapshotId?: unknown; manifestDigest?: unknown }
        const matching = snapshots.filter(snapshot =>
          event.objectId === snapshot.snapshotId &&
          event.revision === snapshot.revision &&
          payload.snapshotId === snapshot.snapshotId &&
          payload.manifestDigest === snapshot.manifestDigest,
        )
        if (matching.length !== 1) {
          issues.push({
            code: "LEDGER_DB_DIVERGENCE",
            worldId: world.worldId,
            detail: `snapshot event ${event.eventId} has no unique snapshot row`,
          })
        }
      }
      for (const event of events) {
        if (event.commitId && !commitIds.has(event.commitId)) {
          issues.push({
            code: "LEDGER_DB_DIVERGENCE",
            worldId: world.worldId,
            detail: `event ${event.eventId} references unknown commit ${event.commitId}`,
          })
        } else if (
          !event.commitId &&
          event.eventType !== "world.created" &&
          event.eventType !== "world.snapshot.created" &&
          !(
            event.eventType === "world.quarantined" &&
            event.actor === "system:recovery" &&
            world.status === "corrupted"
          )
        ) {
          issues.push({
            code: "LEDGER_DB_DIVERGENCE",
            worldId: world.worldId,
            detail: `event ${event.eventId} has no governed commit/snapshot semantics`,
          })
        }
      }
      let expectedRevision = 1n
      for (const commit of commits) {
        const baseRevision = BigInt(commit.baseRevision)
        const newRevision = BigInt(commit.newRevision)
        if (baseRevision !== expectedRevision - 1n || newRevision !== expectedRevision) {
          issues.push({
            code: "LEDGER_DB_DIVERGENCE",
            worldId: world.worldId,
            detail: `commit ${commit.commitId} breaks revision chain at ${expectedRevision}`,
          })
        }
        expectedRevision = newRevision + 1n

        const commitEvents = events.filter(event => event.commitId === commit.commitId)
        const invalidEvent = commitEvents.find(event =>
          event.worldId !== world.worldId ||
          event.branchId !== world.currentBranchId ||
          event.revision !== newRevision ||
          event.actor !== commit.actor ||
          event.occurredAt !== commit.committedAt ||
          canonicalDigest(event.payload) !== event.payloadDigest,
        )
        const finalEvents = commitEvents.filter(event => event.eventType === "world.commit")
        const mutationEvents = commitEvents.filter(event => event.eventType !== "world.commit")
        const payload = finalEvents[0]?.payload as {
          baseRevision?: string
          newRevision?: string
          deltaDigest?: CasDigest
          mutationCount?: number
        } | undefined
        const mutationCount = payload?.mutationCount
        const invalidMutationEvent = mutationEvents.find(event => {
          const mutation = event.payload as { type?: unknown }
          const expectedEventType = mutation.type === "object.put"
            ? "world.object.updated"
            : mutation.type === "object.delete"
              ? "world.object.deleted"
              : mutation.type === "artifact.put"
                ? "world.artifact.updated"
                : mutation.type === "artifact.delete"
                  ? "world.artifact.deleted"
                  : mutation.type === "service.set"
                    ? "world.service.updated"
                    : mutation.type === "service.delete"
                      ? "world.service.deleted"
                      : mutation.type === "world.corrupted"
                        ? "world.corrupted"
                        : undefined
          const expectedObjectId = "objectId" in mutation
            ? mutation.objectId
            : "artifactId" in mutation
              ? mutation.artifactId
              : "serviceId" in mutation
                ? mutation.serviceId
                : undefined
          return expectedEventType === undefined ||
            event.eventType !== expectedEventType ||
            event.objectId !== expectedObjectId
        })
        if (
          invalidEvent ||
          invalidMutationEvent ||
          finalEvents.length !== 1 ||
          !Number.isSafeInteger(mutationCount) ||
          (mutationCount ?? -1) < 0 ||
          commitEvents.length !== (mutationCount ?? -1) + 1 ||
          payload?.baseRevision !== commit.baseRevision ||
          payload?.newRevision !== commit.newRevision ||
          payload?.deltaDigest !== commit.deltaDigest ||
          sha256Digest(canonicalJson(worldDeltaManifest(
            commit.worldId,
            commit.branchId,
            BigInt(commit.baseRevision),
            mutationEvents.map(event => event.payload as WorldDeltaMutation),
          ))) !== commit.deltaDigest ||
          finalEvents[0]?.actor !== commit.actor ||
          finalEvents[0]?.occurredAt !== commit.committedAt
        ) {
          issues.push({
            code: "LEDGER_DB_DIVERGENCE",
            worldId: world.worldId,
            detail: `commit ${commit.commitId} ledger evidence does not match its receipt`,
          })
        }
        if (replayState && !invalidMutationEvent) {
          for (const event of mutationEvents) {
            this.replayMaterializedEvent(replayState, event, newRevision)
          }
          replayState.world.currentRevision = commit.newRevision
          replayState.world.updatedAt = commit.committedAt
          replayState.branch.headRevision = commit.newRevision
          const replayDigest = canonicalDigest(replayState)
          if (replayDigest !== commit.materializedStateDigest) {
            issues.push({
              code: "LEDGER_DB_DIVERGENCE",
              worldId: world.worldId,
              detail: `commit ${commit.commitId} materialized digest does not replay from ledger`,
            })
          }
        }
      }
      if (expectedRevision - 1n !== world.currentRevision) {
        issues.push({
          code: "LEDGER_DB_DIVERGENCE",
          worldId: world.worldId,
          detail: `commit chain ends at ${expectedRevision - 1n}, head is ${world.currentRevision}`,
        })
      }
      const expectedMaterializedDigest = world.currentRevision === 0n
        ? (genesisEvents[0]?.payload as { materializedStateDigest?: unknown } | undefined)
          ?.materializedStateDigest
        : commits.find(commit => BigInt(commit.newRevision) === world.currentRevision)
          ?.materializedStateDigest
      const actualMaterializedDigest = this.materializedStateDigest(
        world.worldId,
        world.currentBranchId,
      )
      if (expectedMaterializedDigest !== actualMaterializedDigest) {
        issues.push({
          code: "LEDGER_DB_DIVERGENCE",
          worldId: world.worldId,
          detail: `materialized state ${actualMaterializedDigest} does not match revision receipt ${String(expectedMaterializedDigest)}`,
        })
      }
      if (replayState && canonicalDigest(replayState) !== actualMaterializedDigest) {
        issues.push({
          code: "LEDGER_DB_DIVERGENCE",
          worldId: world.worldId,
          detail: "current materialized state does not match deterministic ledger replay",
        })
      }
    }
    return issues
  }

  markCorruptedFromRecovery(worldId: string, detail: string): void {
    withImmediateTransaction(this.db, () => {
      assertWorldSchemaCompatible(this.db)
      const world = this.getWorld(worldId)
      if (!world || world.status === "corrupted") return
      const branch = this.getBranch(worldId, world.currentBranchId)
      if (!branch || branch.headRevision !== world.currentRevision) return
      const baseRevision = world.currentRevision
      const newRevision = baseRevision + 1n
      const at = this.now()
      const commitId = this.idFactory("commit")
      const corruptionMutation = { type: "world.corrupted", detail } as const
      const deltaBytes = Buffer.from(canonicalJson(worldDeltaManifest(
        worldId,
        world.currentBranchId,
        baseRevision,
        [corruptionMutation],
      )), "utf8")
      const deltaDigest = sha256Digest(deltaBytes)
      const deltaRecord = this.cas.put(deltaBytes, WORLD_DELTA_MEDIA_TYPE)
      if (deltaRecord.digest !== deltaDigest) {
        throw new Error(`World delta CAS digest mismatch: ${commitId}`)
      }
      const requestDigest = canonicalDigest({ worldId, detail, baseRevision: baseRevision.toString() })
      dbRun(
        this.db,
        `UPDATE world_meta SET status = 'corrupted', current_revision = ?, updated_at = ?
         WHERE world_id = ? AND current_revision = ?`,
        newRevision.toString(),
        at,
        worldId,
        baseRevision.toString(),
      )
      dbRun(
        this.db,
        `UPDATE world_heads SET revision = ?, updated_at = ?
         WHERE world_id = ? AND branch_id = ? AND revision = ?`,
        newRevision.toString(),
        at,
        worldId,
        world.currentBranchId,
        baseRevision.toString(),
      )
      const materializedStateDigest = this.materializedStateDigest(
        worldId,
        world.currentBranchId,
      )
      dbRun(
        this.db,
        `INSERT INTO world_commits (
           commit_id, request_digest, world_id, branch_id, base_revision, new_revision,
           actor, delta_digest, materialized_state_digest,
           execution_receipt_ids_json, effect_receipt_ids_json, committed_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'system:recovery', ?, ?, '[]', '[]', ?)`,
        commitId,
        requestDigest,
        worldId,
        world.currentBranchId,
        baseRevision.toString(),
        newRevision.toString(),
        deltaDigest,
        materializedStateDigest,
        at,
      )
      this.cas.link("world_commit", commitId, deltaDigest)
      this.ledger.appendWithinTransaction({
        eventId: this.idFactory("event"),
        worldId,
        branchId: world.currentBranchId,
        revision: newRevision,
        commitId,
        eventType: "world.corrupted",
        actor: "system:recovery",
        payload: corruptionMutation,
        occurredAt: at,
      })
      this.ledger.appendWithinTransaction({
        eventId: this.idFactory("event"),
        worldId,
        branchId: world.currentBranchId,
        revision: newRevision,
        commitId,
        eventType: "world.commit",
        actor: "system:recovery",
        payload: {
          baseRevision: baseRevision.toString(),
          newRevision: newRevision.toString(),
          deltaDigest,
          mutationCount: 1,
        },
        occurredAt: at,
      })
    })
  }

  quarantineWorldFromRecovery(worldId: string, detail: string): void {
    withImmediateTransaction(this.db, () => {
      assertWorldSchemaCompatible(this.db)
      const world = this.getWorld(worldId)
      if (!world || world.status === "corrupted") return
      const at = this.now()
      dbRun(
        this.db,
        `UPDATE world_meta SET status = 'corrupted', updated_at = ?
         WHERE world_id = ? AND status != 'corrupted'`,
        at,
        worldId,
      )
      this.ledger.appendWithinTransaction({
        eventId: this.idFactory("event"),
        worldId,
        branchId: world.currentBranchId,
        revision: world.currentRevision,
        eventType: "world.quarantined",
        actor: "system:recovery",
        payload: { detail },
        occurredAt: at,
      })
    })
  }

  private getCommitRow(commitId: string): WorldCommitRow | undefined {
    return dbGet<WorldCommitRow>(
      this.db,
      `SELECT commit_id AS commitId, request_digest AS requestDigest,
              world_id AS worldId, branch_id AS branchId,
              base_revision AS baseRevision, new_revision AS newRevision,
              actor, delta_digest AS deltaDigest,
              materialized_state_digest AS materializedStateDigest,
              execution_receipt_ids_json AS executionReceiptIdsJson,
              effect_receipt_ids_json AS effectReceiptIdsJson,
              committed_at AS committedAt
       FROM world_commits WHERE commit_id = ?`,
      commitId,
    )
  }

  private applyMutation(
    worldId: string,
    branchId: string,
    revision: bigint,
    at: number,
    mutation: WorldMutation,
  ): string {
    switch (mutation.type) {
      case "object.put": {
        if (mutation.contentRef) this.cas.get(mutation.contentRef)
        const ownerId = objectOwnerId(worldId, branchId, mutation.objectId)
        const existing = dbGet<{ contentRef: string | null; createdAt: number }>(
          this.db,
          `SELECT content_ref AS contentRef, created_at AS createdAt FROM world_objects
           WHERE world_id = ? AND branch_id = ? AND object_id = ?`,
          worldId,
          branchId,
          mutation.objectId,
        )
        const oldRef = (existing?.contentRef ?? undefined) as CasDigest | undefined
        if (oldRef && oldRef !== mutation.contentRef) this.cas.unlink("world_object", ownerId, oldRef)
        dbRun(
          this.db,
          `INSERT INTO world_objects (
             world_id, branch_id, object_id, object_type, path, content_ref,
             metadata_json, updated_revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(world_id, branch_id, object_id) DO UPDATE SET
             object_type = excluded.object_type,
             path = excluded.path,
             content_ref = excluded.content_ref,
             metadata_json = excluded.metadata_json,
             updated_revision = excluded.updated_revision,
             updated_at = excluded.updated_at`,
          worldId,
          branchId,
          mutation.objectId,
          mutation.objectType,
          mutation.path ?? null,
          mutation.contentRef ?? null,
          canonicalJson(mutation.metadata ?? {}),
          revision.toString(),
          existing?.createdAt ?? at,
          at,
        )
        if (mutation.contentRef && oldRef !== mutation.contentRef) {
          this.cas.link("world_object", ownerId, mutation.contentRef)
        }
        return "world.object.updated"
      }
      case "object.delete": {
        const ownerId = objectOwnerId(worldId, branchId, mutation.objectId)
        const existing = dbGet<{ contentRef: string | null }>(
          this.db,
          `SELECT content_ref AS contentRef FROM world_objects
           WHERE world_id = ? AND branch_id = ? AND object_id = ?`,
          worldId,
          branchId,
          mutation.objectId,
        )
        if (existing?.contentRef) {
          this.cas.unlink("world_object", ownerId, existing.contentRef as CasDigest)
        }
        dbRun(
          this.db,
          "DELETE FROM world_objects WHERE world_id = ? AND branch_id = ? AND object_id = ?",
          worldId,
          branchId,
          mutation.objectId,
        )
        return "world.object.deleted"
      }
      case "artifact.put": {
        assertNoReservedMetadata(mutation.metadata, ["artifactId", "mediaType", "contentRef"])
        this.cas.get(mutation.contentRef)
        const ownerId = objectOwnerId(worldId, branchId, mutation.artifactId)
        const existing = dbGet<{ contentRef: string; createdAt: number }>(
          this.db,
          `SELECT content_ref AS contentRef, created_at AS createdAt FROM world_artifacts
           WHERE world_id = ? AND branch_id = ? AND artifact_id = ?`,
          worldId,
          branchId,
          mutation.artifactId,
        )
        const oldRef = existing?.contentRef as CasDigest | undefined
        if (oldRef && oldRef !== mutation.contentRef) this.cas.unlink("world_artifact", ownerId, oldRef)
        dbRun(
          this.db,
          `INSERT INTO world_artifacts (
             world_id, branch_id, artifact_id, media_type, content_ref,
             metadata_json, updated_revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(world_id, branch_id, artifact_id) DO UPDATE SET
             media_type = excluded.media_type,
             content_ref = excluded.content_ref,
             metadata_json = excluded.metadata_json,
             updated_revision = excluded.updated_revision,
             updated_at = excluded.updated_at`,
          worldId,
          branchId,
          mutation.artifactId,
          mutation.mediaType,
          mutation.contentRef,
          canonicalJson(mutation.metadata ?? {}),
          revision.toString(),
          existing?.createdAt ?? at,
          at,
        )
        if (oldRef !== mutation.contentRef) {
          this.cas.link("world_artifact", ownerId, mutation.contentRef)
        }
        return "world.artifact.updated"
      }
      case "artifact.delete": {
        const ownerId = objectOwnerId(worldId, branchId, mutation.artifactId)
        const existing = dbGet<{ contentRef: string }>(
          this.db,
          `SELECT content_ref AS contentRef FROM world_artifacts
           WHERE world_id = ? AND branch_id = ? AND artifact_id = ?`,
          worldId,
          branchId,
          mutation.artifactId,
        )
        if (existing) this.cas.unlink("world_artifact", ownerId, existing.contentRef as CasDigest)
        dbRun(
          this.db,
          "DELETE FROM world_artifacts WHERE world_id = ? AND branch_id = ? AND artifact_id = ?",
          worldId,
          branchId,
          mutation.artifactId,
        )
        return "world.artifact.deleted"
      }
      case "service.set": {
        assertNoReservedMetadata(mutation.metadata, [
          "serviceId",
          "status",
          "definitionDigest",
        ])
        if (mutation.definitionDigest) this.cas.get(mutation.definitionDigest)
        const ownerId = objectOwnerId(worldId, branchId, mutation.serviceId)
        const existing = dbGet<{ definitionDigest: string | null; createdAt: number }>(
          this.db,
          `SELECT definition_digest AS definitionDigest, created_at AS createdAt FROM world_services
           WHERE world_id = ? AND branch_id = ? AND service_id = ?`,
          worldId,
          branchId,
          mutation.serviceId,
        )
        const oldRef = (existing?.definitionDigest ?? undefined) as CasDigest | undefined
        if (oldRef && oldRef !== mutation.definitionDigest) {
          this.cas.unlink("world_service", ownerId, oldRef)
        }
        dbRun(
          this.db,
          `INSERT INTO world_services (
             world_id, branch_id, service_id, status, definition_digest,
             metadata_json, updated_revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(world_id, branch_id, service_id) DO UPDATE SET
             status = excluded.status,
             definition_digest = excluded.definition_digest,
             metadata_json = excluded.metadata_json,
             updated_revision = excluded.updated_revision,
             updated_at = excluded.updated_at`,
          worldId,
          branchId,
          mutation.serviceId,
          mutation.status,
          mutation.definitionDigest ?? null,
          canonicalJson(mutation.metadata ?? {}),
          revision.toString(),
          existing?.createdAt ?? at,
          at,
        )
        if (mutation.definitionDigest && oldRef !== mutation.definitionDigest) {
          this.cas.link("world_service", ownerId, mutation.definitionDigest)
        }
        return "world.service.updated"
      }
      case "service.delete": {
        const ownerId = objectOwnerId(worldId, branchId, mutation.serviceId)
        const existing = dbGet<{ definitionDigest: string | null }>(
          this.db,
          `SELECT definition_digest AS definitionDigest FROM world_services
           WHERE world_id = ? AND branch_id = ? AND service_id = ?`,
          worldId,
          branchId,
          mutation.serviceId,
        )
        if (existing?.definitionDigest) {
          this.cas.unlink("world_service", ownerId, existing.definitionDigest as CasDigest)
        }
        dbRun(
          this.db,
          "DELETE FROM world_services WHERE world_id = ? AND branch_id = ? AND service_id = ?",
          worldId,
          branchId,
          mutation.serviceId,
        )
        return "world.service.deleted"
      }
    }
  }
}
