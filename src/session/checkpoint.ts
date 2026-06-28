/**
 * Session Checkpoint — recoverable state boundary for long-running agent tasks.
 *
 * Now backed by SessionStore (SQLite) instead of standalone JSON files.
 * Public API preserved for backward compatibility.
 *
 * Design invariants:
 *   - Zero LLM dependency. Checkpoints are pure filesystem + SHA snapshots.
 *   - SQLite-backed (per-session database), 3 most recent retained.
 *   - File recovery: revert changed files to SHA captured at checkpoint boundary.
 *   - Cold memory recovery: verify SHA integrity after restore.
 */

import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { SessionStore, type CheckpointRecord } from "./sqlite-session"

// ═══════════════════════════════════════════════════════════
// Data model (same as before — CheckpointRecord is in sqlite-session.ts)
// ═══════════════════════════════════════════════════════════

export interface SessionCheckpoint {
  version: 1
  round: number
  timestamp: number
  sessionId: string
  /** PR-4.4: Unique checkpoint identifier (UUID-like, 12-char hex). */
  checkpointId: string
  masterPlan: Record<string, unknown>
  taskSteps: Array<{ id: string; status: string; title: string }>
  changedFiles: string[]
  fileSHAs: Record<string, string>
  coldMemorySHA: string
  knowledgeCount: number
  lastVerification: { kind: string; passed: boolean; command: string } | null
  conversationTokens: number
  prevRound: number
  summary: string
}

/** Generate a unique checkpoint ID (12-char hex from timestamp + random). */
export function generateCheckpointId(): string {
  return `${Date.now().toString(36)}_${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 6)}`
}

// ── Structured checkpoint template (6-section, inspired by MiMo §1-§11) ──

export const CHECKPOINT_TEMPLATE = `# Session checkpoint
## §1 Active intent
_User's most recent explicit request_

(none yet)

## §2 Task progress
_Completed items and current blocker_

(none yet)

## §3 Files changed
_Modified files with one-line purpose each_

(none yet)

## §4 Errors and fixes
_Errors encountered and how they were resolved. Newest first._

(none)

## §5 Verification status
_Last typecheck/test/build result_

(none yet)

## §6 Next action
_The single next concrete step to take on resume_

(none yet)
`

export const CHECKPOINT_SECTION_BUDGETS: Record<string, number> = {
  "§1 Active intent": 500,
  "§2 Task progress": 1500,
  "§3 Files changed": 800,
  "§4 Errors and fixes": 1200,
  "§5 Verification status": 500,
  "§6 Next action": 600,
}

/** Format a structured checkpoint summary from the flat checkpoint data. */
export function formatCheckpointSummary(cp: SessionCheckpoint): string {
  const done = cp.taskSteps.filter(s => s.status === "done").length
  const total = cp.taskSteps.length
  const activeSteps = cp.taskSteps.filter(s => s.status === "running" || s.status === "pending")
  const taskBlock = total > 0
    ? `${done}/${total} done` + (activeSteps.length > 0 ? ` — next: ${activeSteps[0]?.title ?? "?"}` : "")
    : cp.summary
  const filesBlock = cp.changedFiles.length > 0
    ? cp.changedFiles.slice(0, 15).map(f => `- ${f}`).join("\n")
    : "(none)"
  const verifyBlock = cp.lastVerification
    ? `${cp.lastVerification.kind}: ${cp.lastVerification.passed ? "PASS" : "FAIL"} (${cp.lastVerification.command})`
    : "(none)"
  return [
    "## §1 Active intent",
    cp.summary || "(see conversation)",
    "",
    "## §2 Task progress",
    taskBlock,
    "",
    "## §3 Files changed",
    filesBlock,
    "",
    "## §4 Errors and fixes",
    "(see conversation transcript for error details)",
    "",
    "## §5 Verification status",
    verifyBlock,
    "",
    "## §6 Next action",
    `Resume from round ${cp.round}. Continue from first pending step.`,
  ].join("\n")
}

export interface CheckpointRecovery {
  checkpoint: SessionCheckpoint
  recoveryPrompt: string
  restoredPlan: Record<string, unknown>
}

export interface IntegrityReport {
  valid: boolean
  filesMatch: boolean
  filesMismatched: string[]
  coldMemoryMatch: boolean
}

// ═══════════════════════════════════════════════════════════
// SHA utilities (unchanged)
// ═══════════════════════════════════════════════════════════

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

export function fileSHA(filePath: string): string | null {
  try {
    return sha256(readFileSync(filePath, "utf-8"))
  } catch {
    return null
  }
}

// ═══════════════════════════════════════════════════════════
// Save / load — now backed by SessionStore
// ═══════════════════════════════════════════════════════════

/** Active SessionStore instances cached by sessionId for checkpoint writes. */
const activeStores = new Map<string, SessionStore>()

/** Register a SessionStore for checkpoint operations. Called by cli.ts at session start. */
export function registerCheckpointStore(sessionId: string, store: SessionStore): void {
  activeStores.set(sessionId, store)
}

/** Unregister on session close. */
export function unregisterCheckpointStore(sessionId: string): void {
  activeStores.delete(sessionId)
}

function getStore(sessionId: string): SessionStore {
  const existing = activeStores.get(sessionId)
  if (existing) return existing
  // Fallback: create a one-off store (for recovery/loading)
  return new SessionStore(sessionId)
}

export function saveCheckpoint(cp: SessionCheckpoint): void {
  const store = getStore(cp.sessionId)
  store.saveCheckpoint({
    roundNum: cp.round,
    timestamp: cp.timestamp,
    sessionId: cp.sessionId,
    masterPlan: cp.masterPlan,
    taskSteps: cp.taskSteps,
    changedFiles: cp.changedFiles,
    fileSHAs: cp.fileSHAs,
    coldMemorySHA: cp.coldMemorySHA,
    knowledgeCount: cp.knowledgeCount,
    lastVerification: cp.lastVerification,
    conversationTokens: cp.conversationTokens,
    prevRound: cp.prevRound,
    summary: cp.summary,
    checkpointId: cp.checkpointId,
  })
  // Close fallback store (not the active one)
  if (!activeStores.has(cp.sessionId)) store.close()
}

export function loadCheckpoint(sessionId: string, round?: number): SessionCheckpoint | null {
  const store = getStore(sessionId)
  const record = store.loadCheckpoint(round)
  if (!activeStores.has(sessionId)) store.close()
  if (!record) return null
  return recordToCheckpoint(record)
}

export function lastCheckpoint(sessionId: string): SessionCheckpoint | null {
  return loadCheckpoint(sessionId)
}

function recordToCheckpoint(rec: CheckpointRecord): SessionCheckpoint {
  return {
    version: 1,
    round: rec.roundNum,
    timestamp: rec.timestamp,
    sessionId: rec.sessionId,
    checkpointId: rec.checkpointId ?? `${rec.sessionId}_r${rec.roundNum}`,
    masterPlan: rec.masterPlan ?? {},
    taskSteps: rec.taskSteps ?? [],
    changedFiles: rec.changedFiles,
    fileSHAs: rec.fileSHAs ?? {},
    coldMemorySHA: rec.coldMemorySHA ?? "",
    knowledgeCount: rec.knowledgeCount,
    lastVerification: rec.lastVerification,
    conversationTokens: rec.conversationTokens,
    prevRound: rec.prevRound,
    summary: rec.summary,
  }
}

// ═══════════════════════════════════════════════════════════
// Multi-threshold checkpoint scheduling (unchanged)
// ═══════════════════════════════════════════════════════════

const CP_THRESHOLDS = [
  { percent: 20, label: "light", description: "轻量快照 — 仅任务状态 + 文件列表" },
  { percent: 45, label: "full", description: "完整 checkpoint — 含文件 SHA + 冷记忆" },
  { percent: 70, label: "compact", description: "精简 checkpoint — 建议压缩上下文" },
]

let _lastCpPercent = 0

export function shouldCheckpoint(contextPercent: number): false | { label: string; urgency: string } {
  for (const t of CP_THRESHOLDS) {
    if (contextPercent >= t.percent && _lastCpPercent < t.percent) {
      _lastCpPercent = contextPercent
      return { label: t.label, urgency: t.description }
    }
  }
  if (contextPercent < _lastCpPercent - 20) {
    _lastCpPercent = Math.floor(contextPercent / 20) * 20
  }
  return false
}

export function resetCheckpointScheduler() { _lastCpPercent = 0 }

// ── Adaptive checkpoint density ──

export interface ComplexityMetrics {
  filesPerRound: number
  errorRate: number
  round: number
}

export function adaptiveCheckpointThreshold(
  contextPercent: number,
  metrics: ComplexityMetrics,
): false | { label: string; urgency: string } {
  const isComplex = metrics.filesPerRound > 0.3 || metrics.errorRate > 0.1 || metrics.round > 20
  const thresholds = isComplex
    ? [
        { percent: 15, label: "light", urgency: "complex task — early light checkpoint" },
        { percent: 40, label: "full", urgency: "complex task — full checkpoint" },
        { percent: 65, label: "compact", urgency: "complex task — compact checkpoint" },
      ]
    : [
        { percent: 50, label: "full", urgency: "simple task — deferred full checkpoint" },
        { percent: 75, label: "compact", urgency: "simple task — compact checkpoint" },
      ]
  for (const t of thresholds) {
    if (contextPercent >= t.percent && _lastCpPercent < t.percent) {
      _lastCpPercent = contextPercent
      return { label: t.label, urgency: t.urgency }
    }
  }
  if (contextPercent < _lastCpPercent - 20) {
    _lastCpPercent = Math.floor(contextPercent / 20) * 20
  }
  return false
}

let _lastCpRound = 0

export function shouldSkipCheckpointThisRound(round: number): boolean {
  return round - _lastCpRound < 3
}

export function recordCheckpointTaken(round: number): void {
  _lastCpRound = round
}

// ═══════════════════════════════════════════════════════════
// Integrity check (unchanged — uses fileSHA which reads disk)
// ═══════════════════════════════════════════════════════════

export function verifyCheckpoint(cp: SessionCheckpoint, currentColdMemorySHA?: string): IntegrityReport {
  const mismatched: string[] = []
  for (const [path, expectedSHA] of Object.entries(cp.fileSHAs)) {
    const current = fileSHA(path)
    if (current !== expectedSHA) mismatched.push(path)
  }

  const coldMemoryMatch = currentColdMemorySHA
    ? cp.coldMemorySHA === currentColdMemorySHA
    : true

  return {
    valid: mismatched.length === 0 && coldMemoryMatch,
    filesMatch: mismatched.length === 0,
    filesMismatched: mismatched,
    coldMemoryMatch,
  }
}

// ═══════════════════════════════════════════════════════════
// Recovery prompt builder (unchanged)
// ═══════════════════════════════════════════════════════════

export function buildRecoveryPrompt(cp: SessionCheckpoint): CheckpointRecovery {
  const done = cp.taskSteps.filter(s => s.status === "done").length
  const total = cp.taskSteps.length

  const nodes = Array.isArray(cp.masterPlan?.nodes)
    ? (cp.masterPlan.nodes as Array<Record<string, unknown>>)
        .map((n: Record<string, unknown>) => {
          const icon = { pending: "🔵", active: "🔄", blocked: "🟡", done: "✅", skipped: "❌" }[String(n.status ?? "pending")] ?? "❓"
          return `${icon} ${n.id ?? "?"}. ${n.title ?? ""}`
        })
    : []

  const recoveryPrompt = [
    "## 🔄 会话恢复 — 从检查点继续",
    "",
    `上次中断在第 ${cp.round} 轮，已完成 ${done}/${total} 个步骤。`,
    cp.lastVerification
      ? `上次验证: ${cp.lastVerification.kind} ${cp.lastVerification.passed ? "✅ 通过" : "❌ 失败"} (${cp.lastVerification.command})`
      : "",
    `变更文件: ${cp.changedFiles.length} 个`,
    "",
    "### 任务进度",
    ...nodes,
    "",
    "### 继续执行",
    cp.summary ? `上次活动: ${cp.summary}` : "",
    "从第一个未完成的节点继续。先读取相关文件，然后按步骤执行。",
  ].filter(Boolean).join("\n")

  return {
    checkpoint: cp,
    recoveryPrompt,
    restoredPlan: cp.masterPlan,
  }
}
