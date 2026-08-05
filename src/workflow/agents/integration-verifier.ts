/** MACP-M5: integration verifier — merge through a single-writer
 *  transaction, then verify the WHOLE workspace (task 8/9: post-merge
 *  verification is mandatory; pre-merge per-agent verification never
 *  substitutes), rolling back the official workspace on any failure
 *  (task 10). Agent worktrees are left untouched until adjudication ends
 *  (task 11) — integration only reads from them and never mutates them.
 */

import type { IntegrationPlan } from "./integration-plan"
import { planBlocked } from "./integration-plan"
import { createTransaction, rollbackTransaction } from "../../tools/transaction"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export type IntegrationStatus = "merged" | "blocked_conflict" | "verification_failed"

export interface IntegrationResult {
  status: IntegrationStatus
  /** Files integrated into the official workspace (empty when blocked). */
  integrated: string[]
  /** Transaction id for audit/rollback (present when files were written). */
  txId?: string
  verification?: { passed: boolean; summary: string }
  reason?: string
}

export interface IntegrateInput {
  plan: IntegrationPlan
  projectRoot: string
  /** Worktree root per agent — content source for automatic files. */
  worktreeRoots: Record<string, string>
  /** Post-merge whole-workspace verification (MANDATORY — task 8/9). */
  verify: () => Promise<{ passed: boolean; summary: string }>
  /** File write callback (test injection); defaults to writeFileSync. */
  writeFile?: (target: string, content: string) => void
}

export async function integrateWithVerification(input: IntegrateInput): Promise<IntegrationResult> {
  const { plan, projectRoot } = input
  const cwd = resolve(projectRoot)

  // Task 12: unresolved conflicts block the run — the official workspace is
  // never touched; worktrees are preserved for adjudication (task 11).
  if (planBlocked(plan)) {
    return {
      status: "blocked_conflict",
      integrated: [],
      reason: plan.conflictSet.fileConflicts
        .map(c => `${c.file} (${c.agents.join(", ")})`)
        .join("; "),
    }
  }

  if (plan.automatic.length === 0) {
    return { status: "merged", integrated: [], verification: { passed: true, summary: "nothing to integrate" } }
  }

  // Task 7: single-writer transaction — snapshot the official workspace
  // files before touching them, so any failure rolls back cleanly.
  const transaction = createTransaction({
    tool: "merge_agents",
    paths: plan.automatic.map(file => join(cwd, file)),
    cwd,
  })

  const writeFile = input.writeFile ?? ((target: string, content: string) => {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, "utf8")
  })

  const integrated: string[] = []
  try {
    for (const file of plan.automatic) {
      const agentId = plan.sourceByFile[file]!
      const worktreeRoot = input.worktreeRoots[agentId]
      if (!worktreeRoot) throw new Error(`no worktree for agent "${agentId}" (file ${file})`)
      const source = resolve(worktreeRoot, file)
      if (!existsSync(source)) throw new Error(`worktree content missing: ${source}`)
      const content = readFileSync(source, "utf8")
      writeFile(join(cwd, file), content)
      integrated.push(file)
    }

    // Task 8/9: whole-workspace verification AFTER the merge; a failing
    // verify rolls the official workspace back to its pre-merge state.
    const verification = await input.verify()
    if (!verification.passed) {
      rollbackTransaction(transaction.id, cwd)
      return {
        status: "verification_failed",
        integrated: [],
        txId: transaction.id,
        verification,
        reason: `post-merge verification failed: ${verification.summary}`,
      }
    }
    return { status: "merged", integrated, txId: transaction.id, verification }
  } catch (error) {
    // Task 10/6: interrupted or failed integration never leaves the official
    // workspace half-written — roll the transaction back.
    rollbackTransaction(transaction.id, cwd)
    return {
      status: "verification_failed",
      integrated: [],
      txId: transaction.id,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
