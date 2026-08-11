export type WorldRevision = bigint

export type WorldStatus = "active" | "suspended" | "archived" | "corrupted"
export type WorldBranchStatus = "active" | "merged" | "discarded"

export interface AgentWorld {
  readonly worldId: string
  readonly currentRevision: WorldRevision
  readonly currentBranchId: string
  readonly rootObjectId: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly status: WorldStatus
}

export interface WorldBranch {
  readonly branchId: string
  readonly worldId: string
  readonly parentBranchId?: string
  readonly baseRevision: WorldRevision
  readonly headRevision: WorldRevision
  readonly owner: string
  readonly purpose: string
  readonly status: WorldBranchStatus
  readonly createdAt: number
}

export const WORLD_OBJECT_TYPES = Object.freeze([
  "file",
  "directory",
  "workspace",
  "artifact",
  "memory",
  "model",
  "service",
  "secret",
  "network_endpoint",
  "device",
  "execution",
  "human_attention",
  "task_projection",
  "capability_state",
] as const)

export type WorldObjectType = (typeof WORLD_OBJECT_TYPES)[number]

export type CasDigest = `sha256:${string}`

export interface WorldObject {
  readonly worldId: string
  readonly branchId: string
  readonly objectId: string
  readonly objectType: WorldObjectType
  readonly path?: string
  readonly contentRef?: CasDigest
  readonly metadata: Readonly<Record<string, unknown>>
  readonly updatedRevision: WorldRevision
  readonly createdAt: number
  readonly updatedAt: number
}

export interface WorldArtifact {
  readonly worldId: string
  readonly branchId: string
  readonly artifactId: string
  readonly mediaType: string
  readonly contentRef: CasDigest
  readonly metadata: Readonly<Record<string, unknown>>
  readonly updatedRevision: WorldRevision
  readonly createdAt: number
  readonly updatedAt: number
}

export interface WorldServiceState {
  readonly worldId: string
  readonly branchId: string
  readonly serviceId: string
  readonly status: string
  readonly definitionDigest?: CasDigest
  readonly metadata: Readonly<Record<string, unknown>>
  readonly updatedRevision: WorldRevision
  readonly createdAt: number
  readonly updatedAt: number
}

export type WorldMutation =
  | {
      readonly type: "object.put"
      readonly objectId: string
      readonly objectType: WorldObjectType
      readonly path?: string
      readonly contentRef?: CasDigest
      readonly metadata?: Readonly<Record<string, unknown>>
    }
  | {
      readonly type: "object.delete"
      readonly objectId: string
    }
  | {
      readonly type: "artifact.put"
      readonly artifactId: string
      readonly mediaType: string
      readonly contentRef: CasDigest
      readonly metadata?: Readonly<Record<string, unknown>>
    }
  | {
      readonly type: "artifact.delete"
      readonly artifactId: string
    }
  | {
      readonly type: "service.set"
      readonly serviceId: string
      readonly status: string
      readonly definitionDigest?: CasDigest
      readonly metadata?: Readonly<Record<string, unknown>>
    }
  | {
      readonly type: "service.delete"
      readonly serviceId: string
    }

export interface WorldCorruptionMutation {
  readonly type: "world.corrupted"
  readonly detail: string
}

export type WorldDeltaMutation = WorldMutation | WorldCorruptionMutation

export interface WorldDeltaManifest {
  readonly schemaVersion: 1
  readonly type: "world-delta"
  readonly worldId: string
  readonly branchId: string
  readonly baseRevision: string
  readonly mutations: readonly WorldDeltaMutation[]
}

/** Canonical world-delta manifest（唯一 delta digest 格式真源；store 与
 *  projection scanner 共用，禁止第二套 delta 编码）。 */
export function worldDeltaManifest(
  worldId: string,
  branchId: string,
  baseRevision: WorldRevision,
  mutations: readonly WorldDeltaMutation[],
): WorldDeltaManifest {
  return {
    schemaVersion: 1,
    type: "world-delta",
    worldId,
    branchId,
    baseRevision: baseRevision.toString(),
    mutations,
  }
}

export interface WorldCommitRequest {
  readonly worldId: string
  readonly branchId: string
  readonly baseRevision: WorldRevision
  readonly actor: string
  readonly mutations: readonly WorldMutation[]
  readonly executionReceiptIds?: readonly string[]
  readonly effectReceiptIds?: readonly string[]
  readonly commitId?: string
}

export interface WorldCommitReceipt {
  readonly commitId: string
  readonly worldId: string
  readonly branchId: string
  readonly baseRevision: WorldRevision
  readonly newRevision: WorldRevision
  readonly actor: string
  readonly deltaDigest: CasDigest
  readonly materializedStateDigest: CasDigest
  readonly executionReceiptIds: readonly string[]
  readonly effectReceiptIds: readonly string[]
  readonly committedAt: number
}

export interface WorldEvent {
  readonly sequence: number
  readonly eventId: string
  readonly worldId: string
  readonly branchId: string
  readonly revision: WorldRevision
  readonly commitId?: string
  readonly eventType: string
  readonly actor: string
  readonly objectId?: string
  readonly payloadDigest: CasDigest
  readonly payload: unknown
  readonly occurredAt: number
}

export interface CasObjectRecord {
  readonly digest: CasDigest
  readonly size: number
  readonly mediaType: string
  readonly mediaTypes: readonly string[]
  readonly isManifest: boolean
  readonly createdAt: number
  readonly refCount: number
}

export interface CasLink {
  readonly ownerType: string
  readonly ownerId: string
  readonly digest: CasDigest
  readonly createdAt: number
}

export interface FileManifestChunk {
  readonly digest: CasDigest
  readonly offset: number
  readonly size: number
}

export interface FileManifest {
  readonly schemaVersion: 1
  readonly type: "file"
  readonly mediaType: string
  readonly size: number
  readonly chunks: readonly FileManifestChunk[]
}

export interface DirectoryManifestEntry {
  readonly name: string
  readonly kind: "file" | "directory"
  readonly digest: CasDigest
  readonly mode?: number
}

export interface DirectoryManifest {
  readonly schemaVersion: 1
  readonly type: "directory"
  readonly entries: readonly DirectoryManifestEntry[]
}

export interface WorldManifest {
  readonly schemaVersion: 1
  readonly type: "world"
  readonly worldId: string
  readonly branchId: string
  readonly revision: string
  readonly worldStatus: WorldStatus
  readonly rootObjectId: string
  readonly filesystemDigest: CasDigest
  readonly memoryDigest: CasDigest
  readonly taskStateDigest: CasDigest
  readonly capabilityStateDigest: CasDigest
  readonly serviceStateDigest: CasDigest
  readonly artifactStateDigest: CasDigest
}

export interface WorldSnapshot {
  readonly snapshotId: string
  readonly worldId: string
  readonly branchId: string
  readonly revision: WorldRevision
  readonly manifestDigest: CasDigest
  readonly filesystemDigest: CasDigest
  readonly memoryDigest: CasDigest
  readonly taskStateDigest: CasDigest
  readonly capabilityStateDigest: CasDigest
  readonly serviceStateDigest: CasDigest
  readonly artifactStateDigest: CasDigest
  readonly createdAt: number
}

export type WorldFaultPoint =
  | "after_materialization_before_ledger"
  | "after_ledger_before_commit"
  | "after_commit_before_response"
  | "after_cas_temp_fsync"
  | "after_cas_rename_before_metadata"
  | "after_cas_metadata_before_return"
  | "before_cas_link_insert"
  | "after_gc_file_fsync_before_metadata_commit"
  | "after_world_db_entries_locked"
  | "after_world_db_bootstrap_intent_fsync"
  | "after_world_db_bootstrap_image_fsync"
  | "after_snapshot_manifest_before_insert"
  | "after_snapshot_insert_before_commit"

export interface WorldIntegrityIssue {
  readonly code:
    | "WORLD_REVISION_SPLIT_BRAIN"
    | "LEDGER_DB_DIVERGENCE"
    | "CAS_MISSING_REFERENCED_OBJECT"
    | "CAS_CONTENT_CORRUPT"
    | "CAS_REFERENCE_DIVERGENCE"
    | "UNREACHABLE_OBJECT_LEAK"
  readonly worldId?: string
  readonly detail: string
}

export interface WorldRecoveryReport {
  readonly removedTemporaryFiles: readonly string[]
  readonly removedUnreachableObjects: readonly CasDigest[]
  readonly repairedRefCounts: readonly CasDigest[]
  readonly integrityIssues: readonly WorldIntegrityIssue[]
  readonly corruptedWorldIds: readonly string[]
}

export class WorldConflictError extends Error {
  readonly code = "WORLD_CONFLICT"

  constructor(
    readonly worldId: string,
    readonly branchId: string,
    readonly expectedRevision: WorldRevision,
    readonly actualRevision: WorldRevision,
  ) {
    super(
      `WORLD_CONFLICT: ${worldId}/${branchId} expected revision ${expectedRevision} but head is ${actualRevision}`,
    )
    this.name = "WorldConflictError"
  }
}

export class WorldCorruptionError extends Error {
  readonly code = "WORLD_CORRUPTED"

  constructor(readonly issues: readonly WorldIntegrityIssue[]) {
    super(
      issues.length > 0
        ? `WORLD_CORRUPTED: ${issues.map(issue => issue.code).join(", ")}`
        : "WORLD_CORRUPTED: persisted World status is corrupted",
    )
    this.name = "WorldCorruptionError"
  }
}
