/** ORMB-SR/TR runner —— 50 Skill 路由 + 40 Mode 路由 + 5 组多轮切换（计划 §9 P2）。
 *
 *  Skill 三条路径（计划 §四）：
 *    A 关键词激活  activateSkillNames()（registry，本地，无网络）
 *    B 语义分诊    FlashTriage.triage()（真实模型，每用例新实例）
 *    C 关键词回退  activateSkillNamesByKeywords()（triage 失败后的 fallback）
 *  Mode：FlashTriage.triage 输出 vs Ground Truth。
 *  多轮：真实行为（同一实例，breaker 生效）+ 理想对照（每轮新实例）。
 *
 *  跑法：bun run evals/microbench/triage/run.ts [--case=SR-01] [--no-live] [--save]
 */

import { FileAuthStore } from "../../../src/config/auth-store"
import { loadConfig } from "../../../src/config/config-loader"
import { DeepSeekProvider } from "../../../src/provider/deepseek"
import { FlashTriage, activateSkillNamesByKeywords, type FlashTriageResult, type TriageThinking } from "../../../src/agent/flash-triage"
import { SKILLS, activateSkillNames } from "../../../src/skills/registry"
import { HARD_GATES, type HardGateName } from "../contracts/metrics"
import type { MBEAssertion, MBECaseResult } from "../contracts/case"
import type { MBEHdr, MBEReport } from "../contracts/result"
import { buildHeader } from "../provider-protocol/run-mock"
import { SKILL_CASES, type SkillCase } from "./skill-cases"
import { MODE_CASES, type ModeCase, type ModeGT } from "./mode-cases"
import { MTR_CASES } from "./multiturn-cases"

const MODEL = "deepseek-v4-flash"

/** triage 可见技能集 = registry autoTrigger 技能（与 buildTriagePrompt 同源）。
 *  此前测试侧硬编码 6 个名（含 phantom "design-quality"），与 registry 漂移
 *  导致 ui-ux/motion 语义路径结构不可达（ORMB-SR 实测发现）——现在单一事实源。 */
const TRIAGE_VISIBLE_SKILLS = SKILLS.filter((s) => s.autoTrigger).map((s) => s.name)

function pass(label: string, detail = ""): MBEAssertion {
  return { label, passed: true, detail }
}
function fail(label: string, detail: string, gate?: HardGateName): MBEAssertion {
  return { label, passed: false, detail, gate }
}

// ── Provider（live 用）──

/** A/B 对比：--thinking=disabled|auto|enabled1024 注入不同 thinking 配置。 */
let THINKING: TriageThinking = undefined
export function resolveThinkingArg(v: string | undefined): TriageThinking {
  if (v === "disabled") return { type: "disabled" }
  if (v === "enabled1024") return { type: "enabled", budget_tokens: 1024 }
  if (v === "enabled512") return { type: "enabled", budget_tokens: 512 }
  return undefined // auto：不传
}

async function makeTriage(): Promise<FlashTriage | null> {
  const auth = new FileAuthStore()
  const apiKey = await auth.get("deepseek")
  if (!apiKey) return null
  const config = loadConfig()
  const provider = new DeepSeekProvider(apiKey, config.providers?.deepseek?.baseUrl ?? undefined)
  return new FlashTriage(provider, undefined, THINKING)
}

// ── 路径执行 ──

function keywordPath(prompt: string): string[] {
  return activateSkillNames(prompt)
}
function fallbackPath(prompt: string): string[] {
  return activateSkillNamesByKeywords(prompt)
}

interface SkillRun {
  keyword: string[]
  triage: string[] | null // null = 分诊失败（breaker/超时/解析失败）
  fallback: string[]
  triageErr?: string // 失败原因分类（FlashTriage.lastError）
  triageMs?: number // triage 调用耗时（A/B 延迟对比）
}

async function runSkillPaths(prompt: string, live: boolean): Promise<SkillRun> {
  const keyword = keywordPath(prompt)
  const fallback = fallbackPath(prompt)
  if (!live) return { keyword, triage: null, fallback }

  const triage = await makeTriage()
  if (!triage) return { keyword, triage: null, fallback }
  const t0 = Date.now()
  const result = await triage.triage(prompt)
  const triageErr = triage.lastError
  return { keyword, triage: result?.relevantSkillNames ?? null, fallback, triageErr, triageMs: Date.now() - t0 }
}

// ── 指标计算（计划 §四/§五）──

interface PRF {
  tp: number
  fp: number
  fn: number
}
function addPRF(acc: PRF, predicted: string[], required: string[], forbidden: string[]): void {
  const p = new Set(predicted)
  for (const r of required) {
    if (p.has(r)) acc.tp++
    else acc.fn++
  }
  for (const x of predicted) {
    if (!required.includes(x)) {
      // 被激活但不在 required——若在 forbidden 算 FP，其他（非 gt 技能）也算 FP
      acc.fp++
    }
  }
}
function prfScore(acc: PRF): { precision: number; recall: number; f1: number } {
  const precision = acc.tp + acc.fp > 0 ? acc.tp / (acc.tp + acc.fp) : 0
  const recall = acc.tp + acc.fn > 0 ? acc.tp / (acc.tp + acc.fn) : 0
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
  return { precision, recall, f1 }
}

interface ModeAgg {
  tp: number
  fp: number
  fn: number
}
function modeAggKey(mode: ModeGT["mode"]): string {
  return mode
}

// ── 用例 runner ──

async function runSkillCase(c: SkillCase, live: boolean): Promise<MBECaseResult> {
  const run = await runSkillPaths(c.prompt, live)
  const assertions: MBEAssertion[] = []
  const tags = [...c.tags, "skill"]
  const isTrap = c.tags.includes("trap")
  const isImplicit = c.tags.includes("implicit")

  // ── 路径 A：关键词激活（baseline）──
  if (isImplicit) {
    // 隐含匹配无触发词，关键词路径按设计激活不了——只记录，不判
    assertions.push(pass("关键词路径不可达（隐含匹配设计如此）", `keyword=[${run.keyword.join(",")}]`))
  } else {
    const kwMiss = c.gt.required.filter((x) => !run.keyword.includes(x))
    assertions.push(
      kwMiss.length === 0 ? pass("关键词 required 全激活", run.keyword.join(",") || "(空)") : fail("关键词 required 全激活", `缺: ${kwMiss.join(",")}`, "LOST_TOOL_CALL"),
    )
  }
  if (isTrap) {
    // 关键词误触发 = 已知弱点（计划 §四点名），作为记录性指标，不判失败
    const kwForbidden = run.keyword.filter((x) => c.gt.forbidden.includes(x))
    assertions.push(pass("关键词误触发记录（baseline）", kwForbidden.length > 0 ? `误激活: ${kwForbidden.join(",")}` : "未误触发"))
  } else {
    const kwForbidden = run.keyword.filter((x) => c.gt.forbidden.includes(x))
    assertions.push(
      kwForbidden.length === 0 ? pass("关键词 forbidden 未激活") : fail("关键词 forbidden 未激活", `误激活: ${kwForbidden.join(",")}`, "FORBIDDEN_SKILL_ACTIVATION"),
    )
  }

  // ── 路径 B：语义分诊（主线判定；trap 的 forbidden 是硬 gate）──
  let triageReachable = true
  if (run.triage !== null) {
    const requiredVisible = c.gt.required.filter((r) => TRIAGE_VISIBLE_SKILLS.includes(r))
    const unreachable = c.gt.required.filter((r) => !TRIAGE_VISIBLE_SKILLS.includes(r))
    if (c.gt.required.length > 0 && requiredVisible.length === 0) {
      // 全部 required 技能不在 triage 可见集 → 结构性不可达（发现，不算失败）
      triageReachable = false
      assertions.push(pass("语义路径结构不可达（发现）", `required ${unreachable.join(",")} 不在 triage 可见集`))
    } else {
      const trMiss = requiredVisible.filter((r) => !run.triage!.includes(r))
      const trForbidden = run.triage.filter((x) => c.gt.forbidden.includes(x))
      assertions.push(
        trMiss.length === 0 ? pass("语义 required 全激活", run.triage.join(",") || "(空)") : fail("语义 required 全激活", `缺: ${trMiss.join(",")}`, "LOST_TOOL_CALL"),
        trForbidden.length === 0 ? pass("语义 forbidden 未激活") : fail("语义 forbidden 未激活", `误激活: ${trForbidden.join(",")}`, "FORBIDDEN_SKILL_ACTIVATION"),
      )
    }
  } else {
    assertions.push(pass("语义分诊失败→回退关键词", run.triageErr ? `triage=null（${run.triageErr}）` : "triage=null（记录，不算失败）"))
  }

  // ── 路径 C：fallback 关键词（triage 失败时的最终路由；同为 baseline）──
  if (!isImplicit) {
    const fbForbidden = run.fallback.filter((x) => c.gt.forbidden.includes(x))
    if (isTrap) {
      assertions.push(pass("fallback 误触发记录（baseline）", fbForbidden.length > 0 ? `误激活: ${fbForbidden.join(",")}` : "未误触发"))
    } else {
      assertions.push(
        fbForbidden.length === 0 ? pass("fallback forbidden 未激活") : fail("fallback forbidden 未激活", `误激活: ${fbForbidden.join(",")}`, "FORBIDDEN_SKILL_ACTIVATION"),
      )
    }
  }

  const failures = assertions.filter((a) => !a.passed)
  return {
    caseId: c.caseId,
    title: c.prompt.slice(0, 40),
    tags,
    passed: failures.length === 0,
    assertions,
    failures: failures.map((f) => f.label),
    trace: [
      { type: "keyword", data: run.keyword, seq: 1 },
      { type: "triage", data: run.triage, seq: 2 },
      { type: "fallback", data: run.fallback, seq: 3 },
    ],
    calls: run.keyword.length + (run.triage?.length ?? 0) + run.fallback.length,
    retries: 0,
    sleepsMs: [],
    durationMs: run.triageMs ?? 0,
    modelRequested: MODEL,
    // 附加明细
    ...({ pathResult: run, gt: c.gt } as object),
  }
}

async function runModeCase(c: ModeCase, live: boolean): Promise<MBECaseResult> {
  const assertions: MBEAssertion[] = []
  const tags = [...c.gt.tags, "mode"]
  let result: FlashTriageResult | null = null
  let triageError = ""

  let triageMs = 0
  if (live) {
    const triage = await makeTriage()
    if (triage) {
      const t0 = Date.now()
      result = await triage.triage(c.prompt)
      triageMs = Date.now() - t0
      if (result === null) triageError = `triage 失败（${triage.lastError || "null"}）`
    } else {
      triageError = "无 API key"
    }
  }

  const gt = c.gt
  if (!result) {
    // live 下分诊失败（空响应/超时）→ 用例失败但不挂 hard gate（计划 §五：
    // 分诊失败本身可接受，要求的是 fallback 100% 成功）；--no-live 直接跳过。
    if (!live) {
      assertions.push(pass("live 关闭（跳过）", "no-live 模式下不调用真实分诊"))
    } else {
      assertions.push(fail("mode 分诊可用", triageError || "triage 返回 null（空响应/超时）"))
      assertions.push(fail("mode 匹配", "无分诊结果"))
      assertions.push(fail("needsWeb 匹配", "无分诊结果"))
      assertions.push(fail("riskLevel 匹配", "无分诊结果"))
    }
  } else {
    // mode 精确匹配
    assertions.push(
      result.mode === gt.mode ? pass("mode 匹配", `${result.mode}`) : fail("mode 匹配", `GT=${gt.mode} 实际=${result.mode}`, "MODE_MISMATCH"),
    )
    // needsWeb
    if (gt.needsWeb !== undefined) {
      assertions.push(
        result.needsWeb === gt.needsWeb ? pass("needsWeb 匹配", `${result.needsWeb}`) : fail("needsWeb 匹配", `GT=${gt.needsWeb} 实际=${result.needsWeb}`, "NEEDS_WEB_MISMATCH"),
      )
    }
    // risk：GT high 不得 low（High Miss）；GT low 实际 high 只记录不判失败
    if (gt.riskLevel === "high") {
      assertions.push(
        result.riskLevel !== "low" ? pass("高风险未漏判", `risk=${result.riskLevel}`) : fail("高风险未漏判", `GT=high 实际=low`, "RISK_HIGH_MISS"),
      )
    }
  }

  const failures = assertions.filter((a) => !a.passed)
  return {
    caseId: c.caseId,
    title: c.prompt.slice(0, 40),
    tags,
    passed: failures.length === 0,
    assertions,
    failures: failures.map((f) => f.label),
    trace: [{ type: "triage-result", data: result, seq: 1 }],
    calls: 1,
    retries: 0,
    sleepsMs: [],
    durationMs: triageMs,
    modelRequested: MODEL,
    ...({ triageResult: result } as object),
  }
}

async function runMTRCases(live: boolean): Promise<MBECaseResult[]> {
  const out: MBECaseResult[] = []
  for (const m of MTR_CASES) {
    const assertions: MBEAssertion[] = []
    // 真实行为：同一实例连调（breaker 生效）
    const triage = live ? await makeTriage() : null
    const realRounds: Array<{ round: number; prompt: string; activated: string[]; source: string }> = []
    for (let i = 0; i < m.turns.length; i++) {
      const t = m.turns[i]!
      if (triage) {
        const r = await triage.triage(t.prompt)
        if (r !== null) realRounds.push({ round: i + 1, prompt: t.prompt, activated: r.relevantSkillNames, source: "triage" })
        else {
          const fb = activateSkillNamesByKeywords(t.prompt)
          realRounds.push({ round: i + 1, prompt: t.prompt, activated: fb, source: "keyword-fallback" })
        }
      } else {
        realRounds.push({ round: i + 1, prompt: t.prompt, activated: [], source: "no-live" })
      }
    }
    // 理想对照：每轮新实例
    const idealRounds: Array<{ round: number; activated: string[]; source: string }> = []
    if (live) {
      for (let i = 0; i < m.turns.length; i++) {
        const t = m.turns[i]!
        const fresh = await makeTriage()!
        const r = await fresh.triage(t.prompt)
        if (r !== null) idealRounds.push({ round: i + 1, activated: r.relevantSkillNames, source: "triage" })
        else idealRounds.push({ round: i + 1, activated: activateSkillNamesByKeywords(t.prompt), source: "keyword-fallback" })
      }
    }

    // 断言：每轮真实行为的激活集 vs GT
    if (!live) {
      for (let i = 0; i < m.turns.length; i++) {
        assertions.push(pass(`真实 轮${i + 1} skill 正确（跳过）`, "no-live 模式不调用真实分诊"))
      }
      assertions.push(pass("理想对照（每轮新实例）", "no-live 模式跳过"))
      assertions.push(pass("Turn3 未继承 Turn1 的 skill", "no-live 模式跳过"))
    } else {
      let realHits = 0
      for (let i = 0; i < m.turns.length; i++) {
        const t = m.turns[i]!
        const rr = realRounds[i]
        const hit = rr !== undefined && t.requiredSkills.length > 0
          ? t.requiredSkills.every((s) => rr.activated.includes(s))
          : t.requiredSkills.length === 0 && (rr?.activated.length ?? 0) === 0
        if (hit) realHits++
        assertions.push(
          hit ? pass(`真实 轮${i + 1} skill 正确`, `${rr?.source ?? "?"}: ${rr?.activated.join(",") ?? "(空)"}`)
            : fail(`真实 轮${i + 1} skill 正确`, `GT=[${t.requiredSkills.join(",")}] 实际=${rr?.activated.join(",") ?? "(无)"}`, "LOST_TOOL_CALL"),
        )
      }
      // 理想对照汇总（作为记录不判失败）
      const idealHits = idealRounds.filter((r, i) => {
        const t = m.turns[i]!
        return t.requiredSkills.length > 0
          ? t.requiredSkills.every((s) => r.activated.includes(s))
          : r.activated.length === 0
      }).length
      assertions.push(pass("理想对照（每轮新实例）", `${idealHits}/${m.turns.length} 轮正确`))
      // 全局：任务切换必须重新路由（Turn 3 不得继承 Turn 1）
      const t1 = realRounds[0]?.activated ?? []
      const t3 = realRounds[2]?.activated ?? []
      const t1Skills = new Set(t1)
      const carried = t3.filter((s) => t1Skills.has(s))
      assertions.push(
        carried.length === 0 ? pass("Turn3 未继承 Turn1 的 skill", `t1=[${t1.join(",")}] t3=[${t3.join(",")}]`) : fail("Turn3 未继承 Turn1 的 skill", `继承: ${carried.join(",")}`, "LOST_TOOL_CALL"),
      )
    }

    const failures = assertions.filter((a) => !a.passed)
    out.push({
      caseId: m.caseId,
      title: m.title,
      tags: ["multiturn"],
      passed: failures.length === 0,
      assertions,
      failures: failures.map((f) => f.label),
      trace: [
        { type: "real", data: realRounds, seq: 1 },
        { type: "ideal", data: idealRounds, seq: 2 },
      ],
      calls: realRounds.length,
      retries: 0,
      sleepsMs: [],
      durationMs: 0,
      modelRequested: MODEL,
      ...({ realRounds, idealRounds } as object),
    })
  }
  return out
}

// ── 报告 ──

function buildReport(suite: string, cases: MBECaseResult[]): MBEReport {
  const hardGates: Partial<Record<HardGateName, number>> = {}
  for (const g of HARD_GATES) hardGates[g] = 0
  for (const r of cases) {
    for (const a of r.assertions) {
      if (!a.passed && a.gate) hardGates[a.gate] = (hardGates[a.gate] ?? 0) + 1
    }
  }
  const passed = cases.filter((c) => c.passed).length
  return {
    header: buildHeader(suite, "none"),
    suite,
    cases,
    hardGates,
    summary: { total: cases.length, passed, failed: cases.length - passed, passRate: Math.round((passed / cases.length) * 1000) / 10 },
    generatedAt: new Date().toISOString(),
  }
}

function printReport(report: MBEReport, title: string): void {
  const { header, summary, hardGates } = report
  console.log(`\n═══ ${report.suite} — ${title} ═══`)
  console.log(`   commit=${header.orcanaCommit} model=${header.modelRequested}`)
  for (const c of report.cases) {
    const mark = c.passed ? "✅" : "❌"
    console.log(`\n${mark} ${c.caseId} ${c.title} [${c.tags.join(" ")}]`)
    for (const a of c.assertions) {
      const icon = a.passed ? "  ·" : "  ✗"
      console.log(`${icon} ${a.label}${a.gate ? ` [gate:${a.gate}]` : ""}${a.passed ? "" : ` — ${a.detail}`}`)
    }
    const t = c.trace[0]
    if (t && typeof t.data !== "string") {
      console.log(`   ${t.type}: ${JSON.stringify(t.data).slice(0, 160)}`)
    }
  }
  console.log(`\n── 汇总 ──`)
  console.log(`   ${summary.passed}/${summary.total} 通过，通过率 ${summary.passRate}%`)
  console.log(`   Hard Gates（必须全 0）：`)
  for (const g of HARD_GATES) {
    const n = hardGates[g] ?? 0
    console.log(`     ${n === 0 ? "✅" : "❌"} ${g} = ${n}`)
  }
}

// ── Skill 指标聚合 ──

function printSkillMetrics(report: MBEReport): void {
  const kw: PRF = { tp: 0, fp: 0, fn: 0 }
  const tr: PRF = { tp: 0, fp: 0, fn: 0 }
  const fb: PRF = { tp: 0, fp: 0, fn: 0 }
  let exact = 0
  let noSkillOK = 0
  let noSkillTotal = 0
  let fallbackCount = 0
  let reachableCount = 0
  const failByCause: Record<string, number> = {}

  for (const c of report.cases) {
    const pr = (c as unknown as { pathResult?: SkillRun }).pathResult
    const gt = (c as unknown as { gt?: { required: string[]; optional: string[]; forbidden: string[] } }).gt
    if (!pr || !gt) continue
    addPRF(kw, pr.keyword, gt.required, gt.forbidden)
    if (pr.triage !== null) {
      const visibleRequired = gt.required.filter((r) => TRIAGE_VISIBLE_SKILLS.includes(r))
      addPRF(tr, pr.triage, visibleRequired, gt.forbidden)
      reachableCount++
      if (JSON.stringify(pr.triage.sort()) === JSON.stringify(gt.required.filter((r) => TRIAGE_VISIBLE_SKILLS.includes(r)).sort())) exact++
    } else {
      fallbackCount++
      const cause = pr.triageErr?.replace(/:\s*[^:]+$/, "") || "unknown"
      failByCause[cause] = (failByCause[cause] ?? 0) + 1
    }
    addPRF(fb, pr.fallback, gt.required, gt.forbidden)
    if (c.tags.includes("no-skill")) {
      noSkillTotal++
      if (pr.keyword.length === 0) noSkillOK++
    }
  }

  const fmt = (p: PRF) => {
    const s = prfScore(p)
    return `P=${(s.precision * 100).toFixed(1)}% R=${(s.recall * 100).toFixed(1)}% F1=${(s.f1 * 100).toFixed(1)}%`
  }
  console.log(`\n── Skill 路径指标（计划 §四）──`)
  console.log(`   关键词路径 activateSkillNames: ${fmt(kw)}`)
  console.log(`   语义路径 FlashTriage:         ${fmt(tr)}（可见集 ${reachableCount}/50 用例）`)
  console.log(`   fallback 关键词:               ${fmt(fb)}`)
  console.log(`   语义 Exact Set 准确率: ${(exact / Math.max(1, reachableCount) * 100).toFixed(1)}%`)
  console.log(`   No-Skill 精确率（关键词）: ${noSkillOK}/${noSkillTotal}`)
  const causeDetail = Object.entries(failByCause).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(" ")
  console.log(`   语义分诊失败率: ${fallbackCount}/${report.cases.length}${causeDetail ? `（${causeDetail}）` : ""}`)
}

function printModeMetrics(report: MBEReport): void {
  const byMode: Record<string, ModeAgg> = {}
  for (const m of ["discussion", "narrow_edit", "plan_before_code", "full_complex"]) byMode[m] = { tp: 0, fp: 0, fn: 0 }
  let needsWebTP = 0, needsWebFP = 0, needsWebFN = 0, needsWebGT = 0
  let under = 0, over = 0, riskMiss = 0, riskHigh = 0
  let total = 0

  for (const c of report.cases) {
    if (!c.tags.includes("mode")) continue
    total++
    const tr = (c as unknown as { triageResult?: FlashTriageResult | null }).triageResult
    if (!tr) continue
    const src = MODE_CASES.find((m) => m.caseId === c.caseId)
    if (!src) continue
    const g = src.gt

    // mode 混淆矩阵
    if (tr.mode === g.mode) byMode[g.mode]!.tp++
    else {
      byMode[g.mode]!.fn++
      byMode[tr.mode] = byMode[tr.mode] ?? { tp: 0, fp: 0, fn: 0 }
      byMode[tr.mode]!.fp++
    }
    // over/under routing
    if (g.mode === "narrow_edit" || g.mode === "discussion") {
      if (tr.mode === "plan_before_code" || tr.mode === "full_complex") over++
    }
    if (g.mode === "plan_before_code" || g.mode === "full_complex") {
      if (tr.mode === "narrow_edit" || tr.mode === "discussion") under++
    }
    // needsWeb
    if (g.needsWeb !== undefined) {
      needsWebGT++
      if (g.needsWeb && tr.needsWeb) needsWebTP++
      if (!g.needsWeb && tr.needsWeb) needsWebFP++
      if (g.needsWeb && !tr.needsWeb) needsWebFN++
    }
    // risk
    if (g.riskLevel === "high") {
      riskHigh++
      if (tr.riskLevel === "low") riskMiss++
    }
  }

  const modeScores = Object.entries(byMode).map(([k, a]) => `${k}:F1=${(prfScore(a).f1 * 100).toFixed(1)}%`)
  const macroF1 = Object.values(byMode).reduce((n, a) => n + prfScore(a).f1, 0) / Math.max(1, Object.keys(byMode).length)
  const lats = report.cases.filter((c) => c.tags.includes("mode") && c.durationMs > 0).map((c) => c.durationMs).sort((a, b) => a - b)
  const pct = (p: number) => lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * p))]! : 0
  const nullCount = report.cases.filter((c) => c.tags.includes("mode") && (c as unknown as { triageResult?: unknown }).triageResult === null).length
  console.log(`\n── Mode 指标（计划 §五）──`)
  console.log(`   triage 延迟: P50=${pct(0.5)}ms P95=${pct(0.95)}ms 分诊失败=${nullCount}/${report.cases.filter((c) => c.tags.includes("mode")).length}`)
  console.log(`   per-mode F1: ${modeScores.join("  ")}`)
  console.log(`   Mode Macro F1: ${(macroF1 * 100).toFixed(1)}%（计划 v1.0 目标 ≥93%）`)
  console.log(`   Under-routing: ${under}  Over-routing: ${over}  (of ${total})`)
  console.log(`   needsWeb: P=${needsWebGT > 0 ? ((needsWebTP / Math.max(1, needsWebTP + needsWebFP)) * 100).toFixed(1) : "-"}% R=${needsWebGT > 0 ? ((needsWebTP / needsWebGT) * 100).toFixed(1) : "-"}%`)
  console.log(`   Risk High Miss: ${riskMiss}/${riskHigh}（必须 0）`)
}

// ── CLI ──

/** 限流并发池：50/40 连发会瞬时冲击 provider（实测并发越高空响应越多），
 *  4 并发是延迟-吞吐平衡点。 */
async function runLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let idx = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++
      out[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return out
}

export async function runP2(filterCase?: string, live = true, save = false): Promise<void> {
  const skillReport = buildReport("ORMB-SR", await runLimited(
    SKILL_CASES.filter((c) => !filterCase || c.caseId === filterCase), 4, (c) => runSkillCase(c, live),
  ))
  printReport(skillReport, "50 个 Skill 路由用例")
  printSkillMetrics(skillReport)

  const modeReport = buildReport("ORMB-TR", await runLimited(
    MODE_CASES.filter((c) => !filterCase || c.caseId === filterCase), 4, (c) => runModeCase(c, live),
  ))
  printReport(modeReport, "40 个 Mode 路由用例")
  printModeMetrics(modeReport)

  const mtrReport = buildReport("ORMB-MTR", await runMTRCases(live))
  printReport(mtrReport, "5 组多轮任务切换")

  if (save) {
    const { saveReport } = await import("../reports")
    console.log(`\n[run] 报告已存档:`)
    console.log(`   ${saveReport(skillReport)}`)
    console.log(`   ${saveReport(modeReport)}`)
    console.log(`   ${saveReport(mtrReport)}`)
  }

  const all = [skillReport, modeReport, mtrReport]
  const failed = all.reduce((n, r) => n + r.summary.failed, 0)
  const gateFail = all.some((r) => Object.entries(r.hardGates).some(([, v]) => (v ?? 0) > 0))
  process.exit(failed > 0 || gateFail ? 1 : 0)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const filter = args.find((a) => a.startsWith("--case="))?.slice(7)
  const live = !args.includes("--no-live")
  const save = args.includes("--save") || args.includes("-s")
  THINKING = resolveThinkingArg(args.find((a) => a.startsWith("--thinking="))?.slice(11))
  console.log(`[run] thinking=${THINKING ? JSON.stringify(THINKING) : "auto"}`)
  await runP2(filter, live, save)
}
