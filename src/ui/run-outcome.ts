/** TB2-1: run outcome classification for the CLI.
 *
 *  The CLI must never infer delivery from streamed text. Every turn ends in a
 *  structured RunTurnResult derived from the harness run.* lifecycle events;
 *  the single-shot exit code comes from exitCodeForRunStatus():
 *    0  completed（真正交付）
 *    2  paused（暂停/未完成——可 Resume）
 *    3  blocked/stalled
 *    4  failed（Provider 失败等）
 */

import type { RunStatus } from "../harness/contracts/run"
import type { SessionCheckpoint } from "../session/checkpoint"

export interface RunTurnResult {
  status: "completed" | "paused" | "blocked" | "failed"
  runId: string
  reason: string
  checkpointId: string
}

/** Map a terminal/stopped run status to the CLI outcome vocabulary. */
export function classifyRunStatus(status: RunStatus): RunTurnResult["status"] {
  switch (status) {
    case "completed":
      return "completed"
    case "paused":
    case "waiting":
      // waiting（澄清/计划审批）与 paused 一样都是"未完成，可继续"。
      return "paused"
    case "blocked":
    case "cancelled":
      return "blocked"
    case "failed":
    case "restart_required":
      return "failed"
    default:
      // created/initializing/running/resuming/pausing 出现在终态视为异常。
      return "blocked"
  }
}

export function exitCodeForRunStatus(status: RunTurnResult["status"]): number {
  switch (status) {
    case "completed":
      return 0
    case "paused":
      return 2
    case "blocked":
      return 3
    case "failed":
      return 4
  }
}

const KNOWN_STEP_STATUSES = new Set(["pending", "running", "done", "failed", "cancelled"])

/**
 * Resume 校验（TB2-1）：检查 checkpoint 的任务步骤数/当前步骤/修改文件
 * 是否自洽。失败时 CLI 必须显式输出 RESUME_REJECTED，不得静默新建任务。
 */
export function validateResumeCheckpoint(cp: SessionCheckpoint): { ok: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (!cp.checkpointId) reasons.push("checkpointId 缺失")
  if (cp.round <= 0) reasons.push(`无效轮次 ${cp.round}`)

  const hasMasterPlanNodes = Array.isArray((cp.masterPlan as { nodes?: unknown[] } | undefined)?.nodes)
    && ((cp.masterPlan as { nodes: unknown[] }).nodes.length ?? 0) > 0
  if (cp.taskSteps.length === 0 && !hasMasterPlanNodes) {
    reasons.push("无任务步骤可恢复")
  }
  if (cp.taskSteps.length > 0) {
    const done = cp.taskSteps.filter(s => s.status === "done").length
    if (done < 0 || done > cp.taskSteps.length) reasons.push("步骤完成数越界")
    for (const step of cp.taskSteps) {
      if (!KNOWN_STEP_STATUSES.has(step.status)) reasons.push(`非法步骤状态 ${step.status}（${step.title}）`)
    }
    if (done === cp.taskSteps.length) {
      reasons.push("checkpoint 已全部完成，无可恢复步骤")
    }
  }

  // 修改文件一致性：fileSHAs 记录的文件必须都在 changedFiles 中声明过。
  const shaKeys = Object.keys(cp.fileSHAs)
  const changedSet = new Set(cp.changedFiles)
  if (shaKeys.length > 0 && cp.changedFiles.length === 0) {
    reasons.push("修改文件记录不一致（fileSHAs 有记录但 changedFiles 为空）")
  }
  for (const file of shaKeys) {
    if (!changedSet.has(file)) reasons.push(`修改文件记录不一致（${file} 未在 changedFiles 中）`)
  }

  return { ok: reasons.length === 0, reasons }
}
