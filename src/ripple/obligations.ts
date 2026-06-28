import { relative, resolve } from "node:path"
import type { RippleCaller, RippleReport } from "./types"

/** Ripple PR 5 (Orcana PR 7): Waiver mechanism — ripple obligations as hard obligations. */
export interface RippleWaiver {
  reason: string
  timestamp: number
}

export interface RippleObligation {
  targetFile: string
  symbol: string
  caller: RippleCaller
  reason: string
  /** PR 7: When set, this obligation is explicitly waived. Must include a reason. */
  waiver?: RippleWaiver
}

export function normalizeProjectPath(path: string, projectRoot = process.cwd()): string {
  const normalized = relative(projectRoot, resolve(projectRoot, path)).replace(/\\/g, "/")
  return normalized || path.replace(/\\/g, "/")
}

export function obligationsFromReport(report: RippleReport, modifiedFiles: Set<string>): RippleObligation[] {
  // PR 2: apiChanges is the canonical change source. changedSymbols is @deprecated.
  if ((report.apiChanges?.length ?? 0) === 0 && report.changedSymbols.length === 0) return []
  if (!report.callers.length) return []
  const obligations: RippleObligation[] = []
  for (const caller of report.callers) {
    const callerFile = normalizeProjectPath(caller.file)
    if (modifiedFiles.has(callerFile)) continue
    obligations.push({
      targetFile: report.targetFile,
      symbol: caller.symbol,
      caller: { ...caller, file: callerFile },
      reason: `${caller.file}:${caller.line} still references changed symbol '${caller.symbol}'.`,
    })
  }
  return obligations
}

export function resolveObligations(existing: RippleObligation[], modifiedFiles: Set<string>): RippleObligation[] {
  return existing.filter(obligation => !modifiedFiles.has(normalizeProjectPath(obligation.caller.file)))
}

export function mergeObligations(existing: RippleObligation[], next: RippleObligation[]): RippleObligation[] {
  const byKey = new Map<string, RippleObligation>()
  for (const obligation of [...existing, ...next]) {
    byKey.set(`${obligation.targetFile}:${obligation.symbol}:${obligation.caller.file}:${obligation.caller.line}`, obligation)
  }
  return [...byKey.values()]
}

export function formatRippleExitGate(obligations: RippleObligation[]): string {
  const lines = [
    "## Ripple Exit Gate",
    "You cannot finish yet. The latest Ripple report still has unsynchronized callers.",
    "Before finalizing, read or update these callers, or explicitly prove why each caller is still compatible.",
    "",
    "Pending callers:",
  ]

  for (const obligation of obligations.slice(0, 12)) {
    lines.push(`- ${obligation.caller.file}:${obligation.caller.line} uses ${obligation.symbol} from ${obligation.targetFile}`)
    lines.push(`  code: ${obligation.caller.text.slice(0, 160)}`)
  }

  lines.push("")
  lines.push("Required next step:")
  lines.push("1. Inspect the pending caller files.")
  lines.push("2. Prepare one multi_edit cascade that updates the target and affected callers together.")
  lines.push("3. Verify with typecheck/tests.")
  lines.push("4. If the cascade write fails verification and repair is riskier than revert, use rollback_transaction with the returned transactionId.")
  return lines.join("\n")
}

// ── PR 7: Waiver mechanism — ripple obligations as hard obligations ──

/** Waive a ripple obligation. Returns a new obligation with waiver attached.
 *  An empty or whitespace-only reason is rejected (returns the obligation unchanged).
 *  This enforces "waiver 必须有 reason" — no silent dismissal. */
export function waiveObligation(obligation: RippleObligation, reason: string): RippleObligation {
  if (!reason.trim()) return obligation
  return {
    ...obligation,
    waiver: { reason: reason.trim(), timestamp: Date.now() },
  }
}

/** True when this obligation still blocks completion (not waived). */
export function isObligationBlocking(obligation: RippleObligation): boolean {
  return !obligation.waiver
}

/** Filter to only blocking (non-waived) obligations. */
export function getBlockingObligations(obligations: RippleObligation[]): RippleObligation[] {
  return obligations.filter(isObligationBlocking)
}

/** Format waived obligations for status display (audit trail). */
export function formatWaivedObligations(obligations: RippleObligation[]): string {
  const waived = obligations.filter(o => o.waiver)
  if (waived.length === 0) return ""
  const lines = ["## Waived Ripple Obligations"]
  for (const o of waived) {
    lines.push(`- ${o.caller.file}:${o.caller.line} ${o.symbol}: ${o.waiver!.reason}`)
  }
  return lines.join("\n")
}
