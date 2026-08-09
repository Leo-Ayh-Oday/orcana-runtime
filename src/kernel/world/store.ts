import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import {
  canonicalDigest,
  canonicalJson,
  compareCanonicalStrings,
  parseCanonicalJson,
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
  WorldIntegrityIssue,
  WorldMutation,
  WorldObject,
  WorldServiceState,
  WorldSnapshot,
} from "./contracts"
import { WorldConflictError, WorldCorruptionError } from "./contracts"
import { dbAll, dbGet, dbRun, withImmediateTransaction } from "./database"
import { WorldLedger } from "./ledger"
import { WORLD_SCHEMA, WORLD_SCHEMA_VERSION } from "./schema"
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
    parentBranchId?: string
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
    path?: string
    contentRef?: CasDigest
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
    definitionDigest?: CasDigest
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

export class WorldStore {
  readonly databasePath: string
  readonly ledger: WorldLedger
  readonly cas: WorldCas
  readonly snapshots: WorldSnapshotManager
  private readonly db: Database
  private readonly now: () => number
  private readonly idFactory: (kind: "world" | "event" | "commit") => string
  private readonly faultInjector?: (point: WorldFaultPoint) => void

  constructor(readonly root: string, options: Omit<WorldStoreOptions, "root"> = {}) {
    this.now = options.now ?? (() => Date.now())
    this.idFactory = options.idFactory ?? (kind => `${kind}-${randomUUID()}`)
    this.faultInjector = options.faultInjector
    for (const directory of ["ledger", "snapshots", "projections", "recovery"]) {
      mkdirSync(join(root, directory), { recursive: true, mode: 0o700 })
    }
    this.databasePath = join(root, "world.db")
    this.db = new Database(this.databasePath)
    this.db.exec("PRAGMA foreign_keys = ON")
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = FULL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.db.exec(WORLD_SCHEMA)
    const installedVersions = dbAll<{ schemaVersion: number }>(
      this.db,
      "SELECT schema_version AS schemaVersion FROM world_schema_meta ORDER BY schema_version",
    ).map(row => row.schemaVersion)
    if (installedVersions.length === 0) {
      dbRun(
        this.db,
        "INSERT INTO world_schema_meta (schema_version, installed_at) VALUES (?, ?)",
        WORLD_SCHEMA_VERSION,
        this.now(),
      )
    } else if (
      installedVersions.length !== 1 ||
      installedVersions[0] !== WORLD_SCHEMA_VERSION
    ) {
      const message = `WORLD_SCHEMA_INCOMPATIBLE: expected ${WORLD_SCHEMA_VERSION}, found ${installedVersions.join(",")}`
      this.db.close()
      throw new Error(message)
    }
    this.ledger = new WorldLedger(this.db)
    this.cas = new WorldCas(this.db, root, this.now, this.faultInjector)
    this.snapshots = new WorldSnapshotManager(
      this.db,
      this.cas,
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
  }

  close(): void {
    this.db.close()
  }

  createWorld(input: CreateWorldInput): AgentWorld {
    const worldId = input.worldId ?? this.idFactory("world")
    const branchId = input.branchId ?? "main"
    const rootObjectId = input.rootObjectId ?? "root"
    if (!worldId || !branchId || !input.owner) throw new Error("world, branch, and owner must be non-empty")
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
        input.owner,
        input.purpose ?? "initial world",
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
        actor: input.owner,
        payload: {
          rootObjectId,
          purpose: input.purpose ?? "initial world",
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
        parentBranchId: branch.parentBranchId,
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
          path: object.path,
          contentRef: object.contentRef,
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
          definitionDigest: service.definitionDigest,
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
          path: mutation.path,
          contentRef: mutation.contentRef,
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
          definitionDigest: mutation.definitionDigest,
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

  compareAndCommit(request: WorldCommitRequest): WorldCommitReceipt {
    if (request.mutations.length === 0) throw new Error("World commit requires at least one mutation")
    const commitId = request.commitId ?? this.idFactory("commit")
    const executionReceiptIds = [...(request.executionReceiptIds ?? [])]
    const effectReceiptIds = [...(request.effectReceiptIds ?? [])]
    const deltaDigest = canonicalDigest(request.mutations)
    const requestDigest = canonicalDigest({
      ...request,
      baseRevision: request.baseRevision.toString(),
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

      const newRevision = request.baseRevision + 1n
      const committedAt = this.now()
      for (const mutation of request.mutations) {
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
          mutationCount: request.mutations.length,
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
      if (
        genesis &&
        typeof genesisPayload?.rootObjectId === "string" &&
        typeof genesisPayload.purpose === "string"
      ) {
        replayState = {
          world: {
            worldId: world.worldId,
            currentRevision: "0",
            currentBranchId: world.currentBranchId,
            rootObjectId: genesisPayload.rootObjectId,
            status: "active",
            createdAt: genesis.occurredAt,
            updatedAt: genesis.occurredAt,
          },
          branch: {
            branchId: world.currentBranchId,
            baseRevision: "0",
            headRevision: "0",
            owner: genesis.actor,
            purpose: genesisPayload.purpose,
            status: "active",
            createdAt: genesis.occurredAt,
          },
          objects: [],
          artifacts: [],
          services: [],
        }
        if (canonicalDigest(replayState) !== genesisPayload.materializedStateDigest) {
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
          canonicalDigest(mutationEvents.map(event => event.payload)) !== commit.deltaDigest ||
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
      const world = this.getWorld(worldId)
      if (!world || world.status === "corrupted") return
      const branch = this.getBranch(worldId, world.currentBranchId)
      if (!branch || branch.headRevision !== world.currentRevision) return
      const baseRevision = world.currentRevision
      const newRevision = baseRevision + 1n
      const at = this.now()
      const commitId = this.idFactory("commit")
      const corruptionMutation = { type: "world.corrupted", detail } as const
      const deltaDigest = canonicalDigest([corruptionMutation])
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
        if (mutation.contentRef && !this.cas.has(mutation.contentRef)) {
          throw new Error(`object references missing CAS content: ${mutation.contentRef}`)
        }
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
        if (!this.cas.has(mutation.contentRef)) {
          throw new Error(`artifact references missing CAS content: ${mutation.contentRef}`)
        }
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
        if (mutation.definitionDigest && !this.cas.has(mutation.definitionDigest)) {
          throw new Error(`service references missing CAS definition: ${mutation.definitionDigest}`)
        }
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
