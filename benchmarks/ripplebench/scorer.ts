#!/usr/bin/env bun
/** RippleBench Pro — benchmark runner and scorer.
 *
 *  Usage: bun scorer.ts <task-id>
 *  Tasks: rbp-01 through rbp-08
 *
 *  Scoring dimensions:
 *    correctness (40%) — tsc --noEmit passes + all tests pass
 *    safety (30%)     — zero ripple obligations (no broken callers)
 *    efficiency (20%) — rounds / tool calls vs optimal
 *    planning (10%)   — plan-before-code for complex tasks
 */

import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { migrateLegacyTraceLine } from "../../src/harness/telemetry/migration"

const BENCH_DIR = resolve(import.meta.dirname ?? ".")

interface TaskResult {
  taskId: string
  passed: boolean
  score: number
  dimensions: {
    correctness: { passed: boolean; score: number; tscErrors: number; testFails: number }
    safety: { passed: boolean; score: number; rippleViolations: number }
    efficiency: { score: number; roundsUsed: number; optimalRounds: number }
    planning: { score: number; hadPlan: boolean }
  }
  errors: string[]
}

// ── Task metadata ──

const TASKS: Record<string, { optimalRounds: number; requiresSearch: boolean; searchQuery?: string }> = {
  "rbp-01": { optimalRounds: 12, requiresSearch: false },
  "rbp-02": { optimalRounds: 18, requiresSearch: false },
  "rbp-03": { optimalRounds: 14, requiresSearch: false },
  "rbp-04": { optimalRounds: 8, requiresSearch: false },
  "rbp-05": { optimalRounds: 15, requiresSearch: false },
  "rbp-06": { optimalRounds: 10, requiresSearch: false },
  "rbp-07": { optimalRounds: 3, requiresSearch: false },
  "rbp-08": { optimalRounds: 2, requiresSearch: false },

  // Web-search tasks
  "rbp-09": { optimalRounds: 8, requiresSearch: true, searchQuery: "bun test beforeAll afterAll API 2025 breaking changes" },
  "rbp-10": { optimalRounds: 10, requiresSearch: true, searchQuery: "TypeScript 5.7 satisfies operator Record indexed access" },
}

function run(cmd: string): { ok: boolean; output: string } {
  try {
    const out = execSync(cmd, { encoding: "utf-8", timeout: 30_000, cwd: BENCH_DIR })
    return { ok: true, output: out }
  } catch (e) {
    return { ok: false, output: String((e as { stdout?: string; stderr?: string; message?: string }).stdout ?? (e as { message?: string }).message ?? "") }
  }
}

// ── Scoring functions ──

function scoreCorrectness(taskId: string): { passed: boolean; score: number; tscErrors: number; testFails: number } {
  const tsc = run("npx tsc --noEmit --pretty false 2>&1")
  const test = run("bun test tests/ 2>&1")

  const tscErrors = tsc.ok ? 0 : (tsc.output.match(/error TS\d+/g)?.length ?? 1)
  const testFails = test.output.match(/\b\d+ fail\b/)?.[0] ? parseInt(test.output.match(/\b(\d+) fail\b/)![1]!) : 0

  const passed = tscErrors === 0 && testFails === 0
  const score = passed ? 40 : Math.max(0, 40 - (tscErrors * 8 + testFails * 15))

  return { passed, score, tscErrors, testFails }
}

/** Resolve the runs directory — checks RippleBench's own .deepseek-code first,
 *  then falls back to the parent project's. */
function resolveRunsDir(): string | null {
  const local = resolve(BENCH_DIR, ".deepseek-code", "runs")
  if (existsSync(local)) return local
  const parent = resolve(BENCH_DIR, "..", "..", ".deepseek-code", "runs")
  if (existsSync(parent)) return parent
  return null
}

/**
 * Read agent run traces (H5: shared types, no field guessing).
 *
 * Legacy kernel traces (.deepseek-code/runs/*.jsonl, `{runId, timestamp,
 * type, data}`) are parsed through migrateLegacyTraceLine() into typed
 * EventEnvelopes; new harness traces (EventEnvelope JSONL) are used as-is.
 * Events are normalized to `{ type, ...data }` so scorer dimensions keep
 * reading the same facts — via the shared envelope, never by guessing raw
 * JSON field positions.
 */
function readRunEvents(runsDir: string | null, maxFiles: number): Array<Record<string, unknown>> {
  if (!runsDir) return []
  const events: Array<Record<string, unknown>> = []
  try {
    const { readdirSync, readFileSync } = require("node:fs")
    let files: string[] = []
    try { files = readdirSync(runsDir) } catch { return [] }
    for (const f of files.slice(-maxFiles)) {
      if (!f.endsWith(".json") && !f.endsWith(".jsonl")) continue
      try {
        const raw = readFileSync(resolve(runsDir, f), "utf-8")
        if (f.endsWith(".jsonl")) {
          const lines = raw.trim().split("\n")
          for (const line of lines.slice(-10)) {
            const normalized = normalizeTraceLine(line)
            if (normalized) events.push(normalized)
          }
        } else {
          const trace = JSON.parse(raw)
          const evs = Array.isArray(trace) ? trace : trace.events ?? []
          for (const ev of evs) {
            const normalized = normalizeTraceLine(typeof ev === "string" ? ev : JSON.stringify(ev))
            if (normalized) events.push(normalized)
          }
        }
      } catch { /* skip corrupt */ }
    }
  } catch { /* best-effort */ }
  return events
}

/** Parse one trace line through shared envelope types (legacy or H5). */
function normalizeTraceLine(line: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const record = parsed as Record<string, unknown>
  // New H5 envelope: { schemaVersion, type, payload }.
  if ("schemaVersion" in record && "payload" in record && typeof record.type === "string") {
    const legacy = (record.payload as { legacy?: unknown } | undefined)?.legacy
    return legacy && typeof legacy === "object"
      ? { type: record.type, ...(legacy as Record<string, unknown>) }
      : { type: record.type, payload: record.payload }
  }
  // Legacy kernel trace line: migrate through the shared type.
  const envelope = migrateLegacyTraceLine(line)
  if (!envelope) return null
  const legacy = (envelope.payload as { legacy?: unknown }).legacy
  return legacy && typeof legacy === "object"
    ? { type: envelope.type, ...(legacy as Record<string, unknown>) }
    : { type: envelope.type, data: legacy }
}

function scoreSafety(): { passed: boolean; score: number; rippleViolations: number } {
  const events = readRunEvents(resolveRunsDir(), 5)
  let rippleViolations = 0
  for (const ev of events) {
    if (ev.gate === "ripple_obligations" && ev.decision === "continue") {
      rippleViolations += (ev.pending as number) ?? 1
    }
  }
  const passed = rippleViolations === 0
  return { passed, score: passed ? 30 : Math.max(0, 30 - rippleViolations * 8), rippleViolations }
}

function scoreEfficiency(taskId: string): { score: number; roundsUsed: number; optimalRounds: number } {
  const task = TASKS[taskId] ?? { optimalRounds: 10 }
  const events = readRunEvents(resolveRunsDir(), 3)
  let roundsUsed = task.optimalRounds
  for (const ev of events) {
    const t = ev as Record<string, unknown>
    if (t.maxRounds) {
      roundsUsed = t.changedFiles != null ? 10 + ((t.roundCount as number) ?? 10) : 15
    }
  }
  const ratio = task.optimalRounds / Math.max(roundsUsed, 1)
  return { score: Math.round(Math.min(20, ratio * 20)), roundsUsed, optimalRounds: task.optimalRounds }
}

function scorePlanning(): { score: number; hadPlan: boolean } {
  const events = readRunEvents(resolveRunsDir(), 3)
  const hadPlan = events.some(e => e.gate === "planning" && e.decision === "accepted")
  return { score: hadPlan ? 10 : 5, hadPlan }
}

// ── Main ──

export function scoreTask(taskId: string): TaskResult {
  if (!TASKS[taskId] && !taskId.startsWith("rbp-")) {
    return taskResult(taskId, false, [], "unknown task")
  }

  const errors: string[] = []
  const correctness = scoreCorrectness(taskId)
  const safety = scoreSafety()
  const efficiency = scoreEfficiency(taskId)
  const planning = scorePlanning()

  const totalScore = correctness.score + safety.score + efficiency.score + planning.score
  const passed = correctness.passed && safety.passed

  return {
    taskId,
    passed,
    score: totalScore,
    dimensions: { correctness, safety, efficiency, planning },
    errors,
  }
}

function taskResult(taskId: string, passed: boolean, errors: string[], reason: string): TaskResult {
  return {
    taskId, passed, score: 0,
    dimensions: {
      correctness: { passed: false, score: 0, tscErrors: 1, testFails: 0 },
      safety: { passed: false, score: 0, rippleViolations: 1 },
      efficiency: { score: 0, roundsUsed: 999, optimalRounds: 1 },
      planning: { score: 0, hadPlan: false },
    },
    errors: [reason, ...errors],
  }
}

// ── CLI ──

const taskId = process.argv[2]
if (!taskId) {
  Object.entries(TASKS).forEach(([id, meta]) => {
    const searchNote = meta.requiresSearch ? "  [WEB SEARCH]" : ""
    console.log(`  ${id}: optimal ${meta.optimalRounds}r${searchNote}`)
  })
} else {
  const result = scoreTask(taskId)
  console.log(JSON.stringify(result, null, 2))
}
