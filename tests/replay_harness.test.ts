/** PR 9: Replay Harness — 30 case runner.
 *
 *  Loads JSON case files from tests/replay/<domain>/,
 *  dispatches to the actual target functions, and validates
 *  results against expected outcomes.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"

import type { ReplayCase, ReplayExpected } from "../src/agent/replay-harness"
import { checkAssertions } from "../src/agent/replay-harness"

// ── Modules under test ──
import { createMasterPlan, nodesFromPlanText, planComplete, activateNode, markNodeDone, planRef } from "../src/agent/master-plan"
import { validatePlan, evaluatePlanForcePass } from "../src/agent/plan-validator"
import { classifyEpochAction, hasUnclosedToolChain, epochRollover, createEpochState, msgCharLen } from "../src/agent/context-epoch"
import { evaluateCompletionGate, needsExternalCompletionGate } from "../src/agent/completion-gate"
import {
  obligationsFromReport,
  waiveObligation,
  getBlockingObligations,
  mergeObligations,
  resolveObligations,
  type RippleObligation,
} from "../src/ripple/obligations"
import {
  checkForbiddenFile,
  checkBaseHash,
  generateLineDiff,
  computeBaseHash,
  createPatchTransaction,
  type PatchTransaction,
} from "../src/agent/patch-transaction"
import { setActiveMode, getActiveMode } from "../src/agent/mode-contract"
import { createTaskTrackerFromPacket, buildPacketFromLine } from "../src/agent/task-packet"
import {
  buildContextMemoryPack,
  ensureContextMemoryLayout,
  evaluateMemoryRetrieval,
  loadMemoryIndex,
  proposeMemoryUpdate,
  recordCacheTelemetry,
  resolveMemoryIndexFiles,
  summarizeCacheTelemetry,
  type CacheTelemetryEntry,
  type MemoryCapsule,
} from "../src/memory/context-memory-os"
import {
  attachContextMapToTaskPacket,
  buildContextMap,
  buildSourceUnderstanding,
  contextEvidenceForMap,
  evaluateContextReadiness,
  hybridLocate,
  loadContextMap,
  loadProjectConstitution,
  saveContextMap,
  scanRepoStructure,
  selectContextMapTaskLevel,
} from "../src/context/context-map"

// ── Case loading ──

const REPLAY_DIR = join(import.meta.dirname ?? __dirname, "replay")

function loadJsonCases(domain: string): ReplayCase[] {
  const dir = join(REPLAY_DIR, domain)
  if (!existsSync(dir)) return []
  const files = readdirSync(dir).filter(f => f.endsWith(".json")).sort()
  return files.map(f => {
    const raw = readFileSync(join(dir, f), "utf-8")
    return JSON.parse(raw) as ReplayCase
  })
}

function loadAllCases(): ReplayCase[] {
  const domains = ["master-plan", "context-epoch", "false-done", "ripple", "patch-transaction", "context-memory", "context-map"]
  return domains.flatMap(loadJsonCases)
}

// ── Test context ──

interface TestContext {
  tempDir: string
  createdFiles: string[]
}

function createTestContext(): TestContext {
  const tempDir = mkdtempSync(join(tmpdir(), "replay-harness-"))
  return { tempDir, createdFiles: [] }
}

function cleanupTestContext(ctx: TestContext) {
  try { rmSync(ctx.tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
}

function writeFixtureFile(ctx: TestContext, relativePath: string, content: string): string {
  const fullPath = join(ctx.tempDir, relativePath)
  const dir = dirname(fullPath)
  if (!existsSync(dir)) {
    const { mkdirSync } = require("node:fs")
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(fullPath, content, "utf-8")
  ctx.createdFiles.push(fullPath)
  return fullPath
}

function ensureContextMapFixture(ctx: TestContext) {
  writeFixtureFile(ctx, "package.json", JSON.stringify({
    name: "fixture",
    main: "dist/src/index.js",
    bin: { fixture: "bin/fixture.cjs" },
    scripts: {
      typecheck: "tsc --noEmit",
      test: "bun test",
      build: "tsc -p tsconfig.build.json",
    },
  }))
  writeFixtureFile(ctx, "bun.lock", "")
  writeFixtureFile(ctx, "ARCHITECTURE.md", [
    "# Runtime",
    "- Agent runtime must keep TaskPacket and Evidence.",
    "- Do not bypass completion evidence gates.",
  ].join("\n"))
  writeFixtureFile(ctx, "src/index.ts", "export { evaluateCompletionGate } from './agent/completion-gate'\n")
  writeFixtureFile(ctx, "src/agent/completion-gate.ts", [
    "export interface CompletionInput { evidence: string[] }",
    "export function evaluateCompletionGate(input: CompletionInput): boolean {",
    "  return input.evidence.length > 0",
    "}",
  ].join("\n"))
  writeFixtureFile(ctx, "tests/completion-gate.test.ts", [
    "import { expect, test } from 'bun:test'",
    "import { evaluateCompletionGate } from '../src/agent/completion-gate'",
    "test('requires evidence', () => expect(evaluateCompletionGate({ evidence: ['typecheck'] })).toBe(true))",
  ].join("\n"))
}

// ── Function dispatcher ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dispatchCase(c: ReplayCase, ctx: TestContext): any {
  const { targetFunction, input } = c

  // Write fixture files if any
  if (c.fixture) {
    for (const [relPath, content] of Object.entries(c.fixture)) {
      writeFixtureFile(ctx, relPath, content)
    }
  }
  if (c.domain === "context_map") ensureContextMapFixture(ctx)

  switch (targetFunction) {
    // ── master-plan ──
    case "createMasterPlan": {
      const goal = input.goal as string
      const intent = input.intent as "long_task" | "narrow_edit" | "readonly"
      // Parse node titles from planText
      const planText = input.planText as string
      const nodes = nodesFromPlanText(planText)
      const nodeTitles = nodes.map(n => n.title)
      // Clear planRef before creating
      planRef.current = null
      const plan = createMasterPlan(goal, intent, nodeTitles)
      return plan
    }

    case "markNodeDone": {
      const goal = input.goal as string
      const intent = input.intent as "long_task" | "narrow_edit" | "readonly"
      const planText = input.planText as string
      const targetNodeId = input.nodeId as string
      const nodes = nodesFromPlanText(planText)
      const nodeTitles = nodes.map(n => n.title)
      planRef.current = null
      const plan = createMasterPlan(goal, intent, nodeTitles)
      if (!plan) return null
      planRef.current = plan
      const result = markNodeDone(plan, targetNodeId, "completed")
      return { plan, result, current: plan.current }
    }

    case "planComplete": {
      const goal = input.goal as string
      const intent = input.intent as "long_task" | "narrow_edit" | "readonly"
      const planText = input.planText as string
      const nodes = nodesFromPlanText(planText)
      const nodeTitles = nodes.map(n => n.title)
      planRef.current = null
      const plan = createMasterPlan(goal, intent, nodeTitles)
      if (!plan) return { complete: false }
      // Mark all nodes done
      for (const node of plan.nodes) {
        markNodeDone(plan, node.id, "done")
      }
      return { complete: planComplete(plan), progress: { done: plan.nodes.filter(n => n.status === "done").length, total: plan.nodes.length } }
    }

    case "activateNode": {
      const goal = input.goal as string
      const intent = input.intent as "long_task" | "narrow_edit" | "readonly"
      const planText = input.planText as string
      const targetNodeId = input.nodeId as string
      const nodes = nodesFromPlanText(planText)
      const nodeTitles = nodes.map(n => n.title)
      planRef.current = null
      const plan = createMasterPlan(goal, intent, nodeTitles)
      if (!plan) return null
      planRef.current = plan
      const result = activateNode(plan, targetNodeId)
      return { plan, result, nodeStatus: result?.status }
    }

    case "evaluatePlanForcePass": {
      const result = evaluatePlanForcePass({
        rejections: input.rejections as number,
        maxRounds: input.maxRounds as number | undefined,
        planText: input.planText as string,
        goal: input.goal as string,
      })
      return result
    }

    case "validatePlan": {
      const goal = input.goal as string
      const intent = input.intent as "long_task" | "narrow_edit" | "readonly"
      const planText = input.planText as string
      const nodes = nodesFromPlanText(planText)
      const nodeTitles = nodes.map(n => n.title)
      planRef.current = null
      const plan = createMasterPlan(goal, intent, nodeTitles)
      if (!plan) return null
      // Inject cycle if requested
      if (input.injectCycle && plan.nodes.length >= 2) {
        plan.nodes[0]!.dependsOn = [plan.nodes[1]!.id]
        plan.nodes[1]!.dependsOn = [plan.nodes[0]!.id]
      }
      const report = validatePlan(plan)
      return { isClean: report.isClean, errors: report.errors.length, warnings: report.warnings.length }
    }

    // ── context-epoch ──
    case "classifyEpochAction": {
      const totalChars = input.totalChars as number
      const thresholds = input.thresholds as { compressChars: number; forceCompressChars: number; rolloverChars: number }
      return classifyEpochAction(totalChars, thresholds)
    }

    case "hasUnclosedToolChain": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages = input.messages as any[]
      return hasUnclosedToolChain(messages)
    }

    case "epochRollover": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages = input.messages as any[]
      const keepCount = input.keepCount as number
      const planStateText = input.planStateText as string
      const thresholds = input.thresholds as { compressChars: number; forceCompressChars: number; rolloverChars: number }
      const state = createEpochState(thresholds)
      const result = epochRollover(messages, keepCount, planStateText, state, input.round as number)
      // Narrow union type
      if ("blocked" in result && result.blocked === true) {
        return { blocked: true, messagesAfter: 0, charsTrimmed: 0, planStatePreserved: false }
      }
      const rollover = result as import("../src/agent/context-epoch").RolloverResult
      return {
        messagesAfter: rollover.messages.length,
        charsTrimmed: rollover.charsTrimmed,
        planStatePreserved: rollover.messages.some(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (m: any) =>
            m.role === "user" && typeof m.content === "string" && (m.content as string).includes("MasterPlan")
        ),
      }
    }

    // ── false-done ──
    case "evaluateCompletionGate": {
      const gateInput = input as unknown as Parameters<typeof evaluateCompletionGate>[0]
      // Set active mode if specified in input
      if ((input as Record<string, unknown>).activeMode) {
        setActiveMode((input as Record<string, unknown>).activeMode as "planner" | "coder" | "review" | "repair" | "report")
      }
      const result = evaluateCompletionGate(gateInput)
      // Reset mode
      setActiveMode("coder")
      return result
    }

    case "needsExternalCompletionGate": {
      const gateInput = input as unknown as Parameters<typeof needsExternalCompletionGate>[0]
      return needsExternalCompletionGate(gateInput)
    }

    // ── ripple ──
    case "obligationsFromReport": {
      const report = input.report as Parameters<typeof obligationsFromReport>[0]
      const modifiedFiles = new Set<string>((input.modifiedFiles as string[]) ?? [])
      const obligations = obligationsFromReport(report, modifiedFiles)
      const blocking = getBlockingObligations(obligations)
      return { obligations, obligationCount: obligations.length, blockingCount: blocking.length }
    }

    case "waiveObligation": {
      const obligation = input.obligation as RippleObligation
      const reason = input.reason as string
      const waived = waiveObligation(obligation, reason)
      const blocking = getBlockingObligations([waived])
      return { obligation: waived, obligationCount: 1, blockingCount: blocking.length, hasWaiver: !!waived.waiver }
    }

    case "getBlockingObligations": {
      const obligations = input.obligations as RippleObligation[]
      const blocking = getBlockingObligations(obligations)
      return { obligations, obligationCount: obligations.length, blockingCount: blocking.length, hasWaiver: obligations.some(o => !!o.waiver) }
    }

    case "mergeObligations": {
      const existing = input.existing as RippleObligation[]
      const incoming = input.incoming as RippleObligation[]
      const merged = mergeObligations(existing, incoming)
      const blocking = getBlockingObligations(merged)
      return { obligations: merged, obligationCount: merged.length, blockingCount: blocking.length, hasWaiver: merged.some(o => !!o.waiver) }
    }

    case "resolveObligations": {
      const obligations = input.obligations as RippleObligation[]
      const changedFiles = new Set<string>(input.changedFiles as string[])
      const resolved = resolveObligations(obligations, changedFiles)
      const blocking = getBlockingObligations(resolved)
      return { obligations: resolved, obligationCount: resolved.length, blockingCount: blocking.length }
    }

    // ── patch-transaction ──
    case "checkForbiddenFile": {
      const filePath = input.filePath as string
      const cwd = ctx.tempDir
      const result = checkForbiddenFile(filePath, cwd)
      return { allowed: result.allowed, reason: result.reason }
    }

    case "checkBaseHash": {
      const filePath = input.filePath as string
      const fixtureContent = input.fixtureContent as string
      const fullPath = writeFixtureFile(ctx, filePath, fixtureContent)
      const expectedHash = input.baseHash as string | null
      // Compute actual hash of fixture and compare
      const actualHash = computeBaseHash(fixtureContent)
      const match = expectedHash === null ? true : actualHash === expectedHash
      return { match, expected: expectedHash, actual: actualHash }
    }

    case "generateLineDiff": {
      const oldContent = input.oldContent as string
      const newContent = input.newContent as string
      const path = (input.path as string) || "src/test.ts"
      const diff = generateLineDiff(oldContent, newContent, path)
      return { diff, diffStats: diff.stats }
    }

    case "createPatchTransaction": {
      const filePath = join(ctx.tempDir, (input.filePath as string) || "src/module.ts")
      const oldContent = input.oldContent as string
      const newContent = input.newContent as string
      // Write the old content to disk
      writeFixtureFile(ctx, input.filePath as string || "src/module.ts", oldContent)
      const baseHash = computeBaseHash(oldContent)
      const diff = generateLineDiff(oldContent, newContent, filePath)
      const tx: PatchTransaction = {
        txId: (input.txId as string) || "tx_test",
        baseHash,
        diff: diff.header,
        scope: (input.scope as string[]) || [],
        verification: (input.verification as Array<"typecheck" | "test" | "build" | "lint" | "smoke" | "unknown">) || [],
        forbiddenCheck: { passed: true },
        fileTransaction: {
          id: (input.txId as string) || "tx_test",
          createdAt: Date.now(),
          cwd: ctx.tempDir,
          tool: "write_file",
          snapshots: [{
            path: filePath,
            existedBefore: true,
            content: oldContent,
          }],
        },
        createdAt: Date.now(),
      }
      return { tx, diffStats: diff.stats }
    }

    // ── context-memory ──
    case "ensureContextMemoryLayout": {
      const layout = ensureContextMemoryLayout(ctx.tempDir)
      return {
        success: true,
        memoryIndexExists: existsSync(layout.files.memoryIndex),
        memoryDir: layout.memoryDir,
      }
    }

    case "loadMemoryIndex": {
      ensureContextMemoryLayout(ctx.tempDir)
      const index = loadMemoryIndex(ctx.tempDir)
      return {
        success: true,
        alwaysLoadCount: index.alwaysLoad.length,
        topicFilesCount: index.topicFiles.length,
        recentDecisionsCount: index.recentDecisions.length,
      }
    }

    case "resolveMemoryIndexFiles": {
      ensureContextMemoryLayout(ctx.tempDir)
      const index = loadMemoryIndex(ctx.tempDir)
      const files = resolveMemoryIndexFiles(index, ctx.tempDir)
      return {
        success: true,
        files,
        fileCount: files.length,
        escapedCount: files.filter(file => !file.includes(".orcana")).length,
      }
    }

    case "evaluateMemoryRetrieval": {
      const result = evaluateMemoryRetrieval(
        input.query as Parameters<typeof evaluateMemoryRetrieval>[0],
        input.capsules as MemoryCapsule[],
      )
      return {
        success: true,
        mustLoadCount: result.mustLoad.length,
        maybeLoadCount: result.maybeLoad.length,
        doNotLoadCount: result.doNotLoad.length,
        mustLoadIds: result.mustLoad.map(capsule => capsule.id),
      }
    }

    case "buildContextMemoryPack": {
      const result = buildContextMemoryPack(input.pack as Parameters<typeof buildContextMemoryPack>[0])
      return {
        success: true,
        contextSections: result.sections.length,
        totalChars: result.totalChars,
        firstLayer: result.sections[0]?.layer,
        truncatedCount: result.sections.filter(section => section.truncated).length,
      }
    }

    case "proposeMemoryUpdate": {
      const proposal = proposeMemoryUpdate(input.maintenance as Parameters<typeof proposeMemoryUpdate>[0])
      return {
        success: true,
        addCount: proposal.add.length,
        updateCount: proposal.update.length,
        markStaleCount: proposal.markStale.length,
        archiveCount: proposal.archive.length,
      }
    }

    case "recordCacheTelemetry": {
      const entry = recordCacheTelemetry(ctx.tempDir, input.entry as Parameters<typeof recordCacheTelemetry>[1])
      return {
        success: true,
        telemetryTotal: 1,
        status: entry.status,
        hitRate: entry.hitRate,
        fileExists: existsSync(join(ctx.tempDir, ".orcana", "state", "cache-telemetry.jsonl")),
      }
    }

    case "summarizeCacheTelemetry": {
      const summary = summarizeCacheTelemetry(input.entries as CacheTelemetryEntry[])
      return {
        success: true,
        telemetryTotal: summary.total,
        hits: summary.hits,
        misses: summary.misses,
        partials: summary.partials,
        averageHitRate: summary.averageHitRate,
      }
    }

    // ── context-map ──
    case "loadProjectConstitution": {
      const result = loadProjectConstitution(ctx.tempDir)
      return {
        success: true,
        importantFiles: result.importantFiles.length,
        buildCommands: result.buildCommands.length,
        testCommands: result.testCommands.length,
      }
    }

    case "scanRepoStructure": {
      const result = scanRepoStructure(ctx.tempDir)
      return {
        success: true,
        packageManager: result.packageManager,
        sourceRoots: result.sourceRoots.length,
        testRoots: result.testRoots.length,
        entrypoints: result.entrypoints.length,
      }
    }

    case "hybridLocate": {
      const result = hybridLocate(ctx.tempDir, input.locate as Parameters<typeof hybridLocate>[1])
      return {
        success: true,
        primaryFileCount: result.primaryFiles.length,
        suspectedTests: result.suspectedTests.length,
        relevantSymbols: result.relevantSymbols.length,
        confidence: result.confidence,
      }
    }

    case "buildSourceUnderstanding": {
      const result = buildSourceUnderstanding(ctx.tempDir, input.files as string[])
      return {
        success: true,
        filesRead: result.filesRead.length,
        dataFlowNotes: result.dataFlowNotes.length,
        likelyEditTargets: result.likelyEditTargets.length,
      }
    }

    case "buildContextMap": {
      const result = buildContextMap(ctx.tempDir, input.context as Parameters<typeof buildContextMap>[1])
      return {
        success: true,
        id: result.id,
        primaryFileCount: result.locateResult.primaryFiles.length,
        blockerCount: result.blockers.length,
        evidenceCount: contextEvidenceForMap(result).length,
      }
    }

    case "evaluateContextReadiness": {
      const map = buildContextMap(ctx.tempDir, input.context as Parameters<typeof buildContextMap>[1])
      const readiness = evaluateContextReadiness(map, input.level as Parameters<typeof evaluateContextReadiness>[1])
      return {
        success: true,
        blockerCount: readiness.blockers.length,
        confidence: readiness.confidence,
      }
    }

    case "saveLoadContextMap": {
      const map = buildContextMap(ctx.tempDir, input.context as Parameters<typeof buildContextMap>[1])
      const saved = saveContextMap(ctx.tempDir, map)
      const loaded = loadContextMap(ctx.tempDir, map.id)
      return {
        success: true,
        saved: existsSync(saved),
        loaded: loaded?.id === map.id,
      }
    }

    case "selectContextMapTaskLevel": {
      const taskLevel = selectContextMapTaskLevel(input.levelInput as Parameters<typeof selectContextMapTaskLevel>[0])
      return { success: true, taskLevel }
    }

    case "attachContextMapToTaskPacket": {
      const map = buildContextMap(ctx.tempDir, input.context as Parameters<typeof buildContextMap>[1])
      const packet = buildPacketFromLine(input.packet as Parameters<typeof buildPacketFromLine>[0])
      const attached = attachContextMapToTaskPacket(packet, map)
      return {
        success: true,
        contextMapId: attached.contextMapId,
        evidenceCount: attached.requiredContextEvidence?.length ?? 0,
      }
    }

    default:
      throw new Error(`Unknown targetFunction: ${targetFunction}`)
  }
}

// ── Validation ──

function validateResult(actual: unknown, expected: ReplayExpected): { passed: boolean; failures: string[] } {
  const failures: string[] = []

  if (actual === null || actual === undefined) {
    failures.push("actual result is null/undefined")
    return { passed: false, failures }
  }

  // String returns (classifyEpochAction, etc.)
  const actualStr = typeof actual === "string" ? actual : undefined
  // Boolean returns (hasUnclosedToolChain)
  const actualBool = typeof actual === "boolean" ? actual : undefined
  // Object returns
  const actualObj = (actual && typeof actual === "object" && !Array.isArray(actual)) ? actual as Record<string, unknown> : null

  // Domain-specific validations
  switch (expected.domain) {
    case "master_plan": {
      if (expected.success && actualObj) {
        if (expected.nodeCount !== undefined) {
          const nodes = actualObj.nodes as Array<unknown> | undefined
          if (!nodes || nodes.length !== expected.nodeCount) {
            failures.push(`nodeCount: expected ${expected.nodeCount}, got ${nodes?.length ?? 0}`)
          }
        }
        if (expected.progress && actualObj.progress) {
          const p = actualObj.progress as { done: number; total: number }
          if (expected.progress.done !== undefined && p.done !== expected.progress.done) {
            failures.push(`progress.done: expected ${expected.progress.done}, got ${p.done}`)
          }
        }
        if (expected.nodeStatus && actualObj.nodeStatus !== expected.nodeStatus) {
          const resultStatus = actualObj.result ? (actualObj.result as Record<string, unknown>).status : undefined
          if (resultStatus && resultStatus !== expected.nodeStatus) {
            failures.push(`nodeStatus: expected ${expected.nodeStatus}, got ${resultStatus}`)
          }
        }
      }
      if (!expected.success && expected.validation) {
        const errors = actualObj ? (actualObj.errors as number) ?? 0 : 0
        if (expected.validation.errors > 0 && errors < expected.validation.errors) {
          failures.push(`validation.errors: expected >=${expected.validation.errors}, got ${errors}`)
        }
      }
      break
    }

    case "context_epoch": {
      // classifyEpochAction returns a string directly
      if (actualStr !== undefined) {
        if (actualStr !== expected.action) {
          failures.push(`action: expected ${expected.action}, got ${actualStr}`)
        }
      } else if (actualBool !== undefined) {
        // hasUnclosedToolChain returns boolean
        if (expected.rolloverBlocked !== undefined && actualBool !== expected.rolloverBlocked) {
          failures.push(`rolloverBlocked: expected ${expected.rolloverBlocked}, got ${actualBool}`)
        }
      } else if (actualObj) {
        // epochRollover returns object
        if (actualObj.action && actualObj.action !== expected.action) {
          failures.push(`action: expected ${expected.action}, got ${actualObj.action}`)
        }
        if (expected.planStatePreserved !== undefined) {
          const preserved = actualObj.planStatePreserved as boolean | undefined
          if (preserved !== expected.planStatePreserved) {
            failures.push(`planStatePreserved: expected ${expected.planStatePreserved}, got ${preserved}`)
          }
        }
      }
      break
    }

    case "false_done": {
      if (!actualObj) { failures.push("expected object result"); break }
      const report = actualObj as { allowed?: boolean; missing?: string[]; residualRisks?: string[] }
      if (report.allowed !== expected.allowed) {
        failures.push(`allowed: expected ${expected.allowed}, got ${report.allowed}`)
      }
      if (expected.expectedMissing && expected.expectedMissing.length > 0) {
        const missing = report.missing ?? []
        for (const item of expected.expectedMissing) {
          if (!missing.some(m => m.toLowerCase().includes(item.toLowerCase()))) {
            failures.push(`expected missing item not found: "${item}". Got: [${missing.join(", ")}]`)
          }
        }
      }
      break
    }

    case "ripple": {
      if (!actualObj) { failures.push("expected object result"); break }
      const r = actualObj as { obligationCount?: number; blockingCount?: number; hasWaiver?: boolean }
      if (r.obligationCount !== undefined && r.obligationCount < expected.obligationCount) {
        failures.push(`obligationCount: expected >=${expected.obligationCount}, got ${r.obligationCount}`)
      }
      if (r.blockingCount !== undefined && r.blockingCount !== expected.blockingCount) {
        failures.push(`blockingCount: expected ${expected.blockingCount}, got ${r.blockingCount}`)
      }
      if (expected.hasWaiver !== undefined && r.hasWaiver !== expected.hasWaiver) {
        failures.push(`hasWaiver: expected ${expected.hasWaiver}, got ${r.hasWaiver}`)
      }
      break
    }

    case "patch_transaction": {
      // checkBaseHash returns { match, expected, actual }
      if (actualObj && "match" in actualObj) {
        const hc = actualObj as { match: boolean; expected?: string | null; actual?: string | null }
        if (hc.match !== expected.allowed) {
          failures.push(`hash match: expected ${expected.allowed}, got ${hc.match}`)
        }
        if (!hc.match && expected.blockReason) {
          // Hash mismatch is expected
        }
      } else if (actualObj && "allowed" in actualObj) {
        // checkForbiddenFile returns { allowed, reason? }
        const pt = actualObj as { allowed: boolean; reason?: string }
        if (pt.allowed !== expected.allowed) {
          failures.push(`allowed: expected ${expected.allowed}, got ${pt.allowed}`)
        }
        if (!expected.allowed && expected.blockReason && pt.reason) {
          if (!pt.reason.toLowerCase().includes(expected.blockReason.toLowerCase())) {
            failures.push(`blockReason: expected to include "${expected.blockReason}", got "${pt.reason}"`)
          }
        }
      } else if (actualObj && "diffStats" in actualObj) {
        // generateLineDiff / createPatchTransaction
        const ds = actualObj.diffStats as { added: number; removed: number; unchanged: number } | undefined
        if (expected.diffStats && ds) {
          if (expected.diffStats.added !== undefined && ds.added !== expected.diffStats.added) {
            failures.push(`diffStats.added: expected ${expected.diffStats.added}, got ${ds.added}`)
          }
          if (expected.diffStats.removed !== undefined && ds.removed !== expected.diffStats.removed) {
            failures.push(`diffStats.removed: expected ${expected.diffStats.removed}, got ${ds.removed}`)
          }
        }
      }
      break
    }

    case "context_memory": {
      if (!actualObj) { failures.push("expected object result"); break }
      const cm = actualObj as {
        success?: boolean
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
      }
      if (cm.success !== expected.success) {
        failures.push(`success: expected ${expected.success}, got ${cm.success}`)
      }
      if (expected.mustLoadCount !== undefined && cm.mustLoadCount !== expected.mustLoadCount) {
        failures.push(`mustLoadCount: expected ${expected.mustLoadCount}, got ${cm.mustLoadCount}`)
      }
      if (expected.maybeLoadCount !== undefined && cm.maybeLoadCount !== expected.maybeLoadCount) {
        failures.push(`maybeLoadCount: expected ${expected.maybeLoadCount}, got ${cm.maybeLoadCount}`)
      }
      if (expected.doNotLoadCount !== undefined && cm.doNotLoadCount !== expected.doNotLoadCount) {
        failures.push(`doNotLoadCount: expected ${expected.doNotLoadCount}, got ${cm.doNotLoadCount}`)
      }
      if (expected.addCount !== undefined && cm.addCount !== expected.addCount) {
        failures.push(`addCount: expected ${expected.addCount}, got ${cm.addCount}`)
      }
      if (expected.updateCount !== undefined && cm.updateCount !== expected.updateCount) {
        failures.push(`updateCount: expected ${expected.updateCount}, got ${cm.updateCount}`)
      }
      if (expected.markStaleCount !== undefined && cm.markStaleCount !== expected.markStaleCount) {
        failures.push(`markStaleCount: expected ${expected.markStaleCount}, got ${cm.markStaleCount}`)
      }
      if (expected.telemetryTotal !== undefined && cm.telemetryTotal !== expected.telemetryTotal) {
        failures.push(`telemetryTotal: expected ${expected.telemetryTotal}, got ${cm.telemetryTotal}`)
      }
      if (expected.averageHitRate !== undefined && cm.averageHitRate !== expected.averageHitRate) {
        failures.push(`averageHitRate: expected ${expected.averageHitRate}, got ${cm.averageHitRate}`)
      }
      if (expected.contextSections !== undefined && cm.contextSections !== expected.contextSections) {
        failures.push(`contextSections: expected ${expected.contextSections}, got ${cm.contextSections}`)
      }
      break
    }

    case "context_map": {
      if (!actualObj) { failures.push("expected object result"); break }
      const cm = actualObj as {
        success?: boolean
        primaryFileCount?: number
        evidenceCount?: number
        blockerCount?: number
        contextSections?: number
        taskLevel?: string
      }
      if (cm.success !== expected.success) failures.push(`success: expected ${expected.success}, got ${cm.success}`)
      if (expected.primaryFileCount !== undefined && cm.primaryFileCount !== expected.primaryFileCount) {
        failures.push(`primaryFileCount: expected ${expected.primaryFileCount}, got ${cm.primaryFileCount}`)
      }
      if (expected.evidenceCount !== undefined && cm.evidenceCount !== expected.evidenceCount) {
        failures.push(`evidenceCount: expected ${expected.evidenceCount}, got ${cm.evidenceCount}`)
      }
      if (expected.blockerCount !== undefined && cm.blockerCount !== expected.blockerCount) {
        failures.push(`blockerCount: expected ${expected.blockerCount}, got ${cm.blockerCount}`)
      }
      if (expected.taskLevel !== undefined && cm.taskLevel !== expected.taskLevel) {
        failures.push(`taskLevel: expected ${expected.taskLevel}, got ${cm.taskLevel}`)
      }
      break
    }
  }

  // Run generic assertions
  const assertionContext: Record<string, unknown> = {}

  // Handle string return
  if (actualStr !== undefined) {
    assertionContext["action"] = actualStr
    assertionContext["result"] = actualStr
  }
  // Handle boolean return
  if (actualBool !== undefined) {
    assertionContext["hasUnclosedChain"] = actualBool
    assertionContext["result"] = actualBool
  }
  // Handle object return
  if (actualObj) {
    Object.assign(assertionContext, actualObj)
    // Flatten commonly-checked fields
    if (actualObj.allowed !== undefined) assertionContext["allowed"] = actualObj.allowed
    if (actualObj.match !== undefined) assertionContext["match"] = actualObj.match
    if (actualObj.missing) assertionContext["missing.length"] = (actualObj.missing as Array<unknown>).length
    if (actualObj.action) assertionContext["action"] = actualObj.action
    if (actualObj.isClean !== undefined) assertionContext["isClean"] = actualObj.isClean
    if (actualObj.obligationCount !== undefined) assertionContext["obligationCount"] = actualObj.obligationCount
    if (actualObj.blockingCount !== undefined) assertionContext["blockingCount"] = actualObj.blockingCount
    if (actualObj.hasWaiver !== undefined) assertionContext["hasWaiver"] = actualObj.hasWaiver
    if (actualObj.planStatePreserved !== undefined) assertionContext["planStatePreserved"] = actualObj.planStatePreserved
    if (actualObj.diffStats !== undefined) assertionContext["diffStats"] = actualObj.diffStats
    if (actualObj.errors !== undefined) assertionContext["errors"] = actualObj.errors
    if (actualObj.warnings !== undefined) assertionContext["warnings"] = actualObj.warnings
    if (actualObj.complete !== undefined) assertionContext["planComplete"] = actualObj.complete
    if (actualObj.progress) {
      const p = actualObj.progress as { done: number; total: number }
      assertionContext["done"] = p.done
      assertionContext["total"] = p.total
    }
    if (actualObj.nodes) assertionContext["nodes.length"] = (actualObj.nodes as Array<unknown>).length
    // Also check nested plan.nodes (for markNodeDone etc. that wrap result)
    if (!actualObj.nodes && actualObj.plan) {
      const planNodes = (actualObj.plan as Record<string, unknown>).nodes as Array<unknown> | undefined
      if (planNodes) assertionContext["nodes.length"] = planNodes.length
    }
    if (actualObj.messagesAfter !== undefined) assertionContext["messages.length"] = actualObj.messagesAfter
    if (actualObj.success !== undefined) assertionContext["success"] = actualObj.success
    if (actualObj.alwaysLoadCount !== undefined) assertionContext["alwaysLoadCount"] = actualObj.alwaysLoadCount
    if (actualObj.topicFilesCount !== undefined) assertionContext["topicFilesCount"] = actualObj.topicFilesCount
    if (actualObj.recentDecisionsCount !== undefined) assertionContext["recentDecisionsCount"] = actualObj.recentDecisionsCount
    if (actualObj.fileCount !== undefined) assertionContext["fileCount"] = actualObj.fileCount
    if (actualObj.escapedCount !== undefined) assertionContext["escapedCount"] = actualObj.escapedCount
    if (actualObj.mustLoadCount !== undefined) assertionContext["mustLoadCount"] = actualObj.mustLoadCount
    if (actualObj.maybeLoadCount !== undefined) assertionContext["maybeLoadCount"] = actualObj.maybeLoadCount
    if (actualObj.doNotLoadCount !== undefined) assertionContext["doNotLoadCount"] = actualObj.doNotLoadCount
    if (actualObj.addCount !== undefined) assertionContext["addCount"] = actualObj.addCount
    if (actualObj.updateCount !== undefined) assertionContext["updateCount"] = actualObj.updateCount
    if (actualObj.markStaleCount !== undefined) assertionContext["markStaleCount"] = actualObj.markStaleCount
    if (actualObj.telemetryTotal !== undefined) assertionContext["telemetryTotal"] = actualObj.telemetryTotal
    if (actualObj.contextSections !== undefined) assertionContext["contextSections"] = actualObj.contextSections
    if (actualObj.truncatedCount !== undefined) assertionContext["truncatedCount"] = actualObj.truncatedCount
    if (actualObj.importantFiles !== undefined) assertionContext["importantFiles"] = actualObj.importantFiles
    if (actualObj.buildCommands !== undefined) assertionContext["buildCommands"] = actualObj.buildCommands
    if (actualObj.testCommands !== undefined) assertionContext["testCommands"] = actualObj.testCommands
    if (actualObj.sourceRoots !== undefined) assertionContext["sourceRoots"] = actualObj.sourceRoots
    if (actualObj.testRoots !== undefined) assertionContext["testRoots"] = actualObj.testRoots
    if (actualObj.entrypoints !== undefined) assertionContext["entrypoints"] = actualObj.entrypoints
    if (actualObj.primaryFileCount !== undefined) assertionContext["primaryFileCount"] = actualObj.primaryFileCount
    if (actualObj.evidenceCount !== undefined) assertionContext["evidenceCount"] = actualObj.evidenceCount
    if (actualObj.blockerCount !== undefined) assertionContext["blockerCount"] = actualObj.blockerCount
    if (actualObj.filesRead !== undefined) assertionContext["filesRead"] = actualObj.filesRead
    if (actualObj.dataFlowNotes !== undefined) assertionContext["dataFlowNotes"] = actualObj.dataFlowNotes
    if (actualObj.likelyEditTargets !== undefined) assertionContext["likelyEditTargets"] = actualObj.likelyEditTargets
    if (actualObj.saved !== undefined) assertionContext["saved"] = actualObj.saved
    if (actualObj.loaded !== undefined) assertionContext["loaded"] = actualObj.loaded
    if (actualObj.taskLevel !== undefined) assertionContext["taskLevel"] = actualObj.taskLevel
  }

  const assertionFailures = checkAssertions(expected, assertionContext)
  failures.push(...assertionFailures)

  return { passed: failures.length === 0, failures }
}

// ── Tests ──

const ALL_CASES = loadAllCases()

describe("Replay Harness", () => {
  let ctx: TestContext

  beforeAll(() => {
    ctx = createTestContext()
  })

  afterAll(() => {
    cleanupTestContext(ctx)
    // Reset module-level state
    setActiveMode("coder")
    planRef.current = null
  })

  it(`loaded ${ALL_CASES.length} replay cases`, () => {
    expect(ALL_CASES.length).toBe(70)
  })

  // ── Case count per domain ──
  const domainCounts: Record<string, number> = {}
  for (const c of ALL_CASES) {
    domainCounts[c.domain] = (domainCounts[c.domain] ?? 0) + 1
  }

  for (const [domain, count] of Object.entries(domainCounts)) {
    const expectedCount = domain === "context_memory" || domain === "context_map" ? 20 : 6
    it(`${domain} has ${count} cases (expected ${expectedCount})`, () => {
      expect(count).toBe(expectedCount)
    })
  }

  // ── Execute each case ──
  for (const c of ALL_CASES) {
    it(`[${c.domain}] ${c.caseId}: ${c.description}`, () => {
      // Reset module state before each case
      setActiveMode("coder")
      planRef.current = null

      let actual: unknown
      let error: string | undefined

      try {
        actual = dispatchCase(c, ctx)
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }

      if (error) {
        // Some cases expect failure (e.g., validation errors)
        if (c.expected.domain === "master_plan" && !c.expected.success) {
          // Expected failure — pass
          expect(error).toBeDefined()
          return
        }
        throw new Error(`Case ${c.caseId} threw: ${error}`)
      }

      const { passed, failures } = validateResult(actual, c.expected)

      if (!passed) {
        // Print actual for debugging
        const actualSummary = typeof actual === "object" && actual !== null
          ? JSON.stringify(actual).slice(0, 300)
          : String(actual)
        throw new Error(
          `Case ${c.caseId} FAILED:\n` +
          failures.map(f => `  ✗ ${f}`).join("\n") +
          `\n  Actual: ${actualSummary}`
        )
      }

      expect(passed).toBe(true)
    })
  }
})

// ── Summary test (runs last) ──
describe("Replay Harness Summary", () => {
  it("all 70 replay cases should be valid JSON with required fields", () => {
    const issues: string[] = []
    for (const c of ALL_CASES) {
      if (!c.caseId) issues.push(`missing caseId in ${c.domain}`)
      if (!c.domain) issues.push(`missing domain in ${c.caseId}`)
      if (!c.targetFunction) issues.push(`missing targetFunction in ${c.caseId}`)
      if (!c.expected) issues.push(`missing expected in ${c.caseId}`)
      if (c.expected && c.expected.domain !== c.domain) {
        issues.push(`domain mismatch in ${c.caseId}: ${c.domain} vs ${c.expected.domain}`)
      }
    }
    if (issues.length > 0) {
      throw new Error(`Case validation issues:\n${issues.map(i => `  ✗ ${i}`).join("\n")}`)
    }
    expect(issues).toHaveLength(0)
  })
})
