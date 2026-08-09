import type { Database } from "bun:sqlite"
import { canonicalDigest } from "./canonical"
import type { CasDigest } from "./contracts"
import { dbAll, dbRun } from "./database"

export const WORLD_SCHEMA_VERSION = 4

interface SchemaObjectRow {
  type: "table" | "index" | "trigger"
  name: string
  tableName: string
  sql: string
}

function worldSchemaObjectNames(db: Database): string[] {
  return dbAll<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master
     WHERE type IN ('table', 'index', 'trigger')
       AND name NOT LIKE 'sqlite_%'
       AND sql IS NOT NULL`,
  ).map(row => row.name)
}

export function worldSchemaFingerprint(db: Database): CasDigest {
  const rows = dbAll<SchemaObjectRow>(
    db,
    `SELECT type, name, tbl_name AS tableName, sql
     FROM sqlite_master
     WHERE type IN ('table', 'index', 'trigger')
       AND name NOT LIKE 'sqlite_%'
       AND sql IS NOT NULL
     ORDER BY type, name`,
  )
  return canonicalDigest(rows.map(row => ({
    type: row.type,
    name: row.name,
    tableName: row.tableName,
    sql: row.sql.replace(/\s+/g, " ").trim(),
  })))
}

export const WORLD_SCHEMA_FINGERPRINT: CasDigest =
  "sha256:e166a4904d61cd84f6503d3895be4119645d95add38e00844365f08f3a53da24"

export function assertWorldSchemaCompatible(db: Database): void {
  const installedObjects = worldSchemaObjectNames(db)
  if (!installedObjects.includes("world_schema_meta")) {
    throw new Error("WORLD_SCHEMA_INCOMPATIBLE: schema metadata table is missing")
  }
  const installedVersions = dbAll<{ schemaVersion: number }>(
    db,
    "SELECT schema_version AS schemaVersion FROM world_schema_meta ORDER BY schema_version",
  ).map(row => row.schemaVersion)
  if (
    installedVersions.length !== 1 ||
    installedVersions[0] !== WORLD_SCHEMA_VERSION
  ) {
    throw new Error(
      `WORLD_SCHEMA_INCOMPATIBLE: expected ${WORLD_SCHEMA_VERSION}, found ${installedVersions.join(",") || "none"}`,
    )
  }
  const fingerprint = worldSchemaFingerprint(db)
  if (fingerprint !== WORLD_SCHEMA_FINGERPRINT) {
    throw new Error(
      `WORLD_SCHEMA_INCOMPATIBLE: expected fingerprint ${WORLD_SCHEMA_FINGERPRINT}, found ${fingerprint}`,
    )
  }
}

export function initializeOrValidateWorldSchema(db: Database, installedAt: number): void {
  const installedObjects = worldSchemaObjectNames(db)
  if (installedObjects.length > 0) {
    assertWorldSchemaCompatible(db)
    return
  }
  db.exec(WORLD_SCHEMA)
  dbRun(
    db,
    "INSERT INTO world_schema_meta (schema_version, installed_at) VALUES (?, ?)",
    WORLD_SCHEMA_VERSION,
    installedAt,
  )
  const fingerprint = worldSchemaFingerprint(db)
  if (fingerprint !== WORLD_SCHEMA_FINGERPRINT) {
    throw new Error(
      `WORLD_SCHEMA_BUILD_MISMATCH: expected ${WORLD_SCHEMA_FINGERPRINT}, found ${fingerprint}`,
    )
  }
}

export const WORLD_SCHEMA = `
CREATE TABLE IF NOT EXISTS world_schema_meta (
  schema_version INTEGER PRIMARY KEY,
  installed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS world_meta (
  world_id TEXT PRIMARY KEY,
  current_revision TEXT NOT NULL,
  current_branch_id TEXT NOT NULL,
  root_object_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'suspended', 'archived', 'corrupted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS world_branches (
  world_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  parent_branch_id TEXT,
  base_revision TEXT NOT NULL,
  owner TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'merged', 'discarded')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, branch_id),
  FOREIGN KEY (world_id) REFERENCES world_meta(world_id)
);

CREATE TABLE IF NOT EXISTS world_heads (
  world_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, branch_id),
  FOREIGN KEY (world_id, branch_id) REFERENCES world_branches(world_id, branch_id)
);

CREATE TABLE IF NOT EXISTS world_objects (
  world_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  path TEXT,
  content_ref TEXT,
  metadata_json TEXT NOT NULL,
  updated_revision TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, branch_id, object_id),
  FOREIGN KEY (world_id, branch_id) REFERENCES world_branches(world_id, branch_id)
);

CREATE TABLE IF NOT EXISTS world_commits (
  commit_id TEXT PRIMARY KEY,
  request_digest TEXT NOT NULL,
  world_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  base_revision TEXT NOT NULL,
  new_revision TEXT NOT NULL,
  actor TEXT NOT NULL,
  delta_digest TEXT NOT NULL,
  materialized_state_digest TEXT NOT NULL,
  execution_receipt_ids_json TEXT NOT NULL,
  effect_receipt_ids_json TEXT NOT NULL,
  committed_at INTEGER NOT NULL,
  UNIQUE (world_id, branch_id, new_revision),
  FOREIGN KEY (world_id, branch_id) REFERENCES world_branches(world_id, branch_id)
);

CREATE TABLE IF NOT EXISTS world_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  world_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  commit_id TEXT,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  object_id TEXT,
  payload_digest TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  FOREIGN KEY (world_id) REFERENCES world_meta(world_id)
);

CREATE TABLE IF NOT EXISTS world_artifacts (
  world_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  media_type TEXT NOT NULL,
  content_ref TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  updated_revision TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, branch_id, artifact_id),
  FOREIGN KEY (world_id, branch_id) REFERENCES world_branches(world_id, branch_id)
);

CREATE TABLE IF NOT EXISTS world_services (
  world_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  status TEXT NOT NULL,
  definition_digest TEXT,
  metadata_json TEXT NOT NULL,
  updated_revision TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, branch_id, service_id),
  FOREIGN KEY (world_id, branch_id) REFERENCES world_branches(world_id, branch_id)
);

CREATE TABLE IF NOT EXISTS world_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  filesystem_digest TEXT NOT NULL,
  memory_digest TEXT NOT NULL,
  task_state_digest TEXT NOT NULL,
  capability_state_digest TEXT NOT NULL,
  service_state_digest TEXT NOT NULL,
  artifact_state_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (world_id, branch_id, revision),
  FOREIGN KEY (world_id, branch_id) REFERENCES world_branches(world_id, branch_id)
);

CREATE TABLE IF NOT EXISTS cas_objects (
  digest TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  is_manifest INTEGER NOT NULL DEFAULT 0 CHECK(is_manifest IN (0, 1)),
  created_at INTEGER NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 0 CHECK(ref_count >= 0)
);

CREATE TABLE IF NOT EXISTS cas_media_roles (
  digest TEXT NOT NULL,
  media_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (digest, media_type),
  FOREIGN KEY (digest) REFERENCES cas_objects(digest)
);

CREATE TABLE IF NOT EXISTS cas_links (
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_type, owner_id, digest),
  FOREIGN KEY (digest) REFERENCES cas_objects(digest)
);

CREATE INDEX IF NOT EXISTS idx_world_events_world_sequence
  ON world_events(world_id, sequence);
CREATE INDEX IF NOT EXISTS idx_world_objects_path
  ON world_objects(world_id, branch_id, path);
CREATE INDEX IF NOT EXISTS idx_world_commits_revision
  ON world_commits(world_id, branch_id, new_revision);
CREATE INDEX IF NOT EXISTS idx_cas_links_digest
  ON cas_links(digest);

CREATE TRIGGER IF NOT EXISTS world_events_append_only_update
BEFORE UPDATE ON world_events
BEGIN
  SELECT RAISE(ABORT, 'WORLD_LEDGER_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS world_events_append_only_delete
BEFORE DELETE ON world_events
BEGIN
  SELECT RAISE(ABORT, 'WORLD_LEDGER_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS world_commits_immutable_update
BEFORE UPDATE ON world_commits
BEGIN
  SELECT RAISE(ABORT, 'WORLD_COMMIT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS cas_objects_immutable_metadata
BEFORE UPDATE OF digest, size, media_type, created_at ON cas_objects
BEGIN
  SELECT RAISE(ABORT, 'CAS_OBJECT_METADATA_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS cas_objects_manifest_monotonic
BEFORE UPDATE OF is_manifest ON cas_objects
WHEN NOT (OLD.is_manifest = 0 AND NEW.is_manifest = 1)
BEGIN
  SELECT RAISE(ABORT, 'CAS_MANIFEST_ATTESTATION_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS cas_media_roles_immutable_update
BEFORE UPDATE ON cas_media_roles
BEGIN
  SELECT RAISE(ABORT, 'CAS_MEDIA_ROLE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS cas_links_immutable_update
BEFORE UPDATE ON cas_links
BEGIN
  SELECT RAISE(ABORT, 'CAS_LINK_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS world_commits_immutable_delete
BEFORE DELETE ON world_commits
BEGIN
  SELECT RAISE(ABORT, 'WORLD_COMMIT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS world_snapshots_immutable_update
BEFORE UPDATE ON world_snapshots
BEGIN
  SELECT RAISE(ABORT, 'WORLD_SNAPSHOT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS world_snapshots_immutable_delete
BEFORE DELETE ON world_snapshots
BEGIN
  SELECT RAISE(ABORT, 'WORLD_SNAPSHOT_IMMUTABLE');
END;
`
