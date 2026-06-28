/**
 * PR-4.3: Unified Rewind — CLI `/rewind` command with 3 recovery modes.
 *
 *   code-only:       Restore files to checkpoint state, keep conversation
 *   conversation-only: Truncate conversation to checkpoint, keep files
 *   both:            Restore both files and conversation
 *
 * Per-user-prompt auto-save: every user message triggers saveRewindPoint().
 * Rewind points are stored as SessionCheckpoint records via the existing
 * checkpoint system (SQLite-backed), plus a transaction snapshot for file restore.
 *
 * Design invariants:
 *   - Zero LLM dependency. Pure filesystem + SHA snapshots.
 *   - Each rewind point captures: conversation position + file SHAs + FileTransaction IDs
 *   - File restoration uses rollbackTransaction from transaction.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import {
  saveCheckpoint,
  loadCheckpoint,
  lastCheckpoint,
  verifyCheckpoint,
  generateCheckpointId,
  type SessionCheckpoint,
} from "../session/checkpoint"
import { rollbackTransaction, loadTransaction } from "../tools/transaction"

// ── Rewind mode ──

export type RewindMode = "code" | "conversation" | "both"

export interface RewindPoint {
  round: number
  timestamp: number
  summary: string
  changedFiles: string[]
  fileCount: number
  conversationTokens: number
}

export interface RewindResult {
  success: boolean
  mode: RewindMode
  restoredFiles: string[]
  deletedFiles: string[]
  conversationTruncatedTo: number
  errors: string[]
}

// ── Rewind point directory ──

function rewindDir(sessionId: string): string {
  return resolve(process.cwd(), ".deepseek-code", "rewind", sessionId)
}

/** Save a per-user-prompt rewind point.
 *
 *  Called automatically on each user message. Stores:
 *   - A SessionCheckpoint (via existing checkpoint system)
 *   - File content snapshots for restoration
 *   - The conversation round boundary
 */
export function saveRewindPoint(input: {
  sessionId: string
  round: number
  summary: string
  changedFiles: string[]
  fileSHAs: Record<string, string>
  masterPlan?: Record<string, unknown>
  taskSteps?: Array<{ id: string; status: string; title: string }>
  conversationTokens: number
  lastVerification?: { kind: string; passed: boolean; command: string } | null
  knowledgeCount?: number
  coldMemorySHA?: string
}): void {
  // Save file content snapshots for code rewind (compute actual hashes from content)
  const dir = rewindDir(input.sessionId)
  mkdirSync(dir, { recursive: true })
  const snapshotFile = join(dir, `round-${input.round}.json`)
  const snapshots: Record<string, string | null> = {}
  const computedSHAs: Record<string, string> = {}

  // Collect files: from fileSHAs if provided, otherwise from changedFiles
  const filesToSnapshot = Object.keys(input.fileSHAs).length > 0
    ? Object.keys(input.fileSHAs)
    : input.changedFiles

  for (const path of filesToSnapshot) {
    try {
      const absPath = resolve(process.cwd(), path)
      if (existsSync(absPath)) {
        const content = readFileSync(absPath, "utf-8")
        snapshots[path] = content
        computedSHAs[path] = createHash("sha256").update(content).digest("hex").slice(0, 16)
      } else {
        snapshots[path] = null // file was deleted
        computedSHAs[path] = "deleted"
      }
    } catch {
      snapshots[path] = null
      computedSHAs[path] = "error"
    }
  }
  writeFileSync(snapshotFile, JSON.stringify(snapshots, null, 2), "utf-8")

  // Save via existing checkpoint system (SQLite-backed) with actual hashes
  saveCheckpoint({
    version: 1,
    round: input.round,
    timestamp: Date.now(),
    sessionId: input.sessionId,
    checkpointId: generateCheckpointId(),
    masterPlan: input.masterPlan ?? {},
    taskSteps: input.taskSteps ?? [],
    changedFiles: input.changedFiles,
    fileSHAs: computedSHAs,
    coldMemorySHA: input.coldMemorySHA ?? "",
    knowledgeCount: input.knowledgeCount ?? 0,
    lastVerification: input.lastVerification ?? null,
    conversationTokens: input.conversationTokens,
    prevRound: input.round - 1,
    summary: input.summary,
  })
}

/** List available rewind points for a session.
 *  Returns newest first. */
export function listRewindPoints(sessionId: string): RewindPoint[] {
  const dir = rewindDir(sessionId)
  if (!existsSync(dir)) return []

  const points: RewindPoint[] = []
  try {
    const files = readdirSync(dir).filter(f => f.startsWith("round-") && f.endsWith(".json"))
    for (const file of files) {
      const round = parseInt(file.replace("round-", "").replace(".json", ""), 10)
      if (isNaN(round)) continue

      // Try to load the corresponding checkpoint for metadata
      const cp = loadCheckpoint(sessionId, round)
      const snapshotPath = join(dir, file)
      let fileCount = 0
      try {
        const snapshots = JSON.parse(readFileSync(snapshotPath, "utf-8")) as Record<string, unknown>
        fileCount = Object.keys(snapshots).length
      } catch { /* snapshot file may be corrupted */ }

      points.push({
        round,
        timestamp: cp?.timestamp ?? 0,
        summary: cp?.summary ?? `Round ${round}`,
        changedFiles: cp?.changedFiles ?? [],
        fileCount,
        conversationTokens: cp?.conversationTokens ?? 0,
      })
    }
  } catch {
    // directory read failed
  }

  return points.sort((a, b) => b.round - a.round)
}

/** Execute a rewind to a specific checkpoint round.
 *
 *  @param sessionId — Current session ID
 *  @param targetRound — Round number to rewind to
 *  @param mode — "code" | "conversation" | "both"
 *  @param fileTransactionIds — Transaction IDs since the target round (for file rollback)
 *  @returns RewindResult with details of what was restored
 */
export function executeRewind(input: {
  sessionId: string
  targetRound: number
  mode: RewindMode
  /** FileTransaction IDs created after the target round (for rollback). */
  fileTransactionIds?: string[]
}): RewindResult {
  const result: RewindResult = {
    success: true,
    mode: input.mode,
    restoredFiles: [],
    deletedFiles: [],
    conversationTruncatedTo: input.targetRound,
    errors: [],
  }

  const cp = loadCheckpoint(input.sessionId, input.targetRound)
  if (!cp) {
    return {
      success: false,
      mode: input.mode,
      restoredFiles: [],
      deletedFiles: [],
      conversationTruncatedTo: input.targetRound,
      errors: [`未找到 checkpoint: round ${input.targetRound}`],
    }
  }

  // ── Code rewind: restore files from snapshots ──
  if (input.mode === "code" || input.mode === "both") {
    // Strategy 1: Roll back FileTransactions in reverse order
    if (input.fileTransactionIds && input.fileTransactionIds.length > 0) {
      for (const txId of input.fileTransactionIds.reverse()) {
        try {
          const tx = loadTransaction(txId)
          if (tx) {
            const { restored, deleted } = rollbackTransaction(txId)
            result.restoredFiles.push(...restored)
            result.deletedFiles.push(...deleted)
          }
        } catch (err) {
          result.errors.push(`rollbackTransaction ${txId} 失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    // Strategy 2: Restore from snapshot files (covers files without transactions)
    const snapshotPath = join(rewindDir(input.sessionId), `round-${input.targetRound}.json`)
    if (existsSync(snapshotPath)) {
      try {
        const snapshots = JSON.parse(readFileSync(snapshotPath, "utf-8")) as Record<string, string | null>
        for (const [path, content] of Object.entries(snapshots)) {
          const absPath = resolve(process.cwd(), path)
          try {
            if (content === null) {
              // File was deleted at checkpoint time — delete it now
              if (existsSync(absPath)) {
                rmSync(absPath, { force: true })
                result.deletedFiles.push(path)
              }
            } else {
              // Restore file content
              mkdirSync(resolve(absPath, ".."), { recursive: true })
              writeFileSync(absPath, content, "utf-8")
              // Only record if we haven't already from transaction rollback
              if (!result.restoredFiles.includes(path)) {
                result.restoredFiles.push(path)
              }
            }
          } catch (err) {
            result.errors.push(`恢复 ${path} 失败: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      } catch (err) {
        result.errors.push(`读取快照失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // ── Integrity check after code rewind ──
  // Skip files with sentinel hash values ("deleted" = intentionally deleted, "error" = unreadable)
  if ((input.mode === "code" || input.mode === "both") && Object.keys(cp.fileSHAs).length > 0) {
    const realSHAs = Object.fromEntries(
      Object.entries(cp.fileSHAs).filter(([, h]) => h !== "deleted" && h !== "error")
    )
    if (Object.keys(realSHAs).length > 0) {
      const integrity = verifyCheckpoint({ ...cp, fileSHAs: realSHAs })
      if (!integrity.filesMatch && result.errors.length === 0) {
        result.errors.push(
          `文件完整性检查: ${integrity.filesMismatched.length} 个文件哈希不匹配: ${integrity.filesMismatched.join(", ")}`
        )
      }
    }
  }

  result.success = result.errors.length === 0
  return result
}

/** Format a rewind point list for CLI display. */
export function formatRewindList(points: RewindPoint[]): string {
  if (points.length === 0) return "没有可用的回退点。"

  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
  const green = (s: string) => `\x1b[1;32m${s}\x1b[0m`
  const cyan = (s: string) => `\x1b[1;36m${s}\x1b[0m`

  const lines: string[] = ["── 回退点 ──", ""]
  for (const p of points.slice(0, 15)) {
    const date = new Date(p.timestamp).toLocaleString("zh-CN")
    const files = p.fileCount > 0 ? `${p.fileCount} 个文件` : "无文件快照"
    const changed = p.changedFiles.length > 0 ? `, ${p.changedFiles.length} 个变更` : ""
    lines.push(
      `  ${green(`/rewind ${p.round}`)}  ${dim(date)}  ${dim(`${files}${changed}  |  ${Math.round(p.conversationTokens / 1000)}K tokens`)}`
    )
    if (p.summary) lines.push(`    ${dim(p.summary.slice(0, 80))}`)
  }
  if (points.length > 15) lines.push(`  ${dim(`...还有 ${points.length - 15} 个`)}`)
  return lines.join("\n") + "\n"
}

/** Format rewind result for CLI display. */
export function formatRewindResult(result: RewindResult): string {
  const green = (s: string) => `\x1b[1;32m${s}\x1b[0m`
  const red = (s: string) => `\x1b[1;31m${s}\x1b[0m`
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

  if (!result.success) {
    return red(`回退失败:\n`) + result.errors.map(e => `  ${red("✗")} ${e}`).join("\n") + "\n"
  }

  const lines: string[] = [green(`✓ 已回退到 round ${result.conversationTruncatedTo}`) + ` (模式: ${result.mode})\n`]
  if (result.restoredFiles.length > 0) {
    lines.push(`  恢复文件: ${result.restoredFiles.length} 个`)
    for (const f of result.restoredFiles.slice(0, 5)) lines.push(`    ${dim(f)}`)
    if (result.restoredFiles.length > 5) lines.push(`    ${dim(`...还有 ${result.restoredFiles.length - 5} 个`)}`)
  }
  if (result.deletedFiles.length > 0) {
    lines.push(`  删除文件: ${result.deletedFiles.length} 个`)
    for (const f of result.deletedFiles.slice(0, 5)) lines.push(`    ${dim(f)}`)
  }
  if (result.errors.length > 0) {
    lines.push(`  警告: ${result.errors.length} 个`)
    for (const e of result.errors.slice(0, 3)) lines.push(`    ${dim(e)}`)
  }
  return lines.join("\n") + "\n"
}
