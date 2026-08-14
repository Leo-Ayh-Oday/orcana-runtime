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
import {
  computeSectionManifest,
  computeWorldManifest,
  createSectionManifest,
  createWorldManifest,
  type SectionManifestEntry,
} from "./manifests"

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

/** R5-07/R6-06：内容表示类型的不可变绑定 —— snapshot 只能复制
 *  WorldObject.representation（World revision 的持久事实；commit 时绑定）。
 *  **禁止**读取 cas.record(...).isManifest 推断语义（全局 isManifest 可被
 *  promotion 翻转 → 双重解释；NONDETERMINISTIC_SNAPSHOT = 0）。file 缺
 *  representation（corrupt/legacy 行）→ 明确 fail-closed。 */
function objectEntry(object: WorldObject, _cas: WorldCas): SectionManifestEntry {
  let representation: "raw" | "file-manifest" | undefined
  if (object.objectType === "file") {
    if (object.contentRef === undefined) {
      throw new Error(`file object ${object.objectId} has no contentRef`)
    }
    if (object.representation !== "raw" && object.representation !== "file-manifest") {
      throw new Error(
        `file object ${object.objectId} has no persisted representation (legacy/corrupt row); snapshot creation refused fail-closed`,
      )
    }
    representation = object.representation
  } else if (object.representation !== undefined) {
    throw new Error(`non-file object ${object.objectId} must not carry representation`)
  }
  return {
    id: object.objectId,
    kind: object.objectType,
    ...(object.path === undefined ? {} : { path: object.path }),
    ...(object.contentRef === undefined ? {} : { contentRef: object.contentRef }),
    ...(representation === undefined ? {} : { representation }),
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
      // R6-07-1：**先纯计算**全部 section/world manifest digest（只读
      // 引用校验；不写 CAS）→ 查 existing snapshot → 命中则验证 attestation
      // 并幂等返回（**任何 CAS put 之前** —— promotion 后重复 create
      // 不得产生新物理对象；R6-00-12）。
      const filesystemEntries: SectionManifestEntry[] = objects
        .filter(object => ["file", "directory", "workspace"].includes(object.objectType))
        .map(object => objectEntry(object, this.cas))
      const memoryEntries: SectionManifestEntry[] = objects
        .filter(object =>
          !["file", "directory", "workspace", "task_projection", "capability_state"].includes(
            object.objectType,
          ),
        )
        .map(object => objectEntry(object, this.cas))
      const taskEntries: SectionManifestEntry[] = objects
        .filter(object => object.objectType === "task_projection")
        .map(object => objectEntry(object, this.cas))
      const capabilityEntries: SectionManifestEntry[] = objects
        .filter(object => object.objectType === "capability_state")
        .map(object => objectEntry(object, this.cas))
      const servicesEntries: SectionManifestEntry[] = this.source.listServices(worldId, branchId).map(service => ({
        id: service.serviceId,
        kind: "service",
        ...(service.definitionDigest === undefined
          ? {}
          : { contentRef: service.definitionDigest }),
        metadata: { ...service.metadata, status: service.status },
      }))
      const artifactsEntries: SectionManifestEntry[] = this.source.listArtifacts(worldId, branchId).map(artifact => ({
        id: artifact.artifactId,
        kind: "artifact",
        contentRef: artifact.contentRef,
        metadata: { ...artifact.metadata, mediaType: artifact.mediaType },
      }))
      const filesystem = computeSectionManifest(this.cas, "filesystem", filesystemEntries)
      const memory = computeSectionManifest(this.cas, "memory-and-world-objects", memoryEntries)
      const task = computeSectionManifest(this.cas, "task-projection-non-authoritative", taskEntries)
      const capability = computeSectionManifest(this.cas, "capability-state", capabilityEntries)
      const services = computeSectionManifest(this.cas, "services", servicesEntries)
      const artifacts = computeSectionManifest(this.cas, "artifacts", artifactsEntries)

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
      const stored = computeWorldManifest(this.cas, worldManifest)
      const snapshotId = `snapshot:${stored.digest.slice("sha256:".length)}`
      const existing = this.getForRevision(worldId, branchId, world.currentRevision)
      if (existing) {
        // R6-07-2：验证 existing attestation（全部 digest 与当前派生一致
        // —— representation 等 World 事实变更 → LEDGER_DB_DIVERGENCE，
        // 不静默返回）。任何 CAS put 之前幂等返回 existing。
        if (
          existing.manifestDigest !== stored.digest ||
          existing.filesystemDigest !== filesystem.digest ||
          existing.memoryDigest !== memory.digest ||
          existing.taskStateDigest !== task.digest ||
          existing.capabilityStateDigest !== capability.digest ||
          existing.serviceStateDigest !== services.digest ||
          existing.artifactStateDigest !== artifacts.digest
        ) {
          throw new WorldCorruptionError([{
            code: "LEDGER_DB_DIVERGENCE",
            worldId,
            detail: `revision ${world.currentRevision} already has snapshot ${existing.manifestDigest} but the derived world state now produces ${stored.digest} (attestation divergence; no CAS writes performed)`,
          }])
        }
        return existing
      }
      // existing 不存在 → 物理写入（putManifest；引用已只读校验通过，
      // 这里不会因引用缺失中途失败 → 确定性失败零 residue）。
      this.faultInjector?.("after_snapshot_manifest_before_insert")
      // 写入全部 section manifest（digest 必须与纯计算一致 —— 不一致即
      // CAS 实现缺陷，fail-closed）。
      const writeSection = (computed: ReturnType<typeof computeSectionManifest>, section: string, entries: readonly SectionManifestEntry[]): void => {
        const written = createSectionManifest(this.cas, section, entries)
        if (written.digest !== computed.digest) {
          throw new WorldCorruptionError([{
            code: "LEDGER_DB_DIVERGENCE",
            worldId,
            detail: `section manifest ${section} digest mismatch after write (${written.digest} != ${computed.digest})`,
          }])
        }
      }
      writeSection(filesystem, "filesystem", filesystemEntries)
      writeSection(memory, "memory-and-world-objects", memoryEntries)
      writeSection(task, "task-projection-non-authoritative", taskEntries)
      writeSection(capability, "capability-state", capabilityEntries)
      writeSection(services, "services", servicesEntries)
      writeSection(artifacts, "artifacts", artifactsEntries)
      const storedWorld = createWorldManifest(this.cas, worldManifest)
      if (storedWorld.digest !== stored.digest) {
        throw new WorldCorruptionError([{
          code: "LEDGER_DB_DIVERGENCE",
          worldId,
          detail: `world manifest digest mismatch after write (${storedWorld.digest} != ${stored.digest})`,
        }])
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
