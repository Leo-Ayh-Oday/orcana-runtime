/** MACP-M6: CompletionCriterion — 类型化完成条件.
 *
 *  Every criterion carries a stable ID (task 2), hard/soft weight (task 3)
 *  and deterministic/semantic mode (task 4). Conditions that cannot be
 *  verified automatically MUST be declared `semantic_review` (task 8);
 *  natural-language conditions must never be smuggled into grep-style
 *  checks (task 9 — `file_content.contains` is a bounded, explicit
 *  deterministic check, not a general escape hatch).
 */

import type { VerificationKind } from "../../verification/result"

export type CriterionWeight = "hard" | "soft"
export type CriterionMode = "deterministic" | "semantic"

export type CriterionCheck =
  | { type: "command"; command: string; verificationKind?: VerificationKind }
  | { type: "file_exists"; path: string }
  | { type: "file_content"; path: string; contains: string }
  | { type: "evidence"; evidenceKind: string }
  | { type: "semantic_review"; reviewer: string; guidance: string }

export interface CompletionCriterion {
  /** Stable ID — bound to plan versions (task 11); unique per contract. */
  id: string
  title: string
  /** hard = blocking completion; soft = adjudication may override. */
  hard: boolean
  /** deterministic = machine-checkable; semantic = human review required. */
  mode: CriterionMode
  /** Present for deterministic criteria; `semantic_review` for semantic. */
  check?: CriterionCheck
  description?: string
}

export const CRITERION_ID_PATTERN = /^[a-z][a-z0-9_.-]{2,63}$/

/** Criteria that can never auto-pass: human adjudication is the only
 *  resolution. `semantic_review` carries the reviewer role + guidance. */
export function isSemanticReview(criterion: CompletionCriterion): boolean {
  return criterion.check?.type === "semantic_review" || criterion.mode === "semantic"
}

/** The default hard criterion every write task inherits (task 7: key
 *  permission/security conditions are automatically hard). */
export const AUTO_SECURITY_CRITERION: CompletionCriterion = {
  id: "sys.ownership_and_no_escape",
  title: "写路径符合所有权约束且无路径逃逸",
  hard: true,
  mode: "deterministic",
  check: { type: "evidence", evidenceKind: "ownership" },
  description: "M3 ownership policy + escape defenses must have produced passing evidence",
}
