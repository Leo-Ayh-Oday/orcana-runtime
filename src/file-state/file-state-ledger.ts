import type { FileFingerprint } from "./file-fingerprint"

export type FileReadRange =
  | { kind: "full" }
  | { kind: "range"; startLine: number; endLine: number }

export type FileStateSource =
  | "read_file"
  | "agent_write"
  | "external_change"
  | "session_restore"

export type FileStateStatus =
  | "fresh"
  | "changed"
  | "stale"
  | "partial"
  | "truncated"
  | "deleted"
  | "missing"

export interface FileStateRecord {
  path: string
  readRange: FileReadRange
  totalLines?: number
  baseline: FileFingerprint
  baselinePreview: string
  source: FileStateSource
  status: FileStateStatus
  lastCheckedAt: number
  createdAt: number
}

export interface FreshnessCheckResult {
  ok: boolean
  status: FileStateStatus
  reason?: string
  current?: FileFingerprint
  record?: FileStateRecord
}

function preview(content: string): string {
  return content.slice(0, 240)
}

function statusForRead(range: FileReadRange, truncated?: boolean): FileStateStatus {
  if (truncated) return "truncated"
  if (range.kind === "range") return "partial"
  return "fresh"
}

export class FileStateLedger {
  private readonly records = new Map<string, FileStateRecord>()
  private readonly now: () => number

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now())
  }

  recordRead(input: {
    path: string
    range: FileReadRange
    content: string
    totalLines?: number
    fingerprint: FileFingerprint
    truncated?: boolean
  }): FileStateRecord {
    const existing = this.records.get(input.path)
    const now = this.now()
    const record: FileStateRecord = {
      path: input.path,
      readRange: input.range,
      totalLines: input.totalLines,
      baseline: input.fingerprint,
      baselinePreview: preview(input.content),
      source: "read_file",
      status: statusForRead(input.range, input.truncated),
      createdAt: existing?.createdAt ?? now,
      lastCheckedAt: now,
    }
    this.records.set(input.path, record)
    return record
  }

  recordAgentWrite(input: {
    path: string
    content: string
    fingerprint: FileFingerprint
  }): FileStateRecord {
    const existing = this.records.get(input.path)
    const now = this.now()
    const record: FileStateRecord = {
      path: input.path,
      readRange: { kind: "full" },
      baseline: input.fingerprint,
      baselinePreview: preview(input.content),
      source: "agent_write",
      status: "fresh",
      createdAt: existing?.createdAt ?? now,
      lastCheckedAt: now,
    }
    this.records.set(input.path, record)
    return record
  }

  get(path: string): FileStateRecord | undefined {
    return this.records.get(path)
  }

  checkFresh(path: string, current: FileFingerprint | null): FreshnessCheckResult {
    const record = this.records.get(path)
    if (!record) {
      return { ok: false, status: "missing", reason: "no file state baseline", current: current ?? undefined }
    }
    const now = this.now()
    if (!current) {
      const deleted = { ...record, status: "deleted" as const, lastCheckedAt: now }
      this.records.set(path, deleted)
      return { ok: false, status: "deleted", reason: "file is missing on disk", record: deleted }
    }
    if (record.baseline.sha256 !== current.sha256) {
      const stale = { ...record, source: "external_change" as const, status: "stale" as const, lastCheckedAt: now }
      this.records.set(path, stale)
      return { ok: false, status: "stale", reason: "disk content changed since baseline", current, record: stale }
    }
    const fresh = { ...record, status: statusForRead(record.readRange, record.status === "truncated"), lastCheckedAt: now }
    this.records.set(path, fresh)
    return { ok: true, status: fresh.status, current, record: fresh }
  }

  markExternalChange(path: string, _current: FileFingerprint): FileStateRecord | undefined {
    const record = this.records.get(path)
    if (!record) return undefined
    const next: FileStateRecord = {
      ...record,
      source: "external_change",
      status: "stale",
      lastCheckedAt: this.now(),
    }
    this.records.set(path, next)
    return next
  }

  list(): FileStateRecord[] {
    return [...this.records.values()].sort((a, b) => a.path.localeCompare(b.path))
  }
}
