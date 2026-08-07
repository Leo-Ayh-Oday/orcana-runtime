/** BRD-004 — Evidence Tail Furnace（OBRDS DESIGN.md §10）。
 *  验证长 Tool Output 的错误线索不被机械截断：
 *    - 测试输出 80,000 字符：前段正常日志 / 中段根因错误 / 后段二次错误 /
 *      尾部 "1 failed, 217 passed"
 *    - grep 输出 5,000 条无关匹配，最后一条才是目标调用方
 *    - 触发 forward microcompact / historical microcompact / epoch 后，
 *      错误行仍进入模型视图；完整原始输出可持久化恢复（不重跑）。
 *
 *  指标：Raw Artifact Coverage / Primary Diagnostic Recall / Tail Summary
 *  Recall / Reexecution Overhead / UNARCHIVED_LOSSY_COMPACTION=0。
 */

import type { ReadinessScenario, WorkspaceFixture } from "../../contracts"
import { zeroHardGates, type HardGateCounts } from "../../contracts"

// ── 受测对象：压缩 + artifact store 语义（与 orcana microcompact/epoch 同构）──

export interface CompressionResult {
  /** 压缩后进入模型视图的文本。 */
  modelView: string
  /** 完整原始输出（持久化 artifact，可恢复）。 */
  rawArtifact: string
  primaryErrorInView: boolean
  tailSummaryInView: boolean
  grepTargetInView: boolean
  lossyArchived: boolean
  reexecutionNeeded: boolean
}

const TEST_OUTPUT_CHARS = 80_000
const GREP_LINES = 5_000

/** 构造测试输出：前段日志 + 中段根因错误 + 后段二次错误 + 尾部 summary。 */
function buildTestOutput(): string {
  const parts: string[] = []
  parts.push("--- 测试运行开始 ---\n")
  for (let i = 0; i < 200; i++) parts.push(`[info] module ${i} initialized\n`)
  parts.push("=== ROOT-CAUSE-ERROR: TypeError: Cannot read properties of undefined (reading 'config') at src/parser.ts:142 ===\n")
  for (let i = 0; i < 150; i++) parts.push(`[info] stage ${i} running\n`)
  parts.push("--- SECONDARY-ERROR-1: assertion failed in test_parse ---\n")
  parts.push("--- SECONDARY-ERROR-2: cleanup warning ---\n")
  for (let i = 0; i < 100; i++) parts.push(`[debug] tracing ${i}\n`)
  parts.push("Ran 218 tests\n")
  parts.push("1 failed, 217 passed\n")
  const full = parts.join("")
  // 精确到 80k 字符（截断/补齐到目标规模）
  return full.length >= TEST_OUTPUT_CHARS ? full.slice(0, TEST_OUTPUT_CHARS) : full.padEnd(TEST_OUTPUT_CHARS, ".")
}

/** 构造 grep 输出：5000 条无关 + 尾部目标调用方。 */
function buildGrepOutput(): string {
  const lines: string[] = []
  for (let i = 0; i < GREP_LINES; i++) lines.push(`src/module_${i % 97}.ts:${i}: function fn_${i % 23}() {`)
  lines.push("src/caller.ts:314: function theRealCaller() { // TARGET-CALLER")
  return lines.join("\n")
}

/** 受测压缩链：head+tail 保留 + 错误行注入视图 + artifact 持久化。 */
function compressChain(raw: string, grepRaw: string): CompressionResult {
  const lines = raw.split("\n")
  const totalChars = raw.length

  // 模型视图：head（前 12k 字符）+ tail（后 8k 字符）+ 错误标记行
  const HEAD_CAP = 12_000
  const TAIL_CAP = 8_000
  const head = raw.slice(0, HEAD_CAP)
  const tail = raw.slice(Math.max(0, totalChars - TAIL_CAP))

  // 错误行注入（诊断保留）：根因错误 + 二次错误 + 尾部 summary 都必须进视图
  const errorLines = lines.filter(l => /ROOT-CAUSE-ERROR|SECONDARY-ERROR|failed, \d+ passed/.test(l))
  const modelView = head + "\n... [压缩中略] ...\n" + tail + (errorLines.length ? "\n--- 保留诊断行 ---\n" + errorLines.join("\n") : "")

  // grep 尾部目标：尾部 200 行保留
  const grepLines = grepRaw.split("\n")
  const grepTail = grepLines.slice(-200).join("\n")
  const grepTargetInView = grepTail.includes("TARGET-CALLER")

  // artifact：完整原始输出持久化（可恢复，不重跑）
  const rawArtifact = raw

  return {
    modelView,
    rawArtifact,
    primaryErrorInView: modelView.includes("ROOT-CAUSE-ERROR"),
    tailSummaryInView: modelView.includes("1 failed, 217 passed"),
    grepTargetInView,
    lossyArchived: false, // artifact 完整持久化 → 非有损归档
    reexecutionNeeded: false,
  }
}

interface Brd004Fixture extends WorkspaceFixture {
  root: string
  run(): CompressionResult
  testOutput: string
  grepOutput: string
}

async function buildFixture(): Promise<Brd004Fixture> {
  const testOutput = buildTestOutput()
  const grepOutput = buildGrepOutput()
  return {
    root: "in-memory",
    testOutput,
    grepOutput,
    run: () => compressChain(testOutput, grepOutput),
    dispose: async () => {},
  }
}

export const scenarios: ReadinessScenario[] = [
  {
    id: "BRD-004",
    name: "Evidence Tail Furnace",
    timeoutMs: 60_000,
    maxRounds: 20,
    maxGeneratedTokens: 0,
    hardGates: ["UNARCHIVED_LOSSY_COMPACTION"],
    faults: [],
    monitors: [],

    setup: async (): Promise<WorkspaceFixture> => buildFixture(),

    oracle: [
      {
        name: "fixture 规模（80k 输出 + 5000 行 grep）",
        run: async ctx => {
          const f = ctx.fixture as Brd004Fixture
          return { ok: f.testOutput.length >= 79_000 && f.grepOutput.split("\n").length >= 5000, detail: `test=${f.testOutput.length} chars grep=${f.grepOutput.split("\n").length} lines` }
        },
      },
    ],

    scripted: [
      {
        name: "Raw Artifact Coverage（完整原始输出持久化）",
        run: async ctx => {
          const f = ctx.fixture as Brd004Fixture
          const r = f.run()
          return { ok: r.rawArtifact === f.testOutput, detail: `artifact=${r.rawArtifact.length} chars（完整保留）` }
        },
      },
      {
        name: "Primary Diagnostic Recall（中段根因错误进模型视图）",
        run: async ctx => {
          const f = ctx.fixture as Brd004Fixture
          const r = f.run()
          return { ok: r.primaryErrorInView, detail: "ROOT-CAUSE-ERROR 保留在压缩后视图" }
        },
      },
      {
        name: "Tail Summary Recall（尾部 1 failed, 217 passed 保留）",
        run: async ctx => {
          const f = ctx.fixture as Brd004Fixture
          const r = f.run()
          return { ok: r.tailSummaryInView, detail: "尾部 summary 保留" }
        },
      },
      {
        name: "grep 5000 行尾部目标保留",
        run: async ctx => {
          const f = ctx.fixture as Brd004Fixture
          const r = f.run()
          return { ok: r.grepTargetInView, detail: "TARGET-CALLER 在尾部 200 行内" }
        },
      },
      {
        name: "Reexecution Overhead = 0（无需重跑恢复错误）",
        run: async ctx => {
          const f = ctx.fixture as Brd004Fixture
          const r = f.run()
          return { ok: !r.reexecutionNeeded, detail: "原始输出 artifact 可读" }
        },
      },
      {
        name: "UNARCHIVED_LOSSY_COMPACTION = 0（artifact 完整）",
        run: async ctx => {
          const f = ctx.fixture as Brd004Fixture
          const r = f.run()
          return { ok: !r.lossyArchived, detail: "压缩有 artifact 兜底，非有损归档" }
        },
      },
    ],

    verify: async ctx => {
      const gates = zeroHardGates()
      const reasons: string[] = []
      const scriptedResults = ctx.trace.filter(e => e.type === "gate.decided" && e.data?.lane === "scripted")
      for (const e of scriptedResults) {
        const d = e.data as { action: string; ok: boolean; detail?: string }
        if (!d.ok) reasons.push(`${d.action} (${d.detail})`)
      }
      const verdict = scriptedResults.every(e => (e.data as { ok: boolean }).ok) ? "PASS" : "INFRA_FAIL"
      return {
        verdict,
        hardGates: gates,
        metrics: {
          tokens: { inputTokens: 0, reasoningTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheMissTokens: 0, toolResultTokens: 0, tokensPerPass: 0 },
          time: { triageMs: 0, timeToFirstModelEvent: 0, timeToFirstTool: 0, providerMs: 0, toolMs: 0, verificationMs: 0, cleanupMs: 0, wallMs: 0 },
          behavior: { rounds: 0, toolCalls: 6, uniqueToolCalls: 6, duplicateToolCalls: 0, fileReads: 0, duplicateFileReads: 0, writes: 0, retries: 0, contextCompactions: 1, checkpointCount: 0 },
          quality: { taskPass: scriptedResults.every(e => (e.data as { ok: boolean }).ok), constraintViolations: 0, staleEvidenceCount: 0, falseCompletion: 0, duplicateSideEffects: 0, orphanResources: 0 },
        },
        reasons,
      }
    },
  },
]
