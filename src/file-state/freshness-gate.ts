import type { FileFingerprint } from "./file-fingerprint"
import type { FileStateLedger, FreshnessCheckResult } from "./file-state-ledger"

export interface EditFreshnessRequirement {
  path: string
  operation: "patch" | "overwrite" | "create"
  requiresFullBaseline: boolean
  allowsPartialBaseline: boolean
}

function blocked(status: FreshnessCheckResult["status"], reason: string, base?: FreshnessCheckResult): FreshnessCheckResult {
  return {
    ok: false,
    status,
    reason,
    current: base?.current,
    record: base?.record,
  }
}

export function validateFreshnessForEdit(
  ledger: FileStateLedger,
  requirement: EditFreshnessRequirement,
  currentFingerprint: FileFingerprint | null,
): FreshnessCheckResult {
  if (requirement.operation === "create") {
    if (currentFingerprint) {
      return blocked("changed", "create operation targets an existing file")
    }
    return { ok: true, status: "missing", reason: "new file has no prior baseline" }
  }

  const result = ledger.checkFresh(requirement.path, currentFingerprint)
  if (!result.ok) return result

  const record = result.record
  if (!record) return blocked("missing", "no file state baseline", result)

  if (record.status === "truncated") {
    return blocked("truncated", "truncated baseline cannot authorize edits", result)
  }

  if (requirement.requiresFullBaseline && record.readRange.kind !== "full") {
    return blocked("partial", "full-file baseline is required", result)
  }

  if (!requirement.allowsPartialBaseline && record.readRange.kind !== "full") {
    return blocked("partial", "partial baseline is not allowed for this edit", result)
  }

  if (requirement.operation === "overwrite" && record.readRange.kind !== "full") {
    return blocked("partial", "overwrite requires a fresh full baseline", result)
  }

  return result
}
