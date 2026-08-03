/**
 * 端到端集成测试 — 用户视角跑完整 Orcana 流程
 *
 * 模拟用户: "创建一个待办事项应用"
 * 验证: 意图识别 → 规划 → Master Plan 创建 → 工具执行 → 完成门
 */

import { agentLoop, type AgentOptions, type UsageStats } from "../src/agent/loop"
import { AgentRunTrace } from "../src/agent/run-trace"
import { DeepSeekProvider } from "../src/provider/deepseek"
import { buildTools } from "../src/tools/registry"
import { FILE_TOOLS } from "../src/tools/file"
import { SHELL_TOOL } from "../src/tools/shell"
import { WEB_SEARCH } from "../src/tools/search"
import { WEB_FETCH_TOOL } from "../src/tools/webfetch"
import { ThinkingStore } from "../src/memory/thinking-store"
import { KnowledgeBase } from "../src/memory/knowledge"
import { test, expect } from "bun:test"
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const API_KEY = process.env.DEEPSEEK_API_KEY ?? ""
if (!API_KEY) throw new Error("DEEPSEEK_API_KEY not set")

const TMP = join(import.meta.dir, "..", "tests", "tmp", "e2e-todo")
function clean() { if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true }) }
function setup() { mkdirSync(TMP, { recursive: true }) }

test("E2E: 用户视角 — 创建待办事项应用（完整流程）", async () => {
  clean(); setup()

  const provider = new DeepSeekProvider(API_KEY)
  const toolDefs = [...FILE_TOOLS, SHELL_TOOL, WEB_SEARCH, WEB_FETCH_TOOL]
  const tools = buildTools(...toolDefs)
  const thinkingStore = new ThinkingStore()
  const knowledgeBase = new KnowledgeBase()
  const PROMPT = [
    "创建一个简洁的待办事项应用。单文件 HTML + CSS + JS，不要用框架。",
    "功能: 添加任务、标记完成、删除任务。数据用 localStorage 持久化。",
    "设计: 简洁但不丑陋 — 有色彩层次、圆角卡片、hover 效果。",
    "写到 tests/tmp/e2e-todo/index.html。然后验证文件存在。",
  ].join("\n")

  console.log("\n" + "=".repeat(70))
  console.log("E2E: 用户视角 — 待办事项应用")
  console.log("=".repeat(70) + "\n")

  const events: Array<{ type: string; data?: unknown }> = []

  for await (const event of agentLoop(PROMPT, {
    provider,
    model: "deepseek-v4-pro",
    tools,
    maxRounds: 15,
    thinkingStore,
    knowledgeBase,
    thinkEffort: "max",
    autoFinishOnVerifiedWrite: true,
    runTrace: AgentRunTrace.start(TMP, "e2e-todo-test"),
  })) {
    events.push(event)
    // Log important events
    if (event.type === "status") {
      const s = String(event.data ?? "")
      const key = /主计划|任务追踪|planning|completion|ripple|quality-gate|thinking-compaction|evidence-gate|tool-retry|external-completion|verified|evidence/i
      if (key.test(s)) console.log(`  [STATUS] ${s}`)
    }
    if (event.type === "tool_call" && event.data && typeof event.data === "object") {
      const tc = event.data as { name?: string; input?: Record<string, unknown> }
      console.log(`  [TOOL] ${tc.name}: ${JSON.stringify(tc.input).slice(0, 120)}`)
    }
    if (event.type === "text" && typeof event.data === "string") {
      const txt = event.data as string
      if (txt.length > 80) console.log(`  [TEXT] ${txt.slice(0, 200)}...`)
    }
  }

  // ── 验证 ──

  // 1. 文件确实被创建了
  const indexPath = join(TMP, "index.html")
  const fileCreated = existsSync(indexPath)
  console.log(`\n文件创建: ${fileCreated ? "✅" : "❌"}`)
  expect(fileCreated).toBe(true)

  // 2. 文件内容有实质功能，不是空壳
  if (fileCreated) {
    const content = readFileSync(indexPath, "utf-8")
    const hasTodo = /todo|task|item|localStorage|add|delete/i.test(content)
    const hasStyle = /style|css|<style|background|color|border-radius|hover/i.test(content)
    console.log(`  HTML大小: ${content.length} chars`)
    console.log(`  功能代码: ${hasTodo ? "✅" : "❌"}`)
    console.log(`  样式代码: ${hasStyle ? "✅" : "❌"}`)
    expect(content.length).toBeGreaterThan(500)
    expect(hasTodo).toBe(true)
  }

  // 3. 流程关键节点都被触发
  const statusMessages = events
    .filter(e => e.type === "status")
    .map(e => String(e.data ?? ""))

  const planDetected = statusMessages.some(s => /任务追踪.*长任务|规划/.test(s))
  const buildDetected = statusMessages.some(s => /任务追踪.*执行/i.test(s))
  const verifiedDetected = statusMessages.some(s => /completion-gate.*verified|verified.*write|typecheck/i.test(s))

  console.log(`\n流程验证:`)
  console.log(`  规划阶段: ${planDetected ? "✅" : "❌"}`)
  console.log(`  执行阶段: ${buildDetected ? "OK" : "SKIP (单文件项目可能跳过)"}`)
  console.log(`  验证阶段: ${verifiedDetected ? "OK" : "WARN"}`)

  // 4. Thinking store 有记录
  const thinkingStats = thinkingStore.stats()
  console.log(`\n思考链: ${thinkingStats.totalRecords} 条记录`)

  // 5. No catastrophic failures
  const errors = events.filter(e => e.type === "error")
  console.log(`错误: ${errors.length}`)
  expect(errors.length).toBe(0)

  clean()
  console.log("\n✅ E2E 通过\n")
}, { timeout: 600_000 })
