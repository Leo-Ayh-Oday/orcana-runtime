/** [PR 9] Replay Harness — deterministic agent scenario replay infrastructure.
 *
 *  Each replay case records: input → function call → expected output.
 *  The harness loads cases from JSON, sets up fixtures (filesystem state,
 *  module-level mutable state), calls the target function, and validates
 *  the output against the expected result.
 *
 *  Domains covered: master_plan, context_epoch, false_done, ripple, patch_transaction.
 *
 *  Case format (JSON):
 *    {
 *      "caseId": "master-plan-01",
 *      "domain": "master_plan",
 *      "description": "...",
 *      "targetFunction": "createMasterPlan",
 *      "input": { ... },
 *      "fixture": { "path/to/file": "content", ... },
 *      "expected": { ... }
 *    }
 */

import type { EvidenceKind } from "./evidence-ledger"

// ── Domain ──

export type ReplayDomain = "master_plan" | "context_epoch" | "false_done" | "ripple" | "patch_transaction" | "context_memory" | "context_map"

// ── ReplayExpected — discriminated union for expected outcomes ──

export interface ReplayExpectedBase {
  /** Which domain this expected result belongs to. */
  domain: ReplayDomain
  /** Human-readable description of what this case validates. */
  description: string
}

/** MasterPlan replay outcomes. */
export interface MasterPlanReplayExpected extends ReplayExpectedBase {
  domain: "master_plan"
  /** The function that was called. */
  targetFunction: string
  /** Whether the operation succeeded. */
  success: boolean
  /** For plan creation: expected node count. */
  nodeCount?: number
  /** For plan completion: expected done/total counts. */
  progress?: { done: number; total: number }
  /** For validation: expected error/warning counts. */
  validation?: { errors: number; warnings: number }
  /** For node transition: expected new status. */
  nodeStatus?: string
  /** Key assertions that must hold (checked by harness). */
  assertions: string[]
}

/** ContextEpoch replay outcomes. */
export interface ContextEpochReplayExpected extends ReplayExpectedBase {
  domain: "context_epoch"
  targetFunction: string
  /** Expected epoch action. */
  action: "none" | "compress" | "forceCompress" | "rollover"
  /** For rollover: expected chars trimmed. */
  charsTrimmed?: number
  /** Whether rollover was blocked by unclosed tool chain. */
  rolloverBlocked?: boolean
  /** Whether plan state was preserved after rollover. */
  planStatePreserved?: boolean
  assertions: string[]
}

/** False-done (completion gate) replay outcomes. */
export interface FalseDoneReplayExpected extends ReplayExpectedBase {
  domain: "false_done"
  targetFunction: string
  /** Whether completion was allowed. */
  allowed: boolean
  /** Expected missing items when blocked. */
  expectedMissing?: string[]
  /** Expected residual risks. */
  expectedRisks?: string[]
  assertions: string[]
}

/** Ripple replay outcomes. */
export interface RippleReplayExpected extends ReplayExpectedBase {
  domain: "ripple"
  targetFunction: string
  /** Number of obligations created/remaining. */
  obligationCount: number
  /** Number of blocking obligations. */
  blockingCount: number
  /** Whether specific obligation is waived. */
  hasWaiver?: boolean
  assertions: string[]
}

/** PatchTransaction replay outcomes. */
export interface PatchTransactionReplayExpected extends ReplayExpectedBase {
  domain: "patch_transaction"
  targetFunction: string
  /** Whether the write/check was allowed. */
  allowed: boolean
  /** Reason for blocking (if not allowed). */
  blockReason?: string
  /** Expected diff stats. */
  diffStats?: { added: number; removed: number; unchanged: number }
  assertions: string[]
}

/** Context Memory replay outcomes. */
export interface ContextMemoryReplayExpected extends ReplayExpectedBase {
  domain: "context_memory"
  targetFunction: string
  success: boolean
  mustLoadCount?: number
  maybeLoadCount?: number
  doNotLoadCount?: number
  addCount?: number
  updateCount?: number
  markStaleCount?: number
  archiveCount?: number
  telemetryTotal?: number
  averageHitRate?: number
  contextSections?: number
  assertions: string[]
}

/** Context Map replay outcomes. */
export interface ContextMapReplayExpected extends ReplayExpectedBase {
  domain: "context_map"
  targetFunction: string
  success: boolean
  primaryFileCount?: number
  evidenceCount?: number
  blockerCount?: number
  contextSections?: number
  taskLevel?: string
  assertions: string[]
}

export type ReplayExpected =
  | MasterPlanReplayExpected
  | ContextEpochReplayExpected
  | FalseDoneReplayExpected
  | RippleReplayExpected
  | PatchTransactionReplayExpected
  | ContextMemoryReplayExpected
  | ContextMapReplayExpected

// ── ReplayCase — full case definition ──

export interface ReplayCase {
  caseId: string
  domain: ReplayDomain
  description: string
  targetFunction: string
  /** Input parameters for the target function (serializable). */
  input: Record<string, unknown>
  /** Filesystem fixture: { relativePath: "file content" }. */
  fixture?: Record<string, string>
  /** Expected outcome (must conform to ReplayExpected). */
  expected: ReplayExpected
  /** Tags for filtering (e.g. ["smoke", "integration"]). */
  tags?: string[]
}

// ── Replay result ──

export interface ReplayResult {
  caseId: string
  passed: boolean
  expected: ReplayExpected
  actual?: unknown
  error?: string
  durationMs: number
}

// ── Replay suite ──

export interface ReplaySuite {
  name: string
  cases: ReplayCase[]
}

// ── Harness utilities ──

/** Validate that a ReplayCase's expected field matches its domain. */
export function validateReplayCase(c: ReplayCase): string[] {
  const issues: string[] = []
  if (!c.caseId) issues.push("missing caseId")
  if (!c.domain) issues.push("missing domain")
  if (!c.targetFunction) issues.push("missing targetFunction")
  if (!c.expected) issues.push("missing expected")
  if (c.expected.domain !== c.domain) {
    issues.push(`domain mismatch: case domain=${c.domain}, expected domain=${c.expected.domain}`)
  }
  return issues
}

/** Domain labels for reporting. */
export const DOMAIN_LABELS: Record<ReplayDomain, string> = {
  master_plan: "MasterPlan",
  context_epoch: "Context Epoch",
  false_done: "False Done",
  ripple: "Ripple",
  patch_transaction: "PatchTransaction",
  context_memory: "Context Memory",
  context_map: "Context Map",
}

/** Assertion helper: checks all string assertions in expected against actual data. */
export function checkAssertions(expected: ReplayExpected, context: Record<string, unknown>): string[] {
  const failures: string[] = []
  for (const assertion of expected.assertions) {
    const parsed = parseAssertion(assertion)
    if (!parsed) continue
    const { key, op, value } = parsed
    const actual = resolvePath(context, key)
    switch (op) {
      case "exists":
        if (actual === undefined || actual === null) {
          failures.push(`assertion failed: "${key}" should exist`)
        }
        break
      case "not_exists":
        if (actual !== undefined && actual !== null) {
          failures.push(`assertion failed: "${key}" should not exist, got "${String(actual)}"`)
        }
        break
      case "equals":
        if (String(actual) !== String(value)) {
          failures.push(`assertion failed: "${key}" expected "${value}", got "${actual}"`)
        }
        break
      case "matches": {
        const re = parseRegex(value ?? "")
        if (!re) {
          failures.push(`assertion failed: "${key}" has invalid regex "${value}"`)
        } else if (!re.test(String(actual ?? ""))) {
          failures.push(`assertion failed: "${key}" should match ${value}, got "${String(actual)}"`)
        }
        break
      }
      case "gt":
        if (Number(actual) <= Number(value)) {
          failures.push(`assertion failed: "${key}" expected > ${value}, got ${actual}`)
        }
        break
      case "gte":
        if (Number(actual) < Number(value)) {
          failures.push(`assertion failed: "${key}" expected >= ${value}, got ${actual}`)
        }
        break
      case "contains":
        if (!String(actual).includes(String(value))) {
          failures.push(`assertion failed: "${key}" should contain "${value}", got "${actual}"`)
        }
        break
      case "length": {
        const len = Array.isArray(actual) ? actual.length : String(actual ?? "").length
        const { cmp, target } = parseLength(value ?? "")
        if (cmp === "eq" && len !== target) failures.push(`assertion failed: "${key}" length expected ${target}, got ${len}`)
        if (cmp === "gte" && len < target) failures.push(`assertion failed: "${key}" length expected >= ${target}, got ${len}`)
        if (cmp === "gt" && len <= target) failures.push(`assertion failed: "${key}" length expected > ${target}, got ${len}`)
        break
      }
      case "contains_set": {
        const expectedItems = (value ?? "").split(",").map((s) => s.trim()).filter(Boolean)
        const actualItems = Array.isArray(actual) ? actual.map((x) => String(x)) : []
        const missing = expectedItems.filter((item) => !actualItems.includes(item))
        if (missing.length > 0) {
          failures.push(`assertion failed: "${key}" should contain {${missing.join(", ")}}, got [${actualItems.join(", ")}]`)
        }
        break
      }
    }
  }
  return failures
}

/** Resolve a dot-separated path (a.b.0.c) into nested objects/arrays.
 *  Flat literal keys take priority (the legacy assertion context flattens
 *  e.g. "nodes.length" as a literal key); nested resolution is the extension
 *  path for §18.1. */
export function resolvePath(context: Record<string, unknown>, path: string): unknown {
  if (path in context) return context[path]
  let current: unknown = context
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      const index = Number(segment)
      current = Number.isInteger(index) ? current[index] : undefined
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[segment]
    } else {
      return undefined
    }
  }
  return current
}

function parseRegex(value: string): RegExp | null {
  const match = value.match(/^\/(.+)\/([a-z]*)$/)
  if (!match) return null
  try {
    return new RegExp(match[1]!, match[2])
  } catch {
    return null
  }
}

function parseLength(value: string): { cmp: "eq" | "gte" | "gt"; target: number } {
  const eq = value.match(/^==\s*(\d+)$/)
  if (eq) return { cmp: "eq", target: Number(eq[1]) }
  const gte = value.match(/^>=\s*(\d+)$/)
  if (gte) return { cmp: "gte", target: Number(gte[1]) }
  const gt = value.match(/^>\s*(\d+)$/)
  if (gt) return { cmp: "gt", target: Number(gt[1]) }
  return { cmp: "eq", target: Number(value) || 0 }
}

function parseAssertion(a: string): { key: string; op: string; value?: string } | null {
  // Patterns:
  //   "key exists" / "key not exists"
  //   "key equals value" / "key matches /re/"
  //   "key > N" / "key >= N"
  //   "key contains value" / "key contains-set a,b,c"
  //   "key length == N" / "key length >= N"
  const notExistsMatch = a.match(/^(\S+)\s+not\s+exists$/i)
  if (notExistsMatch) return { key: notExistsMatch[1]!, op: "not_exists" }

  const existsMatch = a.match(/^(\S+)\s+exists$/i)
  if (existsMatch) return { key: existsMatch[1]!, op: "exists" }

  const matchesMatch = a.match(/^(\S+)\s+matches\s+(\/.+\/[a-z]*)$/i)
  if (matchesMatch) return { key: matchesMatch[1]!, op: "matches", value: matchesMatch[2]! }

  const equalsMatch = a.match(/^(\S+)\s+equals\s+(.+)$/i)
  if (equalsMatch) return { key: equalsMatch[1]!, op: "equals", value: equalsMatch[2]! }

  const lengthMatch = a.match(/^(\S+)\s+length\s+(==\s*\d+|>=\s*\d+|>\s*\d+|\d+)$/i)
  if (lengthMatch) return { key: lengthMatch[1]!, op: "length", value: lengthMatch[2]! }

  const setMatch = a.match(/^(\S+)\s+contains-set\s+(.+)$/i)
  if (setMatch) return { key: setMatch[1]!, op: "contains_set", value: setMatch[2]! }

  const gtMatch = a.match(/^(\S+)\s*>\s*(\d+)$/)
  if (gtMatch) return { key: gtMatch[1]!, op: "gt", value: gtMatch[2]! }

  const gteMatch = a.match(/^(\S+)\s*>=\s*(\d+)$/)
  if (gteMatch) return { key: gteMatch[1]!, op: "gte", value: gteMatch[2]! }

  const containsMatch = a.match(/^(\S+)\s+contains\s+(.+)$/i)
  if (containsMatch) return { key: containsMatch[1]!, op: "contains", value: containsMatch[2]! }

  return null
}
