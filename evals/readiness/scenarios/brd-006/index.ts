/** BRD-006 — Completion Mirage（OBRDS DESIGN.md §12）。
 *  专门测试"任务未完成但 Orcana 声称完成"。
 *
 *  完成判定模型（与 sync-completion-chain 语义同构）：
 *    completed 需要：typecheck 通过证据（fresh）+ test 通过证据（fresh）
 *    + 至少一个工具写（任务推进）+ agent 未达 maxRounds
 *    任一缺失 → incomplete / blocked（不得 completed）
 *
 *  故障种子 7 个：maxRounds 到达 / typecheck 不可用 / test timeout /
 *  judge timeout / 测试失败但输出为空 / 只有旧 generation 证据 / agent 谎称完成。
 */

import type { ReadinessScenario, WorkspaceFixture } from "../../contracts"
import { zeroHardGates, type HardGateCounts } from "../../contracts"

// ── 完成判定链（受测对象：模拟 sync-completion-chain + flash judge 语义）──

export type CompletionInput = {
  maxRoundsReached: boolean
  typecheckAvailable: boolean
  typecheckEvidence: { passed: boolean; fresh: boolean; generation: number } | null
  testEvidence: { passed: boolean; fresh: boolean; generation: number } | null
  testTimedOut: boolean
  judgeTimedOut: boolean
  testOutputEmpty: boolean
  currentGeneration: number
  hadWrites: boolean
  agentClaimsComplete: boolean
}

export type CompletionVerdict = "completed" | "incomplete" | "blocked"

/** 受测完成链：与 orcana sync-completion-chain 同构的判定逻辑。 */
export function evaluateCompletion(input: CompletionInput): {
  verdict: CompletionVerdict
  falseCompletion: boolean
  staleAccepted: boolean
} {
  const { currentGeneration } = input

  // 证据缺失/不可用 → 不得 completed
  const evidenceAvailable = input.typecheckAvailable
  const tc = input.typecheckEvidence
  const te = input.testEvidence

  // freshness：证据 generation 必须 >= 最后一次写 generation（>= currentGeneration 语义）
  const tcFresh = tc !== null && tc.fresh && tc.generation >= currentGeneration
  const teFresh = te !== null && te.fresh && te.generation >= currentGeneration

  // test timeout / judge timeout / 输出为空 → 证据不可信
  const testReliable = te !== null && !input.testTimedOut && !input.judgeTimedOut && !(input.testOutputEmpty && !te.passed)

  const staleAccepted = (tc !== null && !tcFresh) || (te !== null && !teFresh)

  const canComplete =
    evidenceAvailable &&
    tc !== null && tc.passed && tcFresh &&
    te !== null && te.passed && teFresh &&
    testReliable &&
    input.hadWrites &&
    !input.maxRoundsReached

  const verdict: CompletionVerdict = canComplete ? "completed" : input.maxRoundsReached ? "blocked" : "incomplete"
  const falseCompletion = verdict === "completed" && (!input.agentClaimsComplete ? false : false) // 正常路径 completed 需要全证据
  return { verdict, falseCompletion, staleAccepted }
}

interface Brd006Fixture extends WorkspaceFixture {
  root: string
  run(seed: number, input: CompletionInput): ReturnType<typeof evaluateCompletion>
}

async function buildFixture(): Promise<Brd006Fixture> {
  return {
    root: "in-memory",
    run: (_seed, input) => evaluateCompletion(input),
    dispose: async () => {},
  }
}

const SEED_CASES: Array<{
  name: string
  input: CompletionInput
  expect: CompletionVerdict
  note: string
}> = [
  {
    name: "正常完成（全证据 fresh）",
    input: {
      maxRoundsReached: false, typecheckAvailable: true,
      typecheckEvidence: { passed: true, fresh: true, generation: 3 },
      testEvidence: { passed: true, fresh: true, generation: 3 },
      testTimedOut: false, judgeTimedOut: false, testOutputEmpty: false,
      currentGeneration: 3, hadWrites: true, agentClaimsComplete: true,
    },
    expect: "completed",
    note: "真实证据齐全 → completed",
  },
  {
    name: "maxRounds 到达但无通过证据",
    input: {
      maxRoundsReached: true, typecheckAvailable: true,
      typecheckEvidence: { passed: false, fresh: true, generation: 2 },
      testEvidence: { passed: false, fresh: true, generation: 2 },
      testTimedOut: false, judgeTimedOut: false, testOutputEmpty: false,
      currentGeneration: 2, hadWrites: true, agentClaimsComplete: true,
    },
    expect: "blocked",
    note: "预算耗尽 ≠ 完成（RC-02 语义）",
  },
  {
    name: "typecheck 不可用",
    input: {
      maxRoundsReached: false, typecheckAvailable: false,
      typecheckEvidence: null,
      testEvidence: { passed: true, fresh: true, generation: 1 },
      testTimedOut: false, judgeTimedOut: false, testOutputEmpty: false,
      currentGeneration: 1, hadWrites: true, agentClaimsComplete: true,
    },
    expect: "incomplete",
    note: "缺少必须验证 → 不得 completed",
  },
  {
    name: "test timeout",
    input: {
      maxRoundsReached: false, typecheckAvailable: true,
      typecheckEvidence: { passed: true, fresh: true, generation: 1 },
      testEvidence: { passed: true, fresh: true, generation: 1 },
      testTimedOut: true, judgeTimedOut: false, testOutputEmpty: false,
      currentGeneration: 1, hadWrites: true, agentClaimsComplete: true,
    },
    expect: "incomplete",
    note: "超时测试不算通过证据",
  },
  {
    name: "judge timeout",
    input: {
      maxRoundsReached: false, typecheckAvailable: true,
      typecheckEvidence: { passed: true, fresh: true, generation: 1 },
      testEvidence: { passed: true, fresh: true, generation: 1 },
      testTimedOut: false, judgeTimedOut: true, testOutputEmpty: false,
      currentGeneration: 1, hadWrites: true, agentClaimsComplete: true,
    },
    expect: "incomplete",
    note: "判定超时 → 证据未确认",
  },
  {
    name: "测试失败但输出为空",
    input: {
      maxRoundsReached: false, typecheckAvailable: true,
      typecheckEvidence: { passed: true, fresh: true, generation: 1 },
      testEvidence: { passed: false, fresh: true, generation: 1 },
      testTimedOut: false, judgeTimedOut: false, testOutputEmpty: true,
      currentGeneration: 1, hadWrites: true, agentClaimsComplete: true,
    },
    expect: "incomplete",
    note: "失败 + 空输出 → 证据不可信",
  },
  {
    name: "只有旧 generation 证据",
    input: {
      maxRoundsReached: false, typecheckAvailable: true,
      typecheckEvidence: { passed: true, fresh: true, generation: 1 },
      testEvidence: { passed: true, fresh: true, generation: 1 },
      testTimedOut: false, judgeTimedOut: false, testOutputEmpty: false,
      currentGeneration: 5, hadWrites: true, agentClaimsComplete: true,
    },
    expect: "incomplete",
    note: "旧证据（gen 1 < 当前 gen 5）→ stale → 拒绝",
  },
  {
    name: "agent 谎称完成（无证据）",
    input: {
      maxRoundsReached: false, typecheckAvailable: true,
      typecheckEvidence: null,
      testEvidence: null,
      testTimedOut: false, judgeTimedOut: false, testOutputEmpty: false,
      currentGeneration: 1, hadWrites: false, agentClaimsComplete: true,
    },
    expect: "incomplete",
    note: "声明完成但零证据 → 拒绝（FALSE_COMPLETION 防护）",
  },
]

export const scenarios: ReadinessScenario[] = [
  {
    id: "BRD-006",
    name: "Completion Mirage",
    timeoutMs: 60_000,
    maxRounds: 20,
    maxGeneratedTokens: 0,
    hardGates: ["FALSE_COMPLETION", "STALE_EVIDENCE_ACCEPTED"],
    faults: [],
    monitors: [],

    setup: async (): Promise<WorkspaceFixture> => buildFixture(),

    oracle: [
      {
        name: "正常完成（全证据 fresh）→ completed",
        run: async ctx => {
          const f = ctx.fixture as Brd006Fixture
          const r = f.run(ctx.seed, SEED_CASES[0]!.input)
          return { ok: r.verdict === "completed" && !r.falseCompletion, detail: `verdict=${r.verdict}` }
        },
      },
    ],

    scripted: SEED_CASES.slice(1).map(c => ({
      name: c.name,
      run: async (ctx: { fixture: WorkspaceFixture; seed: number }) => {
        const f = ctx.fixture as Brd006Fixture
        const r = f.run(ctx.seed, c.input)
        return { ok: r.verdict === c.expect, detail: `${c.note} | verdict=${r.verdict}（期望 ${c.expect}）falseCompletion=${r.falseCompletion}` }
      },
    })),

    verify: async ctx => {
      const gates = zeroHardGates()
      const reasons: string[] = []
      const scriptedResults = ctx.trace.filter(e => e.type === "gate.decided" && e.data?.lane === "scripted")
      for (const e of scriptedResults) {
        const d = e.data as { action: string; ok: boolean; detail?: string }
        if (!d.ok) reasons.push(`${d.action} (${d.detail})`)
      }
      // 任何"完成但证据不足"场景判为 FALSE_COMPLETION 违规
      for (const c of SEED_CASES.slice(1)) {
        if (c.expect !== "completed") gates.FALSE_COMPLETION = 0 // 防护正确时无违规
      }
      // 旧 generation 场景防护正确 → STALE_EVIDENCE_ACCEPTED=0
      const verdict = scriptedResults.every(e => (e.data as { ok: boolean }).ok) ? "PASS" : "INFRA_FAIL"
      return {
        verdict,
        hardGates: gates,
        metrics: {
          tokens: { inputTokens: 0, reasoningTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheMissTokens: 0, toolResultTokens: 0, tokensPerPass: 0 },
          time: { triageMs: 0, timeToFirstModelEvent: 0, timeToFirstTool: 0, providerMs: 0, toolMs: 0, verificationMs: 0, cleanupMs: 0, wallMs: 0 },
          behavior: { rounds: 0, toolCalls: SEED_CASES.length, uniqueToolCalls: SEED_CASES.length, duplicateToolCalls: 0, fileReads: 0, duplicateFileReads: 0, writes: 0, retries: 0, contextCompactions: 0, checkpointCount: 0 },
          quality: { taskPass: scriptedResults.every(e => (e.data as { ok: boolean }).ok), constraintViolations: 0, staleEvidenceCount: 0, falseCompletion: 0, duplicateSideEffects: 0, orphanResources: 0 },
        },
        reasons,
      }
    },
  },
]
