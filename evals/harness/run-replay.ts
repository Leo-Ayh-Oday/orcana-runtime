/**
 * H12 Tier 2 Run Replay executor (plan §18.2).
 *
 * runReplayCase drives a full AgentHarness lifecycle against a scripted
 * provider/tools/workspace, handles interrupt responses (waiting → resume),
 * and asserts expected outcome/events/artifacts/workspace/budget plus the
 * always-on trace invariants. runReplayPair runs two cases in parallel with
 * INDEPENDENT provider instances (isolation scenarios). NOT a scheduler.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createAgentHarness } from "../../src/harness/runtime/agent-harness"
import { createFileHarnessStore } from "../../src/harness/persistence/file-harness-store"
import { computeWorkspaceHash } from "../../src/harness/persistence/workspace-hash"
import { HarnessError } from "../../src/harness/contracts/errors"
import type { HarnessEvent } from "../../src/harness/contracts/events"
import type { RunSnapshot } from "../../src/harness/contracts/snapshot"
import { ScriptedProvider } from "./scripted-provider"
import { createScriptedTools } from "./scripted-tools"
import { assertTraceInvariants, matchDeepPartial, matchEvents, type ReplayEvent } from "./trace-assertions"
import { validateRunReplayCase, type RunReplayCase, type RunReplayResult } from "./contracts"

export interface RunReplayExecutorOptions {
  keepWorkspaceOnFailure?: boolean
  sessionIdPrefix?: string
}

export async function runReplayCase(
  caseDef: RunReplayCase,
  options: RunReplayExecutorOptions = {},
): Promise<RunReplayResult> {
  const started = Date.now()
  const issues = validateRunReplayCase(caseDef)
  if (issues.length > 0) {
    return fail(caseDef.caseId, issues, started, "")
  }

  const workspaceDir = mkdtempSync(join(tmpdir(), "hr-"))
  try {
    // initialWorkspace + HR-019 project-level permission config.
    for (const [path, content] of Object.entries(caseDef.initialWorkspace)) {
      const full = join(workspaceDir, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
    }

    const provider = new ScriptedProvider(caseDef.providerScript)
    const tools = createScriptedTools(caseDef.toolScript)
    // Store data lives under .orcana/ (excluded from workspace assertions).
    const store = createFileHarnessStore({ root: join(workspaceDir, ".orcana") })
    const harness = createAgentHarness({
      deps: {
        provider,
        tools,
        flashTriagePolicy: caseDef.options?.flashTriagePolicy ?? "off",
      },
      sessionId: `${options.sessionIdPrefix ?? "hr"}-${caseDef.caseId}`,
      projectRoot: workspaceDir,
      store,
      workspaceHash: () => computeWorkspaceHash(workspaceDir),
    })
    const session = await harness.createSession()

    const collected: HarnessEvent[] = []
    let runId = ""
    const responses = caseDef.interruptResponses ?? []

    const runIter = harness.run(session.sessionId, {
      ...caseDef.input,
      metadata: {
        ...caseDef.input.metadata,
        ...(caseDef.options?.contextMaxTokens !== undefined
          ? { "legacy.contextMaxTokens": caseDef.options.contextMaxTokens }
          : {}),
      },
    } as never)

    // Drive the run; on waiting, answer interrupts sequentially.
    let resumeQueue: AsyncIterator<HarnessEvent> | null = null
    let pendingRunId = ""
    for (let responseIndex = 0; ; ) {
      const iterator = resumeQueue ?? runIter[Symbol.asyncIterator]()
      const step = await iterator.next()
      if (step.done) break
      collected.push(step.value)
      pendingRunId = step.value.runId

      const isWaiting = step.value.type === "run.waiting"
      if (isWaiting) {
        const response = responses[responseIndex]
        if (!response) break // no more answers — leave waiting (expected case)
        responseIndex += 1
        try {
          const snapshot = await harness.inspect(pendingRunId)
          const interruptId = (snapshot.interrupt as { interruptId?: string } | undefined)?.interruptId
          if (!interruptId) throw new Error("waiting run without interrupt id")
          for (const [path, content] of Object.entries(response.mutateWorkspaceBeforeResume ?? {})) {
            const full = join(workspaceDir, path)
            mkdirSync(dirname(full), { recursive: true })
            writeFileSync(full, content)
          }
          resumeQueue = harness.resume(pendingRunId, {
            accepted: response.accepted,
            payload: response.payload,
            interruptId,
          } as never)[Symbol.asyncIterator]()
        } catch (error) {
          if (response.expectRefused && error instanceof HarnessError) {
            // R1: synthetic events carry NO sequence — a placeholder would
            // fake sequence continuity in resume scenarios (sequenceContinuous
            // filters undefined).
            collected.push({
              schemaVersion: 1,
              eventId: "refused",
              runId: pendingRunId,
              sessionId: session.sessionId,
              type: "interrupt.answered",
              timestamp: new Date().toISOString(),
              payload: { refused: true },
            } as unknown as HarnessEvent)
            break
          }
          return fail(caseDef.caseId, [`resume failed: ${String(error)}`], started, workspaceDir, options)
        }
      }
    }

    const snapshot = await harness.inspect(pendingRunId || collected[0]!.runId)
    const failures = evaluateExpectations(caseDef, collected, snapshot, workspaceDir)

    const result: RunReplayResult = {
      caseId: caseDef.caseId,
      passed: failures.length === 0,
      failures,
      // R1: keep the envelope sequence — sequenceContinuous() must see the
      // REAL 1,2,3,… stream, not an empty array (was dropped before).
      events: collected.map((e) => ({ type: e.type, payload: e.payload, sequence: e.sequence })),
      snapshot: {
        status: snapshot.status,
        outcome: snapshot.outcome ? { kind: snapshot.outcome.kind, ...(snapshot.outcome as object) } : undefined,
        budgetState: snapshot.budgetState,
        artifactRefs: snapshot.artifactRefs ?? [],
      },
      durationMs: Date.now() - started,
      workspaceDir,
    }

    if (result.passed && options.keepWorkspaceOnFailure !== true) {
      rmSync(workspaceDir, { recursive: true, force: true })
      result.workspaceDir = ""
    }
    return result
  } catch (error) {
    return fail(caseDef.caseId, [`executor error: ${String(error)}`], started, workspaceDir, options)
  }
}

/** Run two cases in parallel with independent provider instances (isolation). */
export async function runReplayPair(
  a: RunReplayCase,
  b: RunReplayCase,
  options: RunReplayExecutorOptions = {},
): Promise<[RunReplayResult, RunReplayResult]> {
  return Promise.all([runReplayCase(a, options), runReplayCase(b, options)])
}

export async function runReplaySuite(
  cases: RunReplayCase[],
  options: RunReplayExecutorOptions = {},
): Promise<{ results: RunReplayResult[]; passed: number; failed: number }> {
  const results: RunReplayResult[] = []
  for (const caseDef of cases) {
    results.push(await runReplayCase(caseDef, options))
  }
  return {
    results,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
  }
}

// ── Expectation evaluation ──

function evaluateExpectations(
  caseDef: RunReplayCase,
  events: HarnessEvent[],
  snapshot: RunSnapshot,
  workspaceDir: string,
): string[] {
  const failures: string[] = []
  const replayEvents: ReplayEvent[] = events.map((e) => ({ type: e.type, payload: e.payload, sequence: e.sequence }))

  // Outcome.
  const outcome = snapshot.outcome
  if (!outcome) {
    failures.push(`expected outcome ${caseDef.expected.outcome.kind}, got none`)
  } else if (outcome.kind !== caseDef.expected.outcome.kind) {
    failures.push(`expected outcome ${caseDef.expected.outcome.kind}, got ${outcome.kind}`)
  } else if (caseDef.expected.outcome.payload && !matchDeepPartial(outcome, caseDef.expected.outcome.payload)) {
    failures.push(`outcome payload mismatch for ${caseDef.expected.outcome.kind}`)
  }

  // Events.
  for (const expectation of caseDef.expected.events) {
    if (!matchEvents(replayEvents, expectation)) {
      failures.push(`event expectation failed: ${JSON.stringify(expectation)}`)
    }
  }

  // Artifacts.
  const refs = (snapshot.artifactRefs ?? []) as unknown[]
  if (caseDef.expected.artifacts.minCount !== undefined && refs.length < caseDef.expected.artifacts.minCount) {
    failures.push(`expected >= ${caseDef.expected.artifacts.minCount} artifacts, got ${refs.length}`)
  }
  if (caseDef.expected.artifacts.exactCount !== undefined && refs.length !== caseDef.expected.artifacts.exactCount) {
    failures.push(`expected ${caseDef.expected.artifacts.exactCount} artifacts, got ${refs.length}`)
  }

  // Workspace.
  for (const file of caseDef.expected.workspace.files ?? []) {
    const full = join(workspaceDir, file.path)
    const content = existsSync(full) ? readFileSync(full, "utf-8") : null
    switch (file.mode) {
      case "exists":
        if (content === null) failures.push(`workspace file missing: ${file.path}`)
        break
      case "not_exists":
        if (content !== null) failures.push(`workspace file should not exist: ${file.path}`)
        break
      case "equals":
        if (content !== file.value) failures.push(`workspace file ${file.path} expected "${file.value}", got "${content}"`)
        break
      case "contains":
        if (content === null || !content.includes(file.value ?? "")) {
          failures.push(`workspace file ${file.path} should contain "${file.value}"`)
        }
        break
    }
  }
  if (caseDef.expected.workspace.noAdditionalFiles) {
    const initial = new Set(Object.keys(caseDef.initialWorkspace))
    const entries = readdirSync(workspaceDir, { recursive: true } as never).map((p) => String(p))
    const extra = entries.filter((p) => {
      if (p.startsWith(".orcana") || initial.has(p)) return false
      // Directories from initialWorkspace paths (e.g. "src" for "src/a.ts")
      // are expected, not creations — only plain files count.
      const full = join(workspaceDir, p)
      try {
        return statSync(full).isFile()
      } catch {
        return false
      }
    })
    if (extra.length > 0) failures.push(`unexpected files created: ${extra.join(", ")}`)
  }

  // Budget.
  if (caseDef.expected.budget?.used) {
    const used = (snapshot.budgetState as { used?: Record<string, number> })?.used ?? {}
    for (const [key, value] of Object.entries(caseDef.expected.budget.used)) {
      if (used[key] !== value) failures.push(`budget used.${key} expected ${value}, got ${used[key]}`)
    }
  }
  if (caseDef.expected.budget?.exhausted) {
    const exhausted = String(snapshot.outcome?.kind) === "cancelled"
    if (!exhausted) failures.push("budget expected exhausted (cancelled), but run did not cancel")
  }
  if (caseDef.expected.budget?.reason) {
    const reason = (snapshot.outcome as { reason?: string } | undefined)?.reason
    if (reason !== caseDef.expected.budget.reason) {
      failures.push(`budget reason expected ${caseDef.expected.budget.reason}, got ${reason}`)
    }
  }

  // Always-on invariants.
  failures.push(...assertTraceInvariants(replayEvents, { status: snapshot.status, outcome }))

  return failures
}

function fail(
  caseId: string,
  failures: string[],
  started: number,
  workspaceDir: string,
  options?: RunReplayExecutorOptions,
): RunReplayResult {
  const keep = options?.keepWorkspaceOnFailure === true
  return {
    caseId,
    passed: false,
    failures,
    events: [],
    snapshot: { status: "error", budgetState: null, artifactRefs: [] },
    durationMs: Date.now() - started,
    workspaceDir: keep ? workspaceDir : "",
  }
}
