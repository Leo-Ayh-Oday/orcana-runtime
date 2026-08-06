/** ORMB-P3 Context 长任务 live runner（计划 §P3）。
 *
 *  8 个长任务（4 近 compress + 4 近 rollover）端到端跑 AgentHarness：
 *  contextMaxTokens=16000 → epoch 阈值缩容（compress≈12k / force≈18.2k /
 *  rollover≈21.6k chars），短任务 ~10 步接近 compress，长任务 ~30 步触发 rollover。
 *
 *  ContextBudgetGate（默认 block@60%）：K 系列工具 schema 计入预算后首轮
 *  即 ~75% → 首轮 block，模型无机会输出探针。探针测压缩后信息保留，
 *  不测预算门——放行 gate（warn 0.8 / block 0.95），压缩 epoch 阈值照常触发。
 *
 *  验证（确定性，无 LLM Judge）：
 *    - 探针：任务内置"最终 JSON 报告"，压缩发生后由报告测信息保留
 *      （旧决策复活 / 义务丢失 / 违禁 / 关键事实丢失）
 *    - Tool Chain：tool.call.failed / provider error → fail
 *    - 重复执行：写操作序列中同路径间隔 ≥5 轮再次写入 → 警告（重复工作率）
 *    - 触发记录：epoch status / microcompact / epoch-rollover 事件
 *
 *  CLI：--case=CTX-C1 过滤；--max-rounds=N 覆盖；--no-live 冒烟（全 pass 占位）。
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// typecheck 工具执行 `tsc`（PATH 解析）：bun run 的 PATH 不含项目
// node_modules/.bin → tsc 不可用 → lastTypecheck 永远失败 →
// external completion gate 永远缺证据。前置项目 .bin 让验证通道闭合。
const ORCANA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
process.env.PATH = `${join(ORCANA_ROOT, "node_modules", ".bin")}:${process.env.PATH ?? ""}`
// 评测环境（headless 无交互确认通道）：
// - ContextBudgetGate 放行（探针只测压缩保留，预算门不拦；0.999 = envRatio
//   硬上限 <1；K49 schema 计入预算后 16k 窗口首轮即 ~75%，压缩 epoch
//   （窗口×0.25）在 gate 之前照常触发并回落上下文）
// - highRiskConfirmationGate eval bypass（risk-policy.ts：Risk 4-5 兜底跳过，
//   隔离 tmp workspace + 受控任务；生产严禁设置）
process.env.ORCANA_CONTEXT_WARN_RATIO = "0.95"
process.env.ORCANA_CONTEXT_BLOCK_RATIO = "0.999"
process.env.ORCANA_EVAL_MODE = "1"
import { FileAuthStore } from "../../../src/config/auth-store"
import { loadConfig } from "../../../src/config/config-loader"
import { DeepSeekProvider } from "../../../src/provider/deepseek"
import { createAgentHarness } from "../../../src/harness/runtime/agent-harness"
import { buildTools } from "../../../src/tools/registry"
import { assembleRuntimeToolDefs } from "../../../src/tools/builtins"
import type { HarnessEvent } from "../../../src/harness/contracts/events"
import { CONTEXT_CASES, type ContextCase, type ContextManifest } from "./cases"

// ── 常量 ──

/** 缩容窗口：32k tokens → compress≈24k chars / force≈36.5k / rollover≈43.2k chars。
 *
 *  （16k 窗口下 K49 schema 计入预算后固定成本 ~20k chars（45 工具）占 42%，
 *  首轮 75% → 两轮 97% → ContextBudgetGate block，压缩回落追不上固定膨胀。
 *  32k：首轮 ~37%，compress 阈值 24k chars（~16 轮触发）、rollover 43k（~35 轮）。
 *  production 默认窗口 1M tokens，schema 占比 <1%——本窗口仅为测试缩容。 */
const CONTEXT_MAX_TOKENS = 32_000
/** 写类工具（duplicate work 检测用） */
const WRITE_TOOLS = new Set([
  "write_file", "edit_file", "multi_edit", "edit_fim", "edit_symbol",
  "apply_patch", "apply_patch_transaction",
])

// ── CLI ──

let ONLY = process.env.ORMB_CASE ?? ""
let MAX_ROUNDS: number | undefined
let LIVE = true
let DIAG = false
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!
  if (arg.startsWith("--case=")) ONLY = arg.slice("--case=".length)
  if (arg === "--case") ONLY = argv[++i] ?? ""
  if (arg.startsWith("--max-rounds=")) MAX_ROUNDS = Number(arg.slice("--max-rounds=".length))
  if (arg === "--max-rounds") MAX_ROUNDS = Number(argv[++i])
  if (arg === "--no-live") LIVE = false
  if (arg === "--diag") DIAG = true
}
const CASES = CONTEXT_CASES.filter((c) => !ONLY || c.caseId === ONLY)

// ── 多源探针 ──
//
// 探针 = 3 个通道（自报 → 进度流 → 行为），后一通道是前一通道的 fallback：
//   ① 最终报告 JSON（textChunks 中含 currentDecision 的块）
//   ② 进度 JSON 流（每步 {"step": N, "done": "..."}）
//   ③ 行为观测（写路径 / 写内容 / 读路径——来自 tool 事件，不受压缩影响）
//
// 为什么需要多源：epochRollover 归档 messages.slice(0, cutIndex)——首条
// user prompt（含收尾指令）在 rollover 时必被归档，最终报告通道在触发
// rollover 的 case 上必然 PROBE_MISSING（代码层面确定性）。行为通道是
// 唯一不受压缩影响的证据源：旧决策复活 = 写回废弃方案；违禁 = 触碰禁止
// 文件；义务/事实 = 文件创建/写入。

interface ProbeJson {
  currentDecision: string
  forbiddenActions: string[]
  openObligations: string[]
  completedActions: string[]
  relevantFiles: string[]
}

/** 通道①：最终报告 JSON */
function extractProbe(text: string): ProbeJson | null {
  if (!text.includes("currentDecision")) return null
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(text.slice(start, end + 1))
    return {
      currentDecision: String(obj.currentDecision ?? ""),
      forbiddenActions: Array.isArray(obj.forbiddenActions) ? obj.forbiddenActions.map(String) : [],
      openObligations: Array.isArray(obj.openObligations) ? obj.openObligations.map(String) : [],
      completedActions: Array.isArray(obj.completedActions) ? obj.completedActions.map(String) : [],
      relevantFiles: Array.isArray(obj.relevantFiles) ? obj.relevantFiles.map(String) : [],
    }
  } catch {
    return null
  }
}

/** 通道②：进度 JSON 块 {"step": <N>, "done": "<简述>"}（final 报告块排除） */
interface ProgressBlock {
  step: number
  done: string
}

function extractProgress(text: string): ProgressBlock | null {
  if (!text.includes('"step"') || text.includes("currentDecision")) return null
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(text.slice(start, end + 1))
    const step = Number(obj.step)
    const done = String(obj.done ?? "")
    if (!Number.isFinite(step) || !done) return null
    return { step, done }
  } catch {
    return null
  }
}

/** 通道③：行为证据（tool 事件收集） */
interface BehaviorEvidence {
  /** 写路径集合（writeTarget 提取） */
  writePaths: string[]
  /** 写输入内容片段（前 200 字符，manifest 关键词匹配用） */
  writeTexts: string[]
  /** 读路径集合（read_file / list_dir / glob） */
  readPaths: string[]
}

/** 读类工具（行为证据 relevantFiles 用） */
const READ_TOOLS = new Set([
  "read_file", "list_dir", "glob", "find_symbol", "read_symbol", "file_system_read",
])

// ── 确定性 verifier（对照 manifest，无 LLM Judge）──

interface Verdict { ok: boolean; label: string; detail: string }

function containsAny(list: string[], needles: string[]): boolean {
  const hay = list.map((s) => s.toLowerCase())
  return needles.some((n) => hay.some((h) => h.includes(n.toLowerCase())))
}

function verifyProbe(
  probe: ProbeJson | null,
  progress: ProgressBlock[],
  behavior: BehaviorEvidence,
  m: ContextManifest,
): Verdict[] {
  const v: Verdict[] = []
  const src = probe ? "report" : progress.length > 0 ? "progress" : "behavior"
  const selfText = [
    probe?.currentDecision ?? "",
    ...(probe?.forbiddenActions ?? []),
    ...(probe?.openObligations ?? []),
    ...(probe?.completedActions ?? []),
    ...(probe?.relevantFiles ?? []),
    ...progress.map((p) => p.done),
  ]
  const allText = [...selfText, ...behavior.writeTexts]
  const allPaths = [...behavior.writePaths, ...behavior.readPaths]

  // 旧决策复活：currentDecision 命中预期集合（报告 → 进度流 done → 行为写内容）
  if (m.currentDecisions.length > 0) {
    const hit = containsAny(allText, m.currentDecisions)
    v.push({
      ok: hit,
      label: hit ? "SUPERSEDED_OK" : "SUPERSEDED_REVIVED",
      detail: `决策文本(源=${src}) 预期∈{${m.currentDecisions.join("|")}}${probe ? ` 报告="${probe.currentDecision.slice(0, 60)}"` : ""}`,
    })
  }
  // 违禁：仅行为写路径精确命中判定（约束=文件级"不得修改"，内容提及/自报提及≠修改——
  // 任务要求读取 lib.ts 写说明，配置文件（package.json main/tsconfig include）引用 lib.ts
  // 属正常工程行为；模型如实自报 forbiddenActions 文本含约束词同样不应判违规）
  if (m.negativeConstraints.length > 0) {
    const behaviorHit = behavior.writePaths.some((p) =>
      m.negativeConstraints.some((n) => p === n || p.endsWith("/" + n)),
    )
    v.push({
      ok: !behaviorHit,
      label: behaviorHit ? "CONSTRAINT_VIOLATED" : "CONSTRAINT_OK",
      detail: `约束={${m.negativeConstraints.join("|")}} ${behaviorHit ? "行为触碰(写)" : "行为未触碰(写)"}`,
    })
  }
  // 义务保留：openObligations 覆盖 GT（报告自报 → 进度流 → 行为写路径）
  const obligationHits = m.openObligations.filter((o) =>
    containsAny(selfText, [o]) || containsAny(allPaths, [o]),
  )
  v.push({
    ok: obligationHits.length === m.openObligations.length,
    label: obligationHits.length === m.openObligations.length ? "OBLIGATION_OK" : "OBLIGATION_LOST",
    detail: obligationHits.length === m.openObligations.length
      ? `openObligations 覆盖 ${m.openObligations.length} 项`
      : `丢失义务: ${m.openObligations.filter((o) => !obligationHits.includes(o)).join(", ")}`,
  })
  // 关键事实保留：completedActions 覆盖 GT（报告 → 进度流 → 行为写路径/写内容）。
  // 别名组：每组内任一别名命中即该事实保留（中英同义词视为同一事实）。
  const missingActions = m.completedActions.filter(
    (group) => !group.some(
      (g) => containsAny(selfText, [g]) || containsAny(allPaths, [g]) || containsAny(allText, [g]),
    ),
  )
  v.push({
    ok: missingActions.length === 0,
    label: missingActions.length === 0 ? "FACTS_OK" : "FACTS_LOST",
    detail: missingActions.length
      ? `丢失关键事实: ${missingActions.map((g) => g.join("|")).join(", ")}`
      : `completedActions 覆盖 ${m.completedActions.length} 项(源=${src})`,
  })
  // 文件定位：relevantFiles 至少命中一个（报告 → 进度流 → 行为路径）
  const filesHit = m.relevantFiles.filter((f) =>
    containsAny(selfText, [f]) || containsAny(allPaths, [f]),
  ).length
  v.push({
    ok: filesHit > 0,
    label: filesHit > 0 ? "FILES_OK" : "FILES_LOST",
    detail: `relevantFiles 命中 ${filesHit}/${m.relevantFiles.length}(源=${src})`,
  })
  return v
}

// ── Case 运行 ──

interface WriteOp { path: string; round: number }

interface CaseResult {
  caseId: string
  group: string
  category: string
  ended: string
  rounds: number
  toolCalls: number
  maxChars: number
  maxAction: string
  rollovers: number
  microcompacts: number
  probe: ProbeJson | null
  progressBlocks: ProgressBlock[]
  behavior: BehaviorEvidence
  verdicts: Verdict[]
  duplicateWrites: Array<{ path: string; times: number }>
  /** 全部写操作（path + 轮次）——违禁/重复判定时序归因用 */
  writes: WriteOp[]
  toolFailures: string[]
  durationMs: number
}

function writeTarget(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>
    const path = o.path ?? o.file_path ?? o.filePath ?? o.target
    if (typeof path === "string") return path
  }
  return ""
}

async function runCase(c: ContextCase): Promise<CaseResult> {
  const started = Date.now()
  const workspaceDir = mkdtempSync(join(tmpdir(), "ormb-p3-"))
  try {
    for (const [path, content] of Object.entries(c.initialWorkspace)) {
      const full = join(workspaceDir, path)
      mkdirSync(join(full, ".."), { recursive: true })
      writeFileSync(full, content)
    }
    // 路径解析基准：write_file/read_file 等纯 Node 工具用 process.cwd() 解析
    // 相对路径（生产上 cwd==projectRoot）。评测 projectRoot=tmp workspace ≠
    // 进程 cwd → 模型写 "src/sort.ts" 会落到进程 cwd（探针污染，2026-08-06
    // 实测写进 orcana 仓库）。逐 case chdir 使解析基准与 projectRoot 对齐；
    // 相关缺陷（file.ts 未绑定 projectRoot/权威 hostRoot）已记 defect register。
    process.chdir(workspaceDir)
    // 项目级权限配置：放行 Risk 4-5 工具（shell/verification），否则
    // tool_risk gate 要求用户确认，headless 测试无交互通道 → 全部拦截。
    // config allow 优先级高于 Risk 4 的 ask 强制（PermissionGate Step 7）。
    mkdirSync(join(workspaceDir, ".orcana"), { recursive: true })
    writeFileSync(join(workspaceDir, ".orcana", "permissions.json"), JSON.stringify({
      rules: [
        { toolName: "shell", level: "allow", reason: "ORMB-P3 test" },
        { toolName: "run_process", level: "allow", reason: "ORMB-P3 test" },
        { toolName: "run_shell_script", level: "allow", reason: "ORMB-P3 test" },
        { toolName: "run_targeted_verification", level: "allow", reason: "ORMB-P3 test" },
        { toolName: "verify_claim", level: "allow", reason: "ORMB-P3 test" },
        { toolName: "typecheck", level: "allow", reason: "ORMB-P3 test" },
      ],
    }, null, 2))

    const auth = new FileAuthStore()
    const apiKey = await auth.get("deepseek")
    const config = loadConfig()
    const provider = new DeepSeekProvider(apiKey, config.providers?.deepseek?.baseUrl ?? undefined)
    const tools = buildTools(...assembleRuntimeToolDefs([]))
    const harness = createAgentHarness({
      deps: { provider, tools, flashTriagePolicy: "off" },
      sessionId: `p3-${c.caseId}`,
      projectRoot: workspaceDir,
    })
    await harness.createSession()

    // ── 事件收集 ──
    const statusLines: string[] = []
    const textChunks: string[] = []
    const writes: WriteOp[] = []
    const behavior: BehaviorEvidence = { writePaths: [], writeTexts: [], readPaths: [] }
    const toolFailures: string[] = []
    let toolCalls = 0
    let ended = "completed"
    let maxRound = 0
    let maxChars = 0
    let maxAction = "none"
    let rollovers = 0
    let microcompacts = 0

    const runIter = harness.run("p3-run", {
      prompt: c.prompt,
      maxRounds: MAX_ROUNDS ?? c.maxRounds,
      metadata: {
        "legacy.contextMaxTokens": CONTEXT_MAX_TOKENS,
        "legacy.autoApprovePlan": true,
        "legacy.autoFinishOnVerifiedWrite": false,
      },
    } as never)

    for await (const ev of runIter) {
      const payload = (ev as HarnessEvent & { payload?: unknown }).payload ?? {}
      switch (ev.type) {
        case "display.changed": {
          // adapter 把 loop 的 status 事件 bridge 成 display.changed
          // （{display:{kind:"status", data}}）——监听此形态解析 epoch 状态行
          const display = (payload as { display?: { kind?: string; data?: unknown } }).display
          if (display?.kind !== "status") break
          const s = String(display.data ?? "")
          statusLines.push(s)
          const epochMatch = s.match(/^epoch: (\d+) \| round: (\d+) \| chars: (\d+) \| action: (\w+)/)
          if (epochMatch) {
            maxRound = Math.max(maxRound, Number(epochMatch[2]))
            maxChars = Math.max(maxChars, Number(epochMatch[3]))
            maxAction = epochMatch[4]!
          }
          if (s.startsWith("epoch-rollover:")) rollovers++
          if (s.startsWith("microcompact:")) microcompacts++
          break
        }
        case "text.emitted": {
          const t = String((payload as { text?: unknown }).text ?? "")
          textChunks.push(t)
          break
        }
        case "tool.call.requested": {
          const tc = (payload as { toolCall?: { name?: string; input?: unknown; id?: string } }).toolCall
          if (!tc) break
          toolCalls++
          if (WRITE_TOOLS.has(tc.name ?? "")) {
            const p = writeTarget(tc.input)
            if (p) {
              writes.push({ path: p, round: maxRound })
              behavior.writePaths.push(p)
              // 写内容片段：构造性证据（旧决策复活/违禁/事实），前 200 字符
              const content = (tc.input as Record<string, unknown> | undefined)?.content ?? (tc.input as Record<string, unknown> | undefined)?.newContent ?? ""
              if (typeof content === "string") behavior.writeTexts.push(content.slice(0, 200))
            }
          } else if (READ_TOOLS.has(tc.name ?? "")) {
            const p = writeTarget(tc.input)
            if (p) behavior.readPaths.push(p)
          }
          break
        }
        case "tool.call.failed": {
          const tn = String((payload as { toolName?: unknown }).toolName ?? "?")
          const why = String((payload as { error?: unknown }).error ?? "")
          toolFailures.push(`${tn}: ${why.slice(0, 120)}`)
          break
        }
        case "run.completed":
          ended = "completed"
          break
        case "run.failed":
          ended = "failed"
          break
        case "run.blocked":
          ended = "blocked"
          break
        case "run.waiting":
          ended = "interrupt"
          break
      }
    }

    // ── 多源探针：最终报告 + 进度流（+ 行为证据已实时收集）──
    let probe: ProbeJson | null = null
    const progressBlocks: ProgressBlock[] = []
    for (const t of textChunks) {
      const p = extractProbe(t)
      if (p) { probe = p; continue }
      const pr = extractProgress(t)
      if (pr) progressBlocks.push(pr)
    }
    // 诊断：打印 status 事件与文本流尾部（前 4 块 + 后 3 块），定位探针丢失原因
    if (DIAG) {
      console.log(`   [diag] statusLines=${statusLines.length}`)
      for (const s of statusLines.slice(0, 6)) console.log(`   [diag] status: ${s.slice(0, 160)}`)
    }
    if (DIAG && !probe) {
      console.log(`   [diag] textChunks=${textChunks.length}`)
      const tail = textChunks.slice(0, 4).concat(textChunks.slice(-3))
      for (const t of tail) {
        console.log(`   [diag] text: ${t.slice(0, 220).replace(/\n/g, " ⏎ ")}`)
      }
    }

    // ── 判定（多源）──
    const verdicts = verifyProbe(probe, progressBlocks, behavior, c.manifest)
    // Tool Chain：任何工具失败或 run 异常 → fail
    if (toolFailures.length > 0) {
      verdicts.push({ ok: false, label: "TOOL_CHAIN_BROKEN", detail: toolFailures.join("; ") })
    } else {
      verdicts.push({ ok: true, label: "TOOL_CHAIN_OK", detail: `${toolCalls} 次工具调用无失败` })
    }
    // blocked 常见于 completion gate 缺验证证据（测试环境 shell/run_process
    // 被 Risk-4 门拦截，无交互通道）——若探针完整则不判 fail（P3 测 Context
    // 保留，不测 completion 链路）
    const probeAvailable = probe !== null || progressBlocks.length > 0 || behavior.writePaths.length > 0
    if (ended === "failed" || (ended === "blocked" && !probeAvailable)) {
      verdicts.push({ ok: false, label: "RUN_ABORTED", detail: `run ${ended}（探针${probeAvailable ? "已取到" : "缺失"}）` })
    } else if (ended === "blocked") {
      verdicts.push({ ok: true, label: "RUN_BLOCKED_NOOP", detail: "completion gate 未放行（测试环境无验证通道），探针已取到，不判失败" })
    }
    // 重复执行：同路径写入 ≥2 次且间隔 ≥5 轮 → 警告
    const byPath = new Map<string, number[]>()
    for (const w of writes) {
      const arr = byPath.get(w.path) ?? []
      arr.push(w.round)
      byPath.set(w.path, arr)
    }
    const duplicateWrites: Array<{ path: string; times: number }> = []
    for (const [path, rounds] of byPath) {
      if (rounds.length >= 2) {
        const gap = rounds[rounds.length - 1]! - rounds[0]!
        if (gap >= 5) duplicateWrites.push({ path, times: rounds.length })
      }
    }

    return {
      caseId: c.caseId,
      group: c.group,
      category: c.category,
      ended,
      // rounds：epoch status 行的 round（compress 前无 epoch 行 → 用文本块数近似）
      rounds: maxRound > 0 ? maxRound : textChunks.length,
      toolCalls,
      maxChars,
      maxAction,
      rollovers,
      microcompacts,
      probe,
      progressBlocks,
      behavior,
      verdicts,
      duplicateWrites,
      writes,
      toolFailures,
      durationMs: Date.now() - started,
    }
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true })
  }
}

// ── 汇总输出 ──

function printResult(r: CaseResult): void {
  const failed = r.verdicts.filter((v) => !v.ok)
  console.log(`\n${failed.length === 0 ? "✅" : "❌"} ${r.caseId} ${r.category} [${r.group}] — ${r.ended} ${r.rounds}轮/${r.toolCalls}次调用 ${(r.durationMs / 1000).toFixed(0)}s`)
  console.log(`   上下文峰值: ${r.maxChars.toLocaleString()} chars → ${r.maxAction} | rollover×${r.rollovers} microcompact×${r.microcompacts}`)
  console.log(`   探针: ${r.probe ? "最终报告✓" : "无最终报告"} 进度块×${r.progressBlocks.length} 写×${r.behavior.writePaths.length} 读×${r.behavior.readPaths.length}`)
  for (const v of r.verdicts) {
    console.log(`   ${v.ok ? "✅" : "❌"} ${v.label}: ${v.detail}`)
  }
  if (r.duplicateWrites.length > 0) {
    for (const d of r.duplicateWrites) {
      console.log(`   ⚠️  DUPLICATE_WRITE: ${d.path} 写入 ${d.times} 次（间隔≥5轮）`)
    }
  }
  if (r.toolFailures.length > 0) {
    for (const f of r.toolFailures) console.log(`   ⚠️  工具失败: ${f}`)
  }
  // 违禁或疑似重复工作：打印写操作轮次分布（时序归因——压缩前后）
  if (r.verdicts.some((v) => v.label === "CONSTRAINT_VIOLATED") || r.duplicateWrites.length > 0) {
    console.log(`   [writes] ${r.writes.map((w) => `${w.path}@r${w.round}`).join(", ")}`)
  }
}

// ── main ──

async function main(): Promise<void> {
  console.log(`ORMB-P3 Context 长任务（${CONTEXT_MAX_TOKENS / 1000}k tokens 窗口）cases=${CASES.length} live=${LIVE}`)
  if (!LIVE) {
    for (const c of CASES) {
      console.log(`✅ ${c.caseId} [${c.group}] 冒烟占位（live 关闭）`)
    }
    return
  }
  const results: CaseResult[] = []
  for (const c of CASES) {
    try {
      const r = await runCase(c)
      results.push(r)
      printResult(r)
    } catch (err) {
      console.log(`❌ ${c.caseId} 异常: ${String(err).slice(0, 200)}`)
    }
  }

  // 汇总
  const failed = results.filter((r) => r.verdicts.some((v) => !v.ok))
  console.log(`\n═══ ORMB-P3 汇总 ═══`)
  console.log(`  通过: ${results.length - failed.length}/${results.length}`)
  for (const g of ["compress", "rollover"] as const) {
    const group = results.filter((r) => r.group === g)
    if (group.length === 0) continue
    const trig = group.filter((r) => r.maxAction !== "none").length
    const rolled = group.filter((r) => r.rollovers > 0).length
    console.log(`  ${g} 组: ${group.length} 用例 | 触发 epoch 机制 ${trig}/${group.length} | 触发 rollover ${rolled}/${group.length}`)
    for (const r of group) {
      console.log(`    ${r.caseId}: 峰值 ${r.maxChars.toLocaleString()} chars (${r.maxAction}) rollover×${r.rollovers} 峰值轮 ${r.rounds}`)
    }
  }
  const dup = results.flatMap((r) => r.duplicateWrites)
  console.log(`  重复写入警告: ${dup.length} 处（${
    dup.length === 0 ? "≤5% 目标达成" : dup.map((d) => d.path).join(", ")
  }）`)
  const toolChains = results.filter((r) => r.toolFailures.length === 0).length
  console.log(`  Tool Chain 完整: ${toolChains}/${results.length}`)
  if (failed.length > 0) {
    console.log(`  ❌ 失败用例: ${failed.map((r) => r.caseId).join(", ")}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
