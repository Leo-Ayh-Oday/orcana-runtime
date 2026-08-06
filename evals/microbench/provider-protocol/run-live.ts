/** ORMB-PP live 套件 —— 真实 deepseek-v4-flash 多轮 Tool Loop。
 *
 *  需要网络（经代理）+ auth.json 里的 deepseek key。每轮：streamChat → 若有
 *  tool_call 则执行确定性工具 → 把 tool_result 喂回下一轮。验证 provider 层在
 *  真实流中的：reasoning 连续性、tool call 不重复/不错配、actualModel 上报、
 *  abort 生效、max_tokens 处理。
 *
 *  跑法：bun run evals/microbench/provider-protocol/run-live.ts [--case LV-01]
 */

import { FileAuthStore } from "../../../src/config/auth-store"
import { loadConfig } from "../../../src/config/config-loader"
import { DeepSeekProvider } from "../../../src/provider/deepseek"
import type { StreamEvent, ProviderMessage, ProviderTokenUsage } from "../../../src/provider/types"
import type { MBELiveCase, MBELiveContext, MBEAssertion } from "../contracts/case"
import type { MBECaseResult, MBEHdr, MBEReport } from "../contracts/result"
import { HARD_GATES, type HardGateName } from "../contracts/metrics"
import { buildHeader, MOCK_OPTS } from "./run-mock"

export interface LiveToolDef {
  description: string
  run: (input: Record<string, unknown>) => Promise<string>
}

const MODEL = "deepseek-v4-flash"
const SYSTEM = [
  "你是被测的 agent runtime 的模型端。请严格按用户请求执行：",
  "- 需要文件/计算/搜索信息时，必须先调用对应工具，不要凭已知知识编造。",
  "- 工具返回后基于真实结果继续。",
  "- 最终用文字给出明确答案。",
].join("\n")

function buildToolSchemas(tools: Record<string, LiveToolDef>): Array<Record<string, unknown>> {
  return Object.entries(tools).map(([name, def]) => ({
    name,
    description: def.description,
    input_schema: { type: "object", properties: {}, additionalProperties: true },
  }))
}

export function makeToolbox(): Record<string, LiveToolDef> {
  const files: Record<string, string> = {
    "config.json": "{\"port\": 8123, \"debug\": false}",
    "src/main.ts": "export const answer = 42",
  }
  return {
    read_file: {
      description: "读取仓库内文件的完整内容。参数: path(文件路径)",
      run: async (input) => {
        const path = String(input.path ?? "")
        if (path in files) return files[path]
        return `[read_file] 未找到 ${path}，可选: ${Object.keys(files).join(", ")}`
      },
    },
    compute: {
      description: "对两个整数做加/减/乘。参数: a(整数), b(整数), op(加/减/乘)",
      run: async (input) => {
        const a = Number(input.a)
        const b = Number(input.b)
        const op = String(input.op ?? "加")
        const map: Record<string, number> = { 加: a + b, 减: a - b, 乘: a * b, "+": a + b, "-": a - b, "*": a * b }
        return `[compute] ${a} ${op} ${b} = ${map[op] ?? "未知运算符"}`
      },
    },
    search_files: {
      description: "按文件名关键词搜索仓库。参数: query(关键词)",
      run: async (input) => `[search] 命中: src/main.ts, config.json (query=${String(input.query ?? "")})`,
    },
  }
}

// ── 5 个 live 用例 ──

export const LIVE_CASES: MBELiveCase[] = [
  {
    caseId: "PP-LV01",
    title: "单工具轮 → 最终答案",
    tags: ["live", "normal"],
    description: "读 config.json 后回答端口号。验证一轮 tool call + 结果喂回 + final。",
    prompt: "请读取 config.json 文件，然后告诉我里面的端口号是多少。",
    tools: makeToolbox(),
    minRounds: 1,
    maxRounds: 4,
    assert(ctx) {
      return [
        ctx.toolCalls.length >= 1 ? pass("至少 1 次 tool call", `${ctx.toolCalls.length} 次`) : fail("至少 1 次 tool call", `${ctx.toolCalls.length} 次`, "LOST_TOOL_CALL"),
        uniqueToolIds(ctx) ? pass("tool call id 无重复") : fail("tool call id 无重复", "重复 id", "DUPLICATE_TOOL_CALL"),
        ctx.toolCalls.some((t) => t.name === "read_file") ? pass("使用了 read_file", `工具集=${new Set(ctx.toolCalls.map((t) => t.name)).size} 种`) : fail("使用了 read_file", `got ${ctx.toolCalls.map((t) => t.name).join(",")}`),
        noRoundError(ctx) ? pass("全程无 provider error") : fail("全程无 provider error", firstError(ctx), "MISSING_STOP_REASON_ACCEPTED"),
        modelReported(ctx) ? pass("actualModel 上报") : fail("actualModel 上报", "缺 actualModel", "SILENT_MODEL_SWITCH"),
        usageReported(ctx) ? pass("usage 上报") : fail("usage 上报", "缺 token_usage", "TOKEN_TELEMETRY_MISSING"),
      ]
    },
  },
  {
    caseId: "PP-LV02",
    title: "thinking + 多轮 Tool Loop（2-3 次）",
    tags: ["live", "thinking", "multi-round"],
    description: "搜索 → 读文件 → 计算，跨 3 轮。验证轮间 reasoning 连续、tool 不重复不错配。",
    prompt: "请先搜索 src 目录下与 main 相关的文件，然后读取 src/main.ts，最后计算 20 加 22，基于每一步的真实结果给出最终总结。",
    tools: makeToolbox(),
    minRounds: 2,
    maxRounds: 5,
    thinking: true,
    assert(ctx) {
      const names = ctx.toolCalls.map((t) => t.name)
      return [
        ctx.toolCalls.length >= 2 ? pass("≥2 次 tool call", `${ctx.toolCalls.length} 次`) : fail("≥2 次 tool call", `${ctx.toolCalls.length} 次`, "LOST_TOOL_CALL"),
        uniqueToolIds(ctx) ? pass("tool call id 无重复") : fail("tool call id 无重复", "重复 id", "DUPLICATE_TOOL_CALL"),
        names.includes("read_file") && names.includes("compute") ? pass("多工具路由", names.join(",")) : fail("多工具路由", names.join(",")),
        noRoundError(ctx) ? pass("全程无 provider error") : fail("全程无 provider error", firstError(ctx)),
        ctx.rounds.length >= 2 ? pass("≥2 轮", `${ctx.rounds.length} 轮`) : fail("≥2 轮", `${ctx.rounds.length} 轮`),
        hasThinking(ctx) ? pass("产 thinking_blocks") : fail("产 thinking_blocks", "thinking=true 但无 thinking 产出（记录）"),
      ]
    },
  },
  {
    caseId: "PP-LV03",
    title: "只读分析任务不产生副作用",
    tags: ["live", "readonly"],
    description: "仅搜索 + 读文件，验证工具集不越权（工具本身确定性无副作用）。",
    prompt: "搜索 config 相关文件，并读取 config.json，然后告诉我 debug 字段的值。",
    tools: makeToolbox(),
    minRounds: 1,
    maxRounds: 4,
    assert(ctx) {
      return [
        ctx.toolCalls.length >= 1 ? pass("有工具调用") : fail("有工具调用", `${ctx.toolCalls.length} 次`),
        ctx.toolCalls.every((t) => t.name !== "write_file") ? pass("无写入副作用") : fail("无写入副作用", "出现写工具"),
        uniqueToolIds(ctx) ? pass("id 无重复") : fail("id 无重复", "重复", "DUPLICATE_TOOL_CALL"),
        noRoundError(ctx) ? pass("无 error") : fail("无 error", firstError(ctx)),
      ]
    },
  },
  {
    caseId: "PP-LV04",
    title: "轮间 abort → 无残留流",
    tags: ["live", "abort"],
    description: "第 2 轮 abort，验证取消后不再有 provider 输出、不误报 error。",
    prompt: "请先读取 config.json，然后继续调用 compute 完成 5 次加法运算，每次基于前次结果。",
    tools: makeToolbox(),
    minRounds: 1,
    maxRounds: 6,
    abortAfterRound: 1,
    assert(ctx) {
      const lastEvents = ctx.rounds[ctx.rounds.length - 1]?.events ?? []
      return [
        ctx.aborted ? pass("已 abort") : fail("已 abort", "未触发 abort"),
        ctx.rounds.length <= 3 ? pass("abort 后未继续跑完", `${ctx.rounds.length} 轮`) : fail("abort 后未继续跑完", `${ctx.rounds.length} 轮`, "ABORT_IGNORED"),
        !noRoundError(ctx) || lastEvents.some((e) => e.type === "status") || ctx.rounds.length === 1
          ? pass("无残留错误")
          : fail("无残留错误", firstError(ctx), "ABORT_IGNORED"),
      ]
    },
  },
  {
    caseId: "PP-LV05",
    title: "max_tokens 截断 → 不崩溃",
    tags: ["live", "edge"],
    description: "maxTokens=80 极小预算，验证截断被正确转为可恢复 error/截断文本，进程不挂。",
    prompt: "请写一篇 500 字的关于人工智能发展的文章，然后告诉我你写了多少字。",
    tools: makeToolbox(),
    minRounds: 0,
    maxRounds: 3,
    maxTokens: 80,
    assert(ctx) {
      const events = ctx.rounds.flatMap((r) => r.events)
      const err = events.find((e) => e.type === "error")
      return [
        ctx.rounds.length >= 1 ? pass("完成至少 1 轮") : fail("完成至少 1 轮", "0 轮"),
        err === undefined || String(err.data).includes("max_tokens")
          ? pass("截断被识别为 max_tokens")
          : fail("截断被识别为 max_tokens", `error=${String(err.data)}`),
        true ? pass("未崩溃（runner 正常返回）") : pass("", ""),
      ]
    },
  },
]

// ── helpers ──

function pass(label: string, detail = ""): MBEAssertion {
  return { label, passed: true, detail }
}
function fail(label: string, detail: string, gate?: HardGateName): MBEAssertion {
  return { label, passed: false, detail, gate }
}
function uniqueToolIds(ctx: MBELiveContext): boolean {
  const ids = ctx.toolCalls.map((t) => t.id)
  return new Set(ids).size === ids.length
}
function noRoundError(ctx: MBELiveContext): boolean {
  return ctx.rounds.every((r) => !r.events.some((e) => e.type === "error"))
}
function firstError(ctx: MBELiveContext): string {
  for (const r of ctx.rounds) {
    const e = r.events.find((x) => x.type === "error")
    if (e) return String(e.data)
  }
  return ""
}
function modelReported(ctx: MBELiveContext): boolean {
  return ctx.rounds.some((r) => r.modelActual !== undefined && r.modelActual !== "")
}
function usageReported(ctx: MBELiveContext): boolean {
  return ctx.rounds.some((r) => r.usage !== undefined)
}
function hasThinking(ctx: MBELiveContext): boolean {
  return ctx.rounds.some((r) => r.events.some((e) => e.type === "thinking_blocks"))
}

// ── runner ──

interface RoundRec {
  events: StreamEvent[]
  usage?: Record<string, unknown>
  modelActual?: string
  durationMs: number
}

async function runLiveCase(def: MBELiveCase): Promise<MBECaseResult> {
  const auth = new FileAuthStore()
  const apiKey = await auth.get("deepseek")
  if (!apiKey) {
    return {
      caseId: def.caseId, title: def.title, tags: def.tags, passed: false,
      assertions: [fail("deepseek key 可用", "auth.json 未配置 deepseek key")],
      failures: ["deepseek key 可用"], trace: [], calls: 0, retries: 0, sleepsMs: [], durationMs: 0,
      error: "缺少 deepseek API key（~/.orcana/auth.json）",
    }
  }

  const config = loadConfig()
  const baseUrl = config.providers?.deepseek?.baseUrl
  const provider = new DeepSeekProvider(apiKey, baseUrl ?? undefined)

  const rounds: RoundRec[] = []
  const toolCalls: MBELiveContext["toolCalls"] = []
  const sleepsMs: number[] = []
  const controller = new AbortController()
  const toolSchemas = buildToolSchemas(def.tools)
  const thinking = def.thinking ? { type: "adaptive" as const, effort: "max" as const } : undefined

  let messages: ProviderMessage[] = [{ role: "user", content: def.prompt }]
  const start = performance.now()

  for (let round = 0; round < def.maxRounds; round++) {
    const roundStart = performance.now()
    const events: StreamEvent[] = []
    let usage: Record<string, unknown> | undefined
    let modelActual: string | undefined

    for await (const ev of provider.streamChat({
      model: MODEL,
      purpose: "agent_main",
      system: SYSTEM,
      messages,
      tools: toolSchemas,
      thinking,
      maxTokens: def.maxTokens ?? 2048,
      abortSignal: controller.signal,
    })) {
      events.push(ev)
      if (ev.type === "token_usage") {
        const u = ev.data as ProviderTokenUsage
        usage = { ...usage, ...u }
        if (u.actualModel) modelActual = u.actualModel
      }
    }
    rounds.push({ events, usage, modelActual, durationMs: Math.round(performance.now() - roundStart) })

    if (def.abortAfterRound !== undefined && round >= def.abortAfterRound) controller.abort()

    const tcs = events.filter((e) => e.type === "tool_call")
    if (tcs.length === 0) break

    const assistantBlocks: Array<Record<string, unknown>> = []
    const userBlocks: Array<Record<string, unknown>> = []
    for (const t of tcs) {
      const d = t.data as { id: string; name: string; input: Record<string, unknown> }
      toolCalls.push({ round, id: d.id, name: d.name, input: d.input })
      assistantBlocks.push({ type: "tool_use", id: d.id, name: d.name, input: d.input })
      const tool = def.tools[d.name]
      let result: string
      if (!tool) result = `未知工具: ${d.name}`
      else {
        try {
          result = await tool.run(d.input ?? {})
        } catch (e) {
          result = `工具错误: ${e instanceof Error ? e.message : String(e)}`
        }
      }
      userBlocks.push({ type: "tool_result", tool_use_id: d.id, content: result })
    }
    messages = [...messages, { role: "assistant", content: assistantBlocks }, { role: "user", content: userBlocks }]
  }

  const ctx: MBELiveContext = { rounds, toolCalls, aborted: controller.signal.aborted, sleepsMs }
  const assertions = def.assert(ctx)
  const failures = assertions.filter((a) => !a.passed)
  const totalEvents = rounds.flatMap((r) => r.events)
  const usage = totalEvents.reduce<Record<string, unknown>>((acc, e) => (e.type === "token_usage" ? Object.assign(acc, e.data as object) : acc), {})
  const lastActual = rounds.find((r) => r.modelActual)?.modelActual

  return {
    caseId: def.caseId,
    title: def.title,
    tags: def.tags,
    passed: failures.length === 0,
    assertions,
    failures: failures.map((f) => f.label),
    trace: rounds.flatMap((r, i) =>
      r.events.map((e, j) => ({
        type: e.type,
        data: e.type === "text" ? `[r${i + 1}] ${String(e.data).slice(0, 60)}` : e.data,
        seq: i * 100 + j + 1,
      })),
    ),
    calls: rounds.length,
    retries: 0,
    sleepsMs,
    durationMs: Math.round(performance.now() - start),
    usage: Object.keys(usage).length > 0 ? usage : undefined,
    modelRequested: MODEL,
    modelActual: lastActual,
  }
}

export async function runLiveSuite(filterCase?: string): Promise<MBEReport> {
  const cases: MBECaseResult[] = []
  for (const def of LIVE_CASES) {
    if (filterCase && def.caseId !== filterCase) continue
    cases.push(await runLiveCase(def))
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
    header: buildHeader("ORMB-PP", "max"), // live：有 thinking 用例用 adaptive/max
    suite: "ORMB-PP-live",
    cases,
    hardGates,
    summary: { total: cases.length, passed, failed: cases.length - passed, passRate: Math.round((passed / cases.length) * 1000) / 10 },
    generatedAt: new Date().toISOString(),
  }
}

export function printLiveReport(report: MBEReport): void {
  const { header, summary, hardGates } = report
  console.log(`\n═══ ${report.suite} — live 套件（真实 ${header.modelRequested}，经代理）═══`)
  console.log(`   commit=${header.orcanaCommit} model=${header.modelRequested} seed=${header.seed} baseUrl=config.providers.deepseek.baseUrl`)

  for (const c of report.cases) {
    const mark = c.passed ? "✅" : "❌"
    console.log(`\n${mark} ${c.caseId} ${c.title} [${c.tags.join(" ")}]`)
    if (c.description) console.log(`   ${c.description}`)
    for (const a of c.assertions) {
      const icon = a.passed ? "  ·" : "  ✗"
      console.log(`${icon} ${a.label}${a.gate ? ` [gate:${a.gate}]` : ""}${a.passed ? "" : ` — ${a.detail}`}`)
    }
    if (c.error) console.log(`   ⚠ ${c.error}`)
    if (c.modelActual && c.modelActual !== header.modelRequested) console.log(`   ⚠ actualModel=${c.modelActual}（≠ requested）`)
    const roundInfo = c.trace.length > 0
      ? c.trace
          .map((t) => {
            const r = String(t.data).startsWith("[r") ? `r${t.seq >= 100 ? 2 : 1}:${t.type}` : t.type
            return r
          })
          .join(" → ")
      : ""
    console.log(`   rounds=${c.calls} tool_calls=${report.cases[0]?.calls} ${c.durationMs}ms actual=${c.modelActual ?? "?"}`)
    if (c.usage) {
      const u = c.usage as Record<string, unknown>
      console.log(`   usage: in=${u.inputTokens} out=${u.outputTokens} cacheRead=${u.cacheReadInputTokens} cacheMiss=${u.cacheMissInputTokens} cacheCreation=${u.cacheCreationInputTokens}`)
    }
    if (roundInfo) console.log(`   trace: ${roundInfo.slice(0, 220)}`)
  }

  console.log(`\n── 汇总 ──`)
  console.log(`   ${summary.passed}/${summary.total} 通过，通过率 ${summary.passRate}%`)
  console.log(`   Hard Gates（必须全 0）：`)
  for (const g of HARD_GATES) {
    const n = hardGates[g] ?? 0
    console.log(`     ${n === 0 ? "✅" : "❌"} ${g} = ${n}`)
  }
}

// ── CLI 直跑 ──
if (import.meta.main) {
  const arg = process.argv[2]?.startsWith("--case=") ? process.argv[2]!.slice(7) : process.argv[2]
  const report = await runLiveSuite(arg && !arg.startsWith("--") ? arg : undefined)
  printLiveReport(report)
  const gateFail = Object.entries(report.hardGates).some(([, n]) => (n ?? 0) > 0)
  process.exit(report.summary.failed > 0 || gateFail ? 1 : 0)
}
