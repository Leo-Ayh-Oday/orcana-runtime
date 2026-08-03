/**
 * 思考质量实战评估 — 用我们最难的场景，测 V4 思考的真实质量
 *
 * 不测 token 数。测回答质量：完整性、正确性、深度、可操作性。
 * 每个场景用 max effort + 32K budget，让模型尽全力。
 */

import { DeepSeekProvider } from "../src/provider/deepseek"
import { test, expect } from "bun:test"

const API_KEY = process.env.DEEPSEEK_API_KEY ?? ""
if (!API_KEY) throw new Error("DEEPSEEK_API_KEY not set")
const provider = new DeepSeekProvider(API_KEY)

interface QualityEval {
  name: string
  system: string
  prompt: string
  /** 答案中必须出现的硬指标（模型不知道这些，只用于自动评分） */
  mustContain: string[]
  /** 答案中应该出现的软信号 */
  shouldContain: string[]
  /** 答案中不能出现的错误信号 */
  mustNotContain: string[]
  /** 最少回答字符数（太短 = 没认真思考） */
  minLength: number
}

const HARD_CASES: QualityEval[] = [
  // ═══ 场景1: 我们的涟漪引擎漏检问题（真实bug） ═══
  {
    name: "重构影响分析 — 涟漪引擎漏检",
    system: [
      "你是资深 TypeScript 编译器工程师。分析代码变更时，",
      "考虑所有可能的影响路径：default export、re-export、重命名 import、",
      "类型别名、泛型约束、条件类型、装饰器、声明合并。",
      "给出具体的检查清单和每项的检测方法。",
    ].join(" "),
    prompt: [
      "我有一个 TypeScript AST 分析工具（涟漪引擎），它检测函数签名变更后的所有调用者。",
      "当前实现只检查了顶层 `FunctionDeclaration`、`InterfaceDeclaration`、",
      "`TypeAliasDeclaration`、`ClassDeclaration`、`VariableStatement`。",
      "",
      "已知漏检: default export、re-export (export {x} from './y')、",
      "重命名 import (import {add as sum})。",
      "",
      "请分析: 还有哪些 TypeScript 导出/引用形式是当前的 AST 遍历会漏掉的？",
      "给出完整的检测清单，每项附 TypeScript AST 节点类型 (SyntaxKind) 和处理方法。",
    ].join("\n"),
    mustContain: ["ExportDeclaration", "SyntaxKind", "export *", "重导出"],
    shouldContain: ["namespace", "declare", "typeof", "三斜线", ".d.ts", "声明文件"],
    mustNotContain: ["绝对没错", "肯定没有", "已经完整了"],
    minLength: 800,
  },

  // ═══ 场景2: 冷记忆过期策略设计 ═══
  {
    name: "冷记忆生命周期 — 过期策略设计",
    system: [
      "你是资深知识管理架构师。设计系统时考虑信息熵、访问模式、",
      "存储成本和检索精度之间的 trade-off。给出可量化的决策标准。",
    ].join(" "),
    prompt: [
      "我有一套冷记忆系统，存储 Agent 在长任务中的思考洞察。每条洞察有一个类别:",
      "{ verified, discarded, insight, open }，一个创建时间，和一个最后出现时间。",
      "",
      "我需要设计自动过期策略：",
      "- [open] 超过 N 天没再出现 → 自动降级或删除",
      "- [verified] 超过 M 天没再出现 → 降级为普通 insight",
      "- [discarded] 超过 P 天 → 直接删除",
      "",
      "问题: N、M、P 应该设多少？为什么？",
      "考虑因素: 长任务可能持续数小时到数天，Agent 可能在不同时期面对不同项目。",
      "给出明确的数值建议和计算依据。",
    ].join("\n"),
    mustContain: ["天", "小时"],
    shouldContain: ["会话", "权重", "衰减", "频率"],
    mustNotContain: ["随便", "都可以", "无所谓"],
    minLength: 400,
  },

  // ═══ 场景3: Token 预算与思考深度 trade-off ═══
  {
    name: "思考预算 — 什么时候该 deep think, 什么时候不该",
    system: [
      "你是 AI 系统效能优化专家。分析 trade-off 时给出具体的量化判断标准，",
      "而不是模糊建议。每个结论附计算逻辑。",
    ].join(" "),
    prompt: [
      "DeepSeek V4 的 thinking mode 有三个 level: off / high(16K) / max(32K)。",
      "开了 thinking 会消耗更多 token 和时间，但推理质量更高。",
      "",
      "问题: 如何自动判断一个任务是否需要开 thinking？需要多深的 thinking？",
      "",
      "现有方案是用正则匹配关键词（检测「架构」「安全」「重构」等词），分数≥11 → 32K。",
      "这个方案的局限性是什么？",
      "",
      "设计一个更好的路由方案。考虑: 任务本身的复杂度信号、对话历史的复杂度信号、",
      "之前同类任务的思考效果反馈。",
    ].join("\n"),
    mustContain: ["正则", "词匹配"],
    shouldContain: ["反馈", "闭环", "learn", "模型", "路由"],
    mustNotContain: ["正则已经足够"],
    minLength: 500,
  },

  // ═══ 场景4: 安全沙箱设计 — new Function() 的风险 ═══
  {
    name: "安全沙箱 — JS code-interpreter 风险评估",
    system: [
      "你是浏览器安全专家和沙箱设计者。分析安全边界时穷举所有可能的逃逸路径，",
      "包括文档未记载的行为和引擎差异（V8 vs JavaScriptCore vs Bun）。",
    ].join(" "),
    prompt: [
      "我打算给 Orcana 加一个 `code_interpreter` 工具，",
      "让模型能写 JavaScript 代码并安全执行。用 `new Function()` 做沙箱。",
      "",
      "已知风险:",
      "- `new Function()` 的词法作用域隔离（不能访问闭包变量）",
      "- 只注入白名单工具函数",
      "- 在 Worker 线程中运行以防止死循环阻塞 event loop",
      "",
      "请分析还有哪些我没有考虑到的逃逸路径？",
      "特别关注 Bun 特有的全局对象（`Bun`, `globalThis`）、",
      "原型链攻击（`({}).constructor.constructor`）、",
      "异步逃逸（`setTimeout`/`queueMicrotask`）、",
      "以及 Worker postMessage 序列化漏洞。",
      "",
      "对每个风险，给出具体的防护措施。",
    ].join("\n"),
    mustContain: ["constructor", "原型", "prototype", "Worker"],
    shouldContain: ["Symbol", "Proxy", "getter", "side channel", "时间攻击"],
    mustNotContain: ["绝对安全", "100% safe", "完全防止"],
    minLength: 600,
  },

  // ═══ 场景5: 长任务上下文降级策略 ═══
  {
    name: "上下文管理 — 优雅降级策略",
    system: [
      "你是分布式系统工程师，专精于资源约束下的服务质量保证。",
      "设计降级策略时给出精确的触发条件、降级动作、和恢复条件。",
    ].join(" "),
    prompt: [
      "Orcana 有 1M token 上下文窗口。当前策略:",
      "- 50% → degraded mode（只完成当前阶段）",
      "- 60% → block（停止，要求用户压缩或新建会话）",
      "",
      "问题: 这个策略有什么问题？",
      "提示: 考虑任务类型差异（搜索 vs 写代码 vs 长任务规划）、",
      "上下文压缩的成本/收益、以及模型在 degraded mode 下的实际行为。",
      "",
      "设计一个更智能的降级策略。可以是基于任务阶段（规划/编码/验证）的不同策略，",
      "或者基于上下文内容的智能压缩触发。",
    ].join("\n"),
    mustContain: ["degraded", "block", "50%", "60%"],
    shouldContain: ["阶段", "压缩", "触发", "阈值", "恢复"],
    mustNotContain: ["当前策略已经足够"],
    minLength: 500,
  },
]

// ── Quality scoring ──

interface QualityResult {
  name: string
  outputText: string
  thinkingText: string
  mustHits: number
  mustTotal: number
  shouldHits: number
  shouldTotal: number
  mustNotHits: number
  mustNotTotal: number
  lengthOk: boolean
  hasCode: boolean
  hasChecklist: boolean
  hasTradeoff: boolean
  score: number
  time: number
}

async function evaluateCase(c: QualityEval): Promise<QualityResult> {
  const start = Date.now()
  const thinkingBlocks: Array<{ thinking: string }> = []
  const textChunks: string[] = []

  for await (const ev of provider.streamChat({
    model: "deepseek-v4-pro",
    system: c.system,
    messages: [{ role: "user", content: c.prompt }],
    thinking: { type: "enabled", budget_tokens: 32768, effort: "max" },
    maxTokens: 4096,
  })) {
    if (ev.type === "thinking_blocks" && Array.isArray(ev.data)) {
      for (const tb of ev.data as Array<{ thinking: string }>) thinkingBlocks.push(tb)
    }
    if (ev.type === "text" && typeof ev.data === "string") textChunks.push(ev.data)
  }

  const output = textChunks.join("")
  const thinking = thinkingBlocks.map(t => t.thinking).join("\n---\n")

  // Score
  const mustHits = c.mustContain.filter(p => new RegExp(p, "i").test(output)).length
  const shouldHits = c.shouldContain.filter(p => new RegExp(p, "i").test(output)).length
  const mustNotHits = c.mustNotContain.filter(p => new RegExp(p, "i").test(output)).length
  const hasCode = /```|`[^`]+`/.test(output)
  const hasChecklist = /[-*]\s|^\d+\.\s/m.test(output)
  const hasTradeoff = /权衡|trade.?off|vs\.?|对比|优于|不如|优势|劣势|代价|成本|风险/i.test(output)

  const score =
    (mustHits / c.mustContain.length) * 40 +
    (shouldHits / c.shouldContain.length) * 20 +
    (mustNotHits === 0 ? 20 : 0) +
    (output.length >= c.minLength ? 10 : 0) +
    (hasCode ? 5 : 0) +
    (hasChecklist ? 3 : 0) +
    (hasTradeoff ? 2 : 0)

  return {
    name: c.name,
    outputText: output.slice(0, 3000),
    thinkingText: thinking.slice(0, 1000),
    mustHits, mustTotal: c.mustContain.length,
    shouldHits, shouldTotal: c.shouldContain.length,
    mustNotHits, mustNotTotal: c.mustNotContain.length,
    lengthOk: output.length >= c.minLength,
    hasCode, hasChecklist, hasTradeoff,
    score: Math.round(score),
    time: Date.now() - start,
  }
}

// ── Main ──

test("思考质量实战评估: 5个最难的场景 (V4 Pro Max)", async () => {
  console.log("\n" + "=".repeat(70))
  console.log("DeepSeek V4 思考质量实战评估 — 5 个最难的场景")
  console.log("模式: max effort, 32K budget")
  console.log("评分: 硬指标40分 + 软指标20分 + 无错误20分 + 长度10分 + 质量加分10分")
  console.log("=".repeat(70) + "\n")

  const results: QualityResult[] = []

  for (let i = 0; i < HARD_CASES.length; i++) {
    const c = HARD_CASES[i]!
    console.log(`[${i + 1}/${HARD_CASES.length}] ${c.name}`)
    const r = await evaluateCase(c)
    results.push(r)

    console.log(`  must: ${r.mustHits}/${r.mustTotal}  should: ${r.shouldHits}/${r.shouldTotal}  err: ${r.mustNotHits}/${r.mustNotTotal}`)
    console.log(`  code:${r.hasCode ? "✅" : "-"}  checklist:${r.hasChecklist ? "✅" : "-"}  tradeoff:${r.hasTradeoff ? "✅" : "-"}  len:${r.lengthOk ? "✅" : "❌"}`)
    console.log(`  score: ${r.score}/100  time: ${(r.time / 1000).toFixed(1)}s`)
    if (r.thinkingText.length > 50) {
      console.log(`  think: ${r.thinkingText.slice(0, 180).replace(/\n/g, " ")}...`)
    }
    console.log("")

    if (i < HARD_CASES.length - 1) await new Promise(r => setTimeout(r, 1500))
  }

  // ── 汇总 ──
  const avg = results.reduce((s, r) => s + r.score, 0) / results.length
  const allNoErrors = results.every(r => r.mustNotHits === 0)
  const avgTime = results.reduce((s, r) => s + r.time, 0) / results.length

  console.log("=".repeat(70))
  console.log("汇总报告")
  console.log("=".repeat(70))
  console.log(`平均分:   ${Math.round(avg)}/100`)
  console.log(`无严重错误: ${allNoErrors ? "✅" : "❌"}`)
  console.log(`平均耗时: ${(avgTime / 1000).toFixed(1)}s`)
  console.log("")

  for (const r of results) {
    const bar = r.score >= 80 ? "🟢" : r.score >= 60 ? "🟡" : "🔴"
    console.log(`  ${bar} ${r.score}  ${r.name}  (${r.mustHits}/${r.mustTotal}+${r.shouldHits}/${r.shouldTotal}, err:${r.mustNotHits})`)
  }

  console.log("")

  // 断言 — 平均至少 60 分，无场景低于 40
  expect(avg).toBeGreaterThanOrEqual(60)
  for (const r of results) {
    expect(r.score).toBeGreaterThanOrEqual(40)
  }
}, { timeout: 600_000 })
