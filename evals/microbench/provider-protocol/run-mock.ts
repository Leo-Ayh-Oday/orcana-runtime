/** ORMB-PP mock 套件 runner —— 跑 30 个确定性用例并产出详细报告。
 *
 *  不碰网络：每个用例注入 mock client，只验证 DeepSeekProvider 解析层行为。
 *  报告逐用例打印断言 + 事件 trace，聚合 8 项 Hard Gate 计数。
 */

import { execSync } from "node:child_process"
import { DeepSeekProvider } from "../../../src/provider/deepseek"
import type { StreamEvent } from "../../../src/provider/types"
import { makeMockClient } from "./mock-client"
import type { MBEMockCase, MBEMockContext, MBEAssertion } from "../contracts/case"
import type { MBECaseResult, MBEHdr, MBEReport, TraceEntry } from "../contracts/result"
import { HARD_GATES, type HardGateName } from "../contracts/metrics"
import { MOCK_CASES } from "./cases"

export const MOCK_OPTS = {
  model: "deepseek-v4-flash",
  purpose: "agent_main" as const,
  system: "system",
  messages: [{ role: "user" as const, content: "hello" }],
  tools: [] as unknown[],
  maxTokens: 1024,
}

export function currentCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8", cwd: new URL("../../..", import.meta.url).pathname }).trim()
  } catch {
    return "unknown"
  }
}

function toTrace(events: StreamEvent[]): TraceEntry[] {
  return events.map((e, i) => ({
    type: e.type,
    data: e.type === "text" ? String(e.data).slice(0, 60) : e.data,
    seq: i + 1,
  }))
}

async function collectRound(
  provider: DeepSeekProvider,
  opts: typeof MOCK_OPTS,
  abortSignal?: AbortSignal,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const ev of provider.streamChat({ ...opts, abortSignal })) {
    out.push(ev)
  }
  return out
}

async function runMockCase(def: MBEMockCase): Promise<MBECaseResult> {
  const sleeps: number[] = []
  const controller = new AbortController()
  const mock = makeMockClient(def.streams)
  const provider = new DeepSeekProvider("test-key", {
    client: mock.client as never,
    maxRetries: def.maxRetries ?? 0,
    sleep: async (ms: number) => {
      sleeps.push(ms)
    },
  })

  const start = performance.now()
  const allEvents: StreamEvent[] = []
  let error: string | undefined

  const signal = def.abortWhen ? controller.signal : undefined
  const abortWhen = def.abortWhen ?? (() => false)

  try {
    if (def.twoRound) {
      const r1 = await collectRound(provider, MOCK_OPTS, signal)
      allEvents.push(...r1)
      const tc = r1.filter((e) => e.type === "tool_call")
      if (tc.length > 0) {
        const first = tc[0]!.data as { id: string; name: string; input: Record<string, unknown> }
        const messages = [
          ...MOCK_OPTS.messages,
          { role: "assistant" as const, content: [{ type: "tool_use" as const, id: first.id, name: first.name, input: first.input }] },
          { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: first.id, content: `mock result for ${first.name}` }] },
        ]
        const r2 = await collectRound(provider, { ...MOCK_OPTS, messages: messages as never }, signal)
        allEvents.push(...r2)
      }
    } else {
      for await (const ev of provider.streamChat({ ...MOCK_OPTS, abortSignal: signal })) {
        allEvents.push(ev)
        if (abortWhen(ev)) controller.abort()
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const durationMs = Math.round(performance.now() - start)

  const ctx: MBEMockContext = { events: allEvents, calls: mock.calls, closed: mock.closed, sleepsMs: sleeps }
  const assertions = def.assert(ctx)
  const failures = assertions.filter((a) => !a.passed)
  const passed = failures.length === 0 && error === undefined

  const usage = allEvents
    .filter((e) => e.type === "token_usage")
    .reduce<Record<string, unknown>>((acc, e) => Object.assign(acc, e.data as object), {})

  return {
    caseId: def.caseId,
    title: def.title,
    tags: def.tags,
    passed,
    assertions,
    failures: failures.map((f) => f.label),
    trace: toTrace(allEvents),
    calls: mock.calls,
    retries: Math.max(0, mock.calls - 1),
    sleepsMs: sleeps,
    durationMs,
    usage: Object.keys(usage).length > 0 ? usage : undefined,
    modelRequested: MOCK_OPTS.model,
    error,
  }
}

export function buildHeader(suite: string, reasoningEffort: string): MBEHdr {
  return {
    suite,
    orcanaCommit: currentCommit(),
    modelRequested: MOCK_OPTS.model,
    reasoningEffort,
    seed: 42,
    configurationDigest: "PP-mock-v1",
    startedAt: new Date().toISOString(),
  }
}

export async function runMockSuite(): Promise<MBEReport> {
  const cases: MBECaseResult[] = []
  for (const def of MOCK_CASES) {
    cases.push(await runMockCase(def))
  }

  const hardGates: Partial<Record<HardGateName, number>> = {}
  for (const g of HARD_GATES) hardGates[g] = 0
  for (const r of cases) {
    for (const a of r.assertions) {
      if (!a.passed && a.gate) hardGates[a.gate] = (hardGates[a.gate] ?? 0) + 1
    }
  }

  const passed = cases.filter((c) => c.passed).length
  return {
    header: buildHeader("ORMB-PP", "none"), // mock 不涉及 thinking config
    suite: "ORMB-PP",
    cases,
    hardGates,
    summary: { total: cases.length, passed, failed: cases.length - passed, passRate: Math.round((passed / cases.length) * 1000) / 10 },
    generatedAt: new Date().toISOString(),
  }
}

// ── 报告打印 ──

export function printMockReport(report: MBEReport): void {
  const { header, summary, hardGates } = report
  console.log(`\n═══ ${report.suite} — mock 套件（确定性，无网络）═══`)
  console.log(`   commit=${header.orcanaCommit} model=${header.modelRequested} seed=${header.seed} digest=${header.configurationDigest}`)

  for (const c of report.cases) {
    const mark = c.passed ? "✅" : "❌"
    console.log(`\n${mark} ${c.caseId} ${c.title} [${c.tags.join(" ")}]`)
    if (c.description) console.log(`   ${c.description}`)
    for (const a of c.assertions) {
      const icon = a.passed ? "  ·" : "  ✗"
      console.log(`${icon} ${a.label}${a.gate ? ` [gate:${a.gate}]` : ""}${a.passed ? "" : ` — ${a.detail}`}`)
    }
    if (c.error) console.log(`   ⚠ 抛错: ${c.error}`)
    const traceSummary = c.trace.map((t) => (t.type === "text" ? `text(${String(t.data)})` : t.type)).join(" → ")
    console.log(`   trace: ${traceSummary.slice(0, 220)}`)
    console.log(`   calls=${c.calls} retries=${c.retries} sleeps=[${c.sleepsMs.join(",")}] ${c.durationMs}ms`)
    if (c.usage) console.log(`   usage: ${JSON.stringify(c.usage)}`)
  }

  console.log(`\n── 汇总 ──`)
  console.log(`   ${summary.passed}/${summary.total} 通过，通过率 ${summary.passRate}%（mock 全过 + live P0 全过才满足计划 §9 P0）`)
  console.log(`   Hard Gates（必须全 0）：`)
  for (const g of HARD_GATES) {
    const n = hardGates[g] ?? 0
    console.log(`     ${n === 0 ? "✅" : "❌"} ${g} = ${n}`)
  }
}
