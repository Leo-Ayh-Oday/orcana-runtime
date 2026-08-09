import type { Database } from "bun:sqlite"
import { canonicalDigest, canonicalJson, parseCanonicalJson } from "./canonical"
import type { WorldEvent, WorldRevision } from "./contracts"
import { dbAll, dbRun } from "./database"

interface WorldEventRow {
  sequence: number
  eventId: string
  worldId: string
  branchId: string
  revision: string
  commitId: string | null
  eventType: string
  actor: string
  objectId: string | null
  payloadDigest: string
  payloadJson: string
  occurredAt: number
}

export interface AppendWorldEventInput {
  readonly eventId: string
  readonly worldId: string
  readonly branchId: string
  readonly revision: WorldRevision
  readonly commitId?: string
  readonly eventType: string
  readonly actor: string
  readonly objectId?: string
  readonly payload: unknown
  readonly occurredAt: number
}

function toWorldEvent(row: WorldEventRow): WorldEvent {
  return {
    sequence: row.sequence,
    eventId: row.eventId,
    worldId: row.worldId,
    branchId: row.branchId,
    revision: BigInt(row.revision),
    commitId: row.commitId ?? undefined,
    eventType: row.eventType,
    actor: row.actor,
    objectId: row.objectId ?? undefined,
    payloadDigest: row.payloadDigest as WorldEvent["payloadDigest"],
    payload: parseCanonicalJson(row.payloadJson),
    occurredAt: row.occurredAt,
  }
}

export class WorldLedger {
  constructor(private readonly db: Database) {}

  /** @internal Only WorldStore mutations may append, and only inside their DB transaction. */
  appendWithinTransaction(input: AppendWorldEventInput): number {
    if (!this.db.inTransaction) {
      throw new Error("WorldLedger append requires an active WorldDB transaction")
    }
    const payloadJson = canonicalJson(input.payload)
    const result = dbRun(
      this.db,
      `INSERT INTO world_events (
         event_id, world_id, branch_id, revision, commit_id, event_type,
         actor, object_id, payload_digest, payload_json, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.eventId,
      input.worldId,
      input.branchId,
      input.revision.toString(),
      input.commitId ?? null,
      input.eventType,
      input.actor,
      input.objectId ?? null,
      canonicalDigest(input.payload),
      payloadJson,
      input.occurredAt,
    )
    return Number(result.lastInsertRowid)
  }

  list(worldId: string, afterSequence = 0): WorldEvent[] {
    return dbAll<WorldEventRow>(
      this.db,
      `SELECT
         sequence,
         event_id AS eventId,
         world_id AS worldId,
         branch_id AS branchId,
         revision,
         commit_id AS commitId,
         event_type AS eventType,
         actor,
         object_id AS objectId,
         payload_digest AS payloadDigest,
         payload_json AS payloadJson,
         occurred_at AS occurredAt
       FROM world_events
       WHERE world_id = ? AND sequence > ?
       ORDER BY sequence`,
      worldId,
      afterSequence,
    ).map(toWorldEvent)
  }

  eventsForCommit(commitId: string): WorldEvent[] {
    return dbAll<WorldEventRow>(
      this.db,
      `SELECT
         sequence,
         event_id AS eventId,
         world_id AS worldId,
         branch_id AS branchId,
         revision,
         commit_id AS commitId,
         event_type AS eventType,
         actor,
         object_id AS objectId,
         payload_digest AS payloadDigest,
         payload_json AS payloadJson,
         occurred_at AS occurredAt
       FROM world_events
       WHERE commit_id = ?
       ORDER BY sequence`,
      commitId,
    ).map(toWorldEvent)
  }
}
