/** GATE-03: ProgressGovernor — run-scoped liveness controller.
 *
 *  The OTS-013 loop had no liveness semantics: rounds were retried without
 *  any question of whether the run actually progressed. This governor answers
 *  that question deterministically:
 *
 *    streak 1  → NO_PROGRESS (recorded, trace only)
 *    streak 2  → ACTION_FIRST (reasoning lowered, one executable action
 *                demanded — no planning text allowed)
 *    streak 3  → REPLAN_ONCE (a different prompt; the same nudge is never
 *                injected again — GS-02)
 *    streak 4+ → STALLED (terminate with a full diagnosis — GS-01)
 *
 *  Progress is defined by state change only: tool calls committed, writes,
 *  file set growth, completed steps/obligations, evidence entries, plan node
 *  transition. "The model wrote 4000 more tokens" is NOT progress.
 */

import type { ProviderMessage } from "../../provider/types"

export interface ProgressSnapshot {
  round: number
  /** Tool calls handed to the executor this round. */
  toolCallsCommitted: number
  /** Of those, non-readonly (write-class) tool calls. */
  writeToolsCommitted: number
  /** Tracked workspace file set size (growth = real artifact change). */
  fileCount: number
  /** Master-plan nodes in status "done". */
  completedNodes: number
  /** TaskTracker steps in status "done". */
  completedSteps: number
  /** Evidence ledger entry count (verification artifacts). */
  evidenceEntries: number
  /** Currently active master-plan node id (transition = forward motion). */
  currentNode: string
  /** Digest of pending obligations — identical digests across rounds mean
   *  the same blocker is being re-litigated (GS-02). Not itself progress. */
  pendingObligationDigest: string
}

export type GovernorDecision =
  | { action: "proceed" }
  | { action: "action_first" }
  | { action: "replan_once" }
  | { action: "stalled"; report: string }

/** Only these fields decide progress — digest and round never do. */
const PROGRESS_KEYS = [
  "toolCallsCommitted",
  "writeToolsCommitted",
  "fileCount",
  "completedNodes",
  "completedSteps",
  "evidenceEntries",
  "currentNode",
] as const

const READONLY_TOOL_NAMES = new Set([
  "read_file", "find_symbol", "find_references", "project_structure",
  "read_definition", "web_search", "git_status", "git_diff", "git_log", "git_blame",
  "request_deeper_thinking",
])

/** Tool call counts as a write-class side effect when it is not readonly. */
export function isWriteClassTool(name: string): boolean {
  return !READONLY_TOOL_NAMES.has(name)
}

/** Deterministic digest of what still blocks completion (titles only). */
export function obligationDigest(
  pendingSteps: string[],
  pendingNodes: string[],
): string {
  return [...pendingSteps, ...pendingNodes].slice(0, 8).join("|")
}

export class ProgressGovernor {
  private last: ProgressSnapshot | null = null
  private streak = 0

  /** 连续无进展轮数（供下一轮 thinking 降级判断）。 */
  get consecutiveNoProgress(): number {
    return this.streak
  }

  /** 每轮结束后调用一次。streak 从 1 起算（本轮无进展）。 */
  evaluate(snapshot: ProgressSnapshot): GovernorDecision {
    if (this.last) {
      const progressed = PROGRESS_KEYS.some(key => snapshot[key] !== this.last![key])
      if (!progressed) {
        this.streak += 1
        if (this.streak === 2) {
          this.last = snapshot
          return { action: "action_first" }
        }
        if (this.streak === 3) {
          this.last = snapshot
          return { action: "replan_once" }
        }
        if (this.streak >= 4) {
          this.last = snapshot
          return { action: "stalled", report: this.buildStallReport(snapshot) }
        }
      } else {
        this.streak = 0
      }
    }
    this.last = snapshot
    return { action: "proceed" }
  }

  private buildStallReport(snapshot: ProgressSnapshot): string {
    const pending = snapshot.pendingObligationDigest || "(无记录)"
    return [
      `## ProgressGovernor: 运行停滞（连续 4 轮无任何进展）`,
      `- 轮次: ${snapshot.round}`,
      `- 工具调用: ${snapshot.toolCallsCommitted} 次（本轮）/ 写类 ${snapshot.writeToolsCommitted} 次（累计见 ledger）`,
      `- 跟踪文件: ${snapshot.fileCount} 个（未增长）`,
      `- 完成: 计划节点 ${snapshot.completedNodes} 个 / 步骤 ${snapshot.completedSteps} 个 / 证据 ${snapshot.evidenceEntries} 条（未增长）`,
      `- 当前计划节点: ${snapshot.currentNode || "(无)"}`,
      `- 未完成义务: ${pending.slice(0, 200)}`,
      ``,
      `不再继续注入提示或重跑 —— 无进展在预算上限内终止（GS-01）。`,
    ].join("\n")
  }
}

// ── 注入提示（与 TaskTracker 提示并存的降级指令） ──

export function actionFirstPrompt(): ProviderMessage {
  return {
    role: "user",
    content: [
      "## 执行模式：连续 2 轮无进展",
      "停止规划与重述。从计划中选择一项**可以立即执行**的下一步，",
      "并发出一个具体的工具调用（读/写/运行皆可）。",
      "如果第一步需要调查，就发出调查工具调用。",
      "**本轮禁止只输出文本。**",
    ].join("\n"),
  }
}

export function replanOncePrompt(): ProviderMessage {
  return {
    role: "user",
    content: [
      "## 重新规划（仅此一次）",
      "此前提示未产生任何进展。请重新制定**最小下一步**——只做一件事。",
      "不要重复之前的规划文本。",
    ].join("\n"),
  }
}
