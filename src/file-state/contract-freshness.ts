import { isAbsolute, relative, resolve } from "node:path"
import type { ToolContract } from "../tools/tool-contract"
import { inspectFileTarget, readFileSnapshot } from "./file-fingerprint"
import type { FileStateStatus } from "./file-state-ledger"
import { validateFreshnessForEdit } from "./freshness-gate"
import { getRuntimeFileStateLedger } from "./runtime-file-state"

export interface ToolFreshnessApproval {
  readonly expectedBaseHashes: Readonly<Record<string, string | null>>
  readonly approvedContents: Readonly<Record<string, string | null>>
}

export type ToolContractFreshnessResult =
  | { ok: true; approval: ToolFreshnessApproval }
  | { ok: false; path: string; status: FileStateStatus; reason: string }

const EMPTY_APPROVAL: ToolFreshnessApproval = Object.freeze({
  expectedBaseHashes: Object.freeze({}),
  approvedContents: Object.freeze({}),
})

const MAX_FRESHNESS_TARGETS = 128
const MAX_APPROVED_FILE_BYTES = 16 * 1024 * 1024
const MAX_APPROVED_TOTAL_BYTES = 32 * 1024 * 1024
const SNAPSHOT_CONCURRENCY = 8

function visitValuesAtParameterPath(
  params: Record<string, unknown>,
  parameterPath: string,
  visit: (value: unknown) => boolean,
): boolean {
  const segments = parameterPath.split(".")
  let found = false
  const walk = (value: unknown, index: number): boolean => {
    if (index >= segments.length) {
      found = true
      return visit(value)
    }
    if (!value || typeof value !== "object") return true
    const segment = segments[index]!
    const isArray = segment.endsWith("[]")
    const key = isArray ? segment.slice(0, -2) : segment
    const child = (value as Record<string, unknown>)[key]
    if (isArray) {
      if (!Array.isArray(child)) return true
      for (const item of child) {
        if (!walk(item, index + 1)) return false
      }
      return true
    }
    return child === undefined ? true : walk(child, index + 1)
  }
  walk(params, 0)
  return found
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index]!)
    }
  })
  await Promise.all(runners)
  return results
}

function safeDisplayPath(parameterPath: string, value: string, canonicalPath: string): string {
  if (!isAbsolute(value) && !value.replace(/\\/g, "/").startsWith("../")) return value
  const workspaceRelative = relative(process.cwd(), canonicalPath)
  if (workspaceRelative && !workspaceRelative.startsWith("..") && !isAbsolute(workspaceRelative)) {
    return workspaceRelative.replace(/\\/g, "/")
  }
  return parameterPath
}

/** Enforce the state requirement declared by a canonical ToolContract. */
export async function validateToolContractFreshness(
  contract: ToolContract,
  params: Record<string, unknown>,
  options: { abortSignal?: AbortSignal } = {},
): Promise<ToolContractFreshnessResult> {
  const requirement = contract.state.requirement
  if (requirement === "none") return { ok: true, approval: EMPTY_APPROVAL }
  if (contract.path.parameters.length === 0) {
    return {
      ok: false,
      path: "path",
      status: "missing",
      reason: "freshness requirement declares no path parameters",
    }
  }

  const ledger = getRuntimeFileStateLedger()
  const targets = new Map<string, { displayPath: string; canonicalPath: string }>()
  for (const parameter of contract.path.parameters) {
    let invalid: ToolContractFreshnessResult | undefined
    const found = visitValuesAtParameterPath(params, parameter, value => {
      if (typeof value !== "string" || value.trim().length === 0) {
        invalid = { ok: false, path: parameter, status: "missing", reason: `path parameter ${parameter} must be a non-empty string` }
        return false
      }
      const canonicalPath = resolve(value)
      targets.set(canonicalPath, {
        displayPath: safeDisplayPath(parameter, value, canonicalPath),
        canonicalPath,
      })
      if (targets.size > MAX_FRESHNESS_TARGETS) {
        invalid = {
          ok: false,
          path: contract.path.parameters[0] ?? "path",
          status: "changed",
          reason: `freshness target limit exceeded (${targets.size}/${MAX_FRESHNESS_TARGETS}); split the operation`,
        }
        return false
      }
      return true
    })
    if (invalid) return invalid
    if (!found) {
      return { ok: false, path: parameter, status: "missing", reason: `path parameter ${parameter} is required` }
    }
  }

  options.abortSignal?.throwIfAborted()
  const targetList = [...targets.values()]
  const inspections = await mapWithConcurrency(targetList, SNAPSHOT_CONCURRENCY, async target => ({
    target,
    info: await inspectFileTarget(target.canonicalPath),
  }))
  let totalBytes = 0
  for (const { target, info } of inspections) {
    if (info.state === "unreadable" || info.state === "non_file") {
      return {
        ok: false,
        path: target.displayPath,
        status: "changed",
        reason: info.state === "non_file" ? "target is not a regular file" : "target exists but cannot be read safely",
      }
    }
    if (info.state !== "file") continue
    if (info.size > MAX_APPROVED_FILE_BYTES) {
      return {
        ok: false,
        path: target.displayPath,
        status: "changed",
        reason: `freshness snapshot exceeds per-file byte budget (${info.size}/${MAX_APPROVED_FILE_BYTES}); split or narrow the operation`,
      }
    }
    totalBytes += info.size
    if (totalBytes > MAX_APPROVED_TOTAL_BYTES) {
      return {
        ok: false,
        path: target.displayPath,
        status: "changed",
        reason: `freshness snapshots exceed total byte budget (${totalBytes}/${MAX_APPROVED_TOTAL_BYTES}); split the operation`,
      }
    }
  }

  const expectedBaseHashes: Record<string, string | null> = {}
  const approvedContents: Record<string, string | null> = {}
  let reservedSnapshotBytes = 0
  const byteBudget = {
    tryReserve(bytes: number): boolean {
      if (reservedSnapshotBytes + bytes > MAX_APPROVED_TOTAL_BYTES) return false
      reservedSnapshotBytes += bytes
      return true
    },
    release(bytes: number): void {
      reservedSnapshotBytes -= bytes
    },
  }
  const snapshots = await mapWithConcurrency(targetList, SNAPSHOT_CONCURRENCY, async target => ({
    target,
    snapshot: await readFileSnapshot(target.canonicalPath, {
      maxBytes: MAX_APPROVED_FILE_BYTES,
      signal: options.abortSignal,
      byteBudget,
    }),
  }))
  for (const { target: { displayPath, canonicalPath }, snapshot } of snapshots) {
    if (snapshot.state !== "file" && snapshot.state !== "absent") {
      return {
        ok: false,
        path: displayPath,
        status: "changed",
        reason: snapshot.state === "non_file"
          ? "target is not a regular file"
          : snapshot.state === "changed"
            ? "target changed while collecting the freshness snapshot"
            : snapshot.state === "too_large"
              ? "target exceeded the freshness snapshot byte budget while being read"
              : snapshot.state === "budget_exceeded"
                ? "freshness snapshots exceeded the total byte budget while being read"
                : "target exists but cannot be read safely",
      }
    }
    const current = snapshot.state === "file" ? snapshot.fingerprint : null
    const knownBaseline = ledger.get(canonicalPath)
    const result = validateFreshnessForEdit(ledger, {
      path: canonicalPath,
      operation: requirement === "fresh_full_baseline_if_existing"
        ? current || knownBaseline ? "overwrite" : "create"
        : "patch",
      requiresFullBaseline: true,
      allowsPartialBaseline: false,
    }, current)

    if (!result.ok) {
      return {
        ok: false,
        path: displayPath,
        status: result.status,
        reason: result.reason ?? "fresh full-file baseline is required",
      }
    }
    expectedBaseHashes[canonicalPath] = current ? current.sha256.slice(0, 16) : null
    approvedContents[canonicalPath] = snapshot.state === "file" ? snapshot.content : null
  }

  return {
    ok: true,
    approval: Object.freeze({
      expectedBaseHashes: Object.freeze(expectedBaseHashes),
      approvedContents: Object.freeze(approvedContents),
    }),
  }
}
