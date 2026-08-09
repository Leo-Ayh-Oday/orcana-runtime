import type { Database } from "bun:sqlite"
import type {
  AgentWorld,
  CasDigest,
  WorldArtifact,
  WorldBranch,
  WorldManifest,
  WorldObject,
  WorldServiceState,
  WorldSnapshot,
  WorldFaultPoint,
} from "./contracts"
import { WorldCorruptionError } from "./contracts"
import { WorldCas } from "./cas"
import { dbAll, dbGet, dbRun, withImmediateTransaction } from "./database"
import { WorldLedger } from "./ledger"
import { createSectionManifest, createWorldManifest, type SectionManifestEntry } from "./manifests"

interface SnapshotRow {
  snapshotId: string
  worldId: string
  branchId: string
  revision: string
  manifestDigest: string
  filesystemDigest: string
  memoryDigest: string
  taskStateDigest: string
  capabilityStateDigest: string
  serviceStateDigest: string
  artifactStateDigest: string
  createdAt: number
}

export interface WorldSnapshotSource {
  readonly getWorld: (worldId: string) => AgentWorld | undefined
  readonly getBranch: (worldId: string, branchId: string) => WorldBranch | undefined
  readonly listObjects: (worldId: string, branchId: string) => WorldObject[]
  readonly listArtifacts: (worldId: string, branchId: string) => WorldArtifact[]
  readonly listServices: (worldId: string, branchId: string) => WorldServiceState[]
}

function snapshotFromRow(row: SnapshotRow): WorldSnapshot {
  return {
    snapshotId: row.snapshotId,
    worldId: row.worldId,
    branchId: row.branchId,
    revision: BigInt(row.revision),
    manifestDigest: row.manifestDigest as CasDigest,
    filesystemDigest: row.filesystemDigest as CasDigest,
    memoryDigest: row.memoryDigest as CasDigest,
    taskStateDigest: row.taskStateDigest as CasDigest,
    capabilityStateDigest: row.capabilityStateDigest as CasDigest,
    serviceStateDigest: row.serviceStateDigest as CasDigest,
    artifactStateDigest: row.artifactStateDigest as CasDigest,
    createdAt: row.createdAt,
  }
}

function objectEntry(object: WorldObject): SectionManifestEntry {
  return {
    id: object.objectId,
    kind: object.objectType,
    ...(object.path === undefined ? {} : { path: object.path }),
    ...(object.contentRef === undefined ? {} : { contentRef: object.contentRef }),
    metadata: object.metadata,
  }
}

export class WorldSnapshotManager {
  constructor(
    private readonly db: Database,
    private readonly cas: WorldCas,
    private readonly ledger: WorldLedger,
    private readonly source: WorldSnapshotSource,
    private readonly now: () => number,
    private readonly eventId: () => string,
    private readonly faultInjector?: (point: WorldFaultPoint) => void,
  ) {}

  create(worldId: string, branchId: string): WorldSnapshot {
    return withImmediateTransaction(this.db, () => {
      const world = this.source.getWorld(worldId)
      const branch = this.source.getBranch(worldId, branchId)
      if (!world || !branch) throw new Error(`unknown world branch: ${worldId}/${branchId}`)
      if (world.currentBranchId !== branchId || world.currentRevision !== branch.headRevision) {
        throw new Error(`cannot snapshot a non-current or divergent branch: ${worldId}/${branchId}`)
      }

      const objects = this.source.listObjects(worldId, branchId)
      const filesystem = createSectionManifest(
        this.cas,
        "filesystem",
        objects
          .filter(object => ["file", "directory", "workspace"].includes(object.objectType))
          .map(objectEntry),
      )
      const memory = createSectionManifest(
        this.cas,
        "memory-and-world-objects",
        objects
          .filter(object =>
            !["file", "directory", "workspace", "task_projection", "capability_state"].includes(
              object.objectType,
            ),
          )
          .map(objectEntry),
      )
      const task = createSectionManifest(
        this.cas,
        "task-projection-non-authoritative",
        objects.filter(object => object.objectType === "task_projection").map(objectEntry),
      )
      const capability = createSectionManifest(
        this.cas,
        "capability-state",
        objects.filter(object => object.objectType === "capability_state").map(objectEntry),
      )
      const services = createSectionManifest(
        this.cas,
        "services",
        this.source.listServices(worldId, branchId).map(service => ({
          id: service.serviceId,
          kind: "service",
          ...(service.definitionDigest === undefined
            ? {}
            : { contentRef: service.definitionDigest }),
          metadata: { ...service.metadata, status: service.status },
        })),
      )
      const artifacts = createSectionManifest(
        this.cas,
        "artifacts",
        this.source.listArtifacts(worldId, branchId).map(artifact => ({
          id: artifact.artifactId,
          kind: "artifact",
          contentRef: artifact.contentRef,
          metadata: { ...artifact.metadata, mediaType: artifact.mediaType },
        })),
      )

      const worldManifest: WorldManifest = {
        schemaVersion: 1,
        type: "world",
        worldId,
        branchId,
        revision: world.currentRevision.toString(),
        worldStatus: world.status,
        rootObjectId: world.rootObjectId,
        filesystemDigest: filesystem.digest,
        memoryDigest: memory.digest,
        taskStateDigest: task.digest,
        capabilityStateDigest: capability.digest,
        serviceStateDigest: services.digest,
        artifactStateDigest: artifacts.digest,
      }
      const stored = createWorldManifest(this.cas, worldManifest)
      const snapshotId = `snapshot:${stored.digest.slice("sha256:".length)}`
      this.faultInjector?.("after_snapshot_manifest_before_insert")
      const existing = this.getForRevision(worldId, branchId, world.currentRevision)
      if (existing) {
        if (existing.manifestDigest !== stored.digest) {
          throw new WorldCorruptionError([{
            code: "LEDGER_DB_DIVERGENCE",
            worldId,
            detail: `revision ${world.currentRevision} already has snapshot ${existing.manifestDigest}, refusing ${stored.digest}`,
          }])
        }
        return existing
      }

      const createdAt = this.now()
      const inserted = dbRun(
        this.db,
        `INSERT INTO world_snapshots (
           snapshot_id, world_id, branch_id, revision, manifest_digest,
           filesystem_digest, memory_digest, task_state_digest,
           capability_state_digest, service_state_digest, artifact_state_digest, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(world_id, branch_id, revision) DO NOTHING`,
        snapshotId,
        worldId,
        branchId,
        world.currentRevision.toString(),
        stored.digest,
        filesystem.digest,
        memory.digest,
        task.digest,
        capability.digest,
        services.digest,
        artifacts.digest,
        createdAt,
      )
      this.cas.linkMany("snapshot", snapshotId, [
        stored.digest,
        filesystem.digest,
        memory.digest,
        task.digest,
        capability.digest,
        services.digest,
        artifacts.digest,
      ])
      if (inserted.changes === 1) {
        this.ledger.appendWithinTransaction({
          eventId: this.eventId(),
          worldId,
          branchId,
          revision: world.currentRevision,
          eventType: "world.snapshot.created",
          actor: "system:snapshot",
          objectId: snapshotId,
          payload: { snapshotId, manifestDigest: stored.digest },
          occurredAt: createdAt,
        })
      }
      this.faultInjector?.("after_snapshot_insert_before_commit")
      const result = this.getForRevision(worldId, branchId, world.currentRevision)
      if (!result || result.manifestDigest !== stored.digest) {
        throw new WorldCorruptionError([{
          code: "LEDGER_DB_DIVERGENCE",
          worldId,
          detail: `snapshot conflict for revision ${world.currentRevision}`,
        }])
      }
      return result
    })
  }

  get(snapshotId: string): WorldSnapshot | undefined {
    const row = dbGet<SnapshotRow>(
      this.db,
      `SELECT snapshot_id AS snapshotId, world_id AS worldId, branch_id AS branchId,
              revision, manifest_digest AS manifestDigest,
              filesystem_digest AS filesystemDigest, memory_digest AS memoryDigest,
              task_state_digest AS taskStateDigest,
              capability_state_digest AS capabilityStateDigest,
              service_state_digest AS serviceStateDigest,
              artifact_state_digest AS artifactStateDigest, created_at AS createdAt
       FROM world_snapshots WHERE snapshot_id = ?`,
      snapshotId,
    )
    return row ? snapshotFromRow(row) : undefined
  }

  getForRevision(
    worldId: string,
    branchId: string,
    revision: bigint,
  ): WorldSnapshot | undefined {
    const row = dbGet<SnapshotRow>(
      this.db,
      `SELECT snapshot_id AS snapshotId, world_id AS worldId, branch_id AS branchId,
              revision, manifest_digest AS manifestDigest,
              filesystem_digest AS filesystemDigest, memory_digest AS memoryDigest,
              task_state_digest AS taskStateDigest,
              capability_state_digest AS capabilityStateDigest,
              service_state_digest AS serviceStateDigest,
              artifact_state_digest AS artifactStateDigest, created_at AS createdAt
       FROM world_snapshots WHERE world_id = ? AND branch_id = ? AND revision = ?`,
      worldId,
      branchId,
      revision.toString(),
    )
    return row ? snapshotFromRow(row) : undefined
  }

  list(worldId: string, branchId: string): WorldSnapshot[] {
    return dbAll<SnapshotRow>(
      this.db,
      `SELECT snapshot_id AS snapshotId, world_id AS worldId, branch_id AS branchId,
              revision, manifest_digest AS manifestDigest,
              filesystem_digest AS filesystemDigest, memory_digest AS memoryDigest,
              task_state_digest AS taskStateDigest,
              capability_state_digest AS capabilityStateDigest,
              service_state_digest AS serviceStateDigest,
              artifact_state_digest AS artifactStateDigest, created_at AS createdAt
       FROM world_snapshots WHERE world_id = ? AND branch_id = ?
       ORDER BY created_at, snapshot_id`,
      worldId,
      branchId,
    ).map(snapshotFromRow)
  }
}
