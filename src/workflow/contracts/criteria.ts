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

// ── R5: 沙盒完成条件（审计 §26 类型化 Criterion） ──

/** 沙盒执行证据必须存在且通过（receipt 完整入账）。 */
export const SANDBOX_EXECUTION_CRITERION: CompletionCriterion = {
  id: "sys.sandbox_execution",
  title: "存在通过验证的沙盒执行证据（完整 Receipt）",
  hard: true,
  mode: "deterministic",
  check: { type: "evidence", evidenceKind: "sandbox_execution" },
}

/** 隔离后端必须达到 namespace 级（bubblewrap/podman，非 host-audit）。 */
export const SANDBOX_BACKEND_CRITERION: CompletionCriterion = {
  id: "sys.sandbox_backend",
  title: "执行后端 >= namespace 级（无 host-audit）",
  hard: true,
  mode: "deterministic",
  check: { type: "evidence", evidenceKind: "sandbox_execution" },
  description: "由证据的 backend 字段判定：backend ∈ {bubblewrap, rootless-podman} 且 degraded=false",
}

/** 严格任务禁止降级。 */
export const SANDBOX_NO_DEGRADATION_CRITERION: CompletionCriterion = {
  id: "sys.sandbox_no_degradation",
  title: "严格任务无降级",
  hard: true,
  mode: "deterministic",
  check: { type: "evidence", evidenceKind: "sandbox_execution" },
  description: "由证据的 degraded=false 判定；host-audit 或降级 = 不满足",
}

/** 资源限制已施加（cgroup 绑定）。 */
export const SANDBOX_RESOURCE_LIMIT_CRITERION: CompletionCriterion = {
  id: "sys.resource_limit_applied",
  title: "资源限制已施加",
  hard: false,
  mode: "deterministic",
  check: { type: "evidence", evidenceKind: "sandbox_execution" },
  description: "由证据的 cleanupVerified 与 Receipt metrics 判定",
}

/** 网络隔离（none 模式）。 */
export const SANDBOX_NETWORK_ISOLATED_CRITERION: CompletionCriterion = {
  id: "sys.network_isolated",
  title: "执行网络隔离（none）",
  hard: false,
  mode: "deterministic",
  check: { type: "evidence", evidenceKind: "sandbox_execution" },
  description: "由证据的 networkMode=none 判定",
}

/** 清理已验证（进程归零 + cgroup 移除）。 */
export const SANDBOX_CLEANUP_CRITERION: CompletionCriterion = {
  id: "sys.sandbox_cleanup_verified",
  title: "清理已验证",
  hard: true,
  mode: "deterministic",
  check: { type: "evidence", evidenceKind: "sandbox_cleanup" },
}
