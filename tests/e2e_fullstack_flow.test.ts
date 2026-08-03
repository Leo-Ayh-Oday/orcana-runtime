/**
 * E2E 全栈 — 实时协作笔记，高质量验收
 * 跑 Orcana agentLoop 全流程：意图 → 规划 → 执行 → 验证
 */
import { agentLoop } from "../src/agent/loop"
import { DeepSeekProvider } from "../src/provider/deepseek"
import { buildTools } from "../src/tools/registry"
import { FILE_TOOLS } from "../src/tools/file"
import { SHELL_TOOL } from "../src/tools/shell"
import { WEB_SEARCH } from "../src/tools/search"
import { ThinkingStore } from "../src/memory/thinking-store"
import { KnowledgeBase } from "../src/memory/knowledge"
import { AgentRunTrace } from "../src/agent/run-trace"
import { test, expect } from "bun:test"
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs"
import { relative } from "node:path"
import { join, resolve } from "node:path"

const API_KEY = process.env.DEEPSEEK_API_KEY ?? ""
if (!API_KEY) throw new Error("DEEPSEEK_API_KEY not set")

const TMP = resolve(join(import.meta.dir, "..", "tests", "tmp", "e2e-notes"))

function clean() { if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true }) }
function setup() { mkdirSync(TMP, { recursive: true }) }

function allFiles(dir: string): string[] {
  const out: string[] = []
  try {
    walk(dir, out, dir)
  } catch { /* ok */ }
  return out
}

function walk(dir: string, out: string[], root: string) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue
    const full = resolve(dir, e.name)
    if (e.isDirectory()) { walk(full, out, root) }
    else {
      out.push(relative(root, full).replace(/\\/g, "/"))
    }
  }
}

test("E2E 全栈: 实时协作笔记（完整流程）", async () => {
  clean(); setup()
  const orig = process.cwd
  process.cwd = () => TMP

  const provider = new DeepSeekProvider(API_KEY)
  const tools = buildTools(...FILE_TOOLS, SHELL_TOOL, WEB_SEARCH)
  const thinkStore = new ThinkingStore()
  const kb = new KnowledgeBase()

  const PROMPT = [
    "创建一个实时协作笔记应用，前后端分离。",
    "后端: Bun + Hono + TypeScript。前端: 单 HTML + CSS + vanilla JS. 数据: JSON 文件。",
    "功能: 笔记 CRUD(Markdown) + 列表(按更新时间排序)。API: GET/POST/PUT/DELETE /api/notes。",
    "要求: 生产级 — 错误处理、CORS、响应式、测试。先规划再实现。",
    `工作目录: tests/tmp/e2e-notes/`,
  ].join(" ")

  console.log("\n" + "=".repeat(60))
  console.log("E2E 全栈: 实时协作笔记")
  console.log("=".repeat(60) + "\n")

  const events: Array<{ type: string; data?: unknown }> = []
  for await (const ev of agentLoop(PROMPT, {
    provider, model: "deepseek-v4-pro", tools, maxRounds: 20,
    thinkingStore: thinkStore, knowledgeBase: kb,
    thinkEffort: "max", autoFinishOnVerifiedWrite: true,
    runTrace: AgentRunTrace.start(TMP, "e2e-notes"),
  })) {
    events.push(ev)
    if (ev.type === "status") console.log(`  [S] ${String(ev.data ?? "").slice(0, 200)}`)
    if (ev.type === "tool_call" && ev.data && typeof ev.data === "object") {
      const tc = ev.data as { name?: string; input?: Record<string, unknown> }
      console.log(`  [T] ${tc.name}: ${JSON.stringify(tc.input).slice(0, 140)}`)
    }
  }
  process.cwd = orig

  // ── 验收 ──
  const files = allFiles(TMP)
  console.log(`\n文件 (${files.length}):`)
  for (const f of files.sort()) {
    console.log(`  ${f} (${existsSync(join(TMP, f)) ? readFileSync(join(TMP, f)).length : 0} chars)`)
  }

  const hasPkg = files.includes("package.json")
  const hasServer = files.some(f => /^(backend|server)\/(index|server|routes|app|store)\.ts$/.test(f))
  const hasClient = files.some(f => /^(frontend|client)\/.*\.(html|js)$/.test(f))
  const hasTest = files.some(f => /\.test\.ts$/.test(f))
  const hasTsconfig = files.includes("tsconfig.json")

  console.log(`\n核心: pkg=${hasPkg ? "✅" : "❌"} server=${hasServer ? "✅" : "❌"} client=${hasClient ? "✅" : "❌"} test=${hasTest ? "✅" : "❌"} tsconfig=${hasTsconfig ? "✅" : "⚠️"}`)

  // 质量检查
  let qualityScore = 0
  if (hasServer) {
    const srvPath = join(TMP, files.find(f => /^(backend|server)\/.+routes.*\.ts$/.test(f)) ?? "")
    if (existsSync(srvPath)) {
      const s = readFileSync(srvPath, "utf-8")
      if (/\.get\s*\(.*notes/.test(s)) qualityScore++
      if (/\.post\s*\(.*notes/.test(s)) qualityScore++
      if (/\.put\s*\(.*notes/.test(s)) qualityScore++
      if (/\.delete\s*\(.*notes/.test(s)) qualityScore++
      if (/cors|Access-Control/i.test(s)) qualityScore++
      if (/404|error|status/i.test(s)) qualityScore++
    }
  }
  if (hasClient) {
    const cliPath = join(TMP, files.find(f => /^(frontend|client)\/.*\.(html|js)$/.test(f)) ?? "")
    if (existsSync(cliPath)) {
      const c = readFileSync(cliPath, "utf-8")
      if (/style|css|<style|color|border|shadow|hover/i.test(c)) qualityScore++
      if (/fetch\s*\(.*api/i.test(c)) qualityScore++
    }
  }
  if (hasTest) {
    const tstPath = join(TMP, files.find(f => /\.test\.ts$/.test(f)) ?? "")
    if (existsSync(tstPath)) {
      const t = readFileSync(tstPath, "utf-8")
      if (/test|it\s*\(|describe/i.test(t)) qualityScore++
      if (/fetch\s*\(|localhost/i.test(t)) qualityScore++
    }
  }
  console.log(`质量分: ${qualityScore}/10`)

  const statuses = events.filter(e => e.type === "status").map(e => String(e.data ?? ""))
  console.log(`规划: ${statuses.some(s => /long|规划|主计划|planning|任务追踪/.test(s)) ? "✅" : "⚠️"}`)
  console.log(`执行: ${statuses.some(s => /building|write_file|执行/.test(s)) ? "✅" : "—"}`)
  console.log(`思考: ${thinkStore.stats().totalRecords} 条 | 错误: ${events.filter(e => e.type === "error").length}`)

  expect(hasPkg).toBe(true); expect(hasServer).toBe(true)
  expect(hasClient).toBe(true); expect(hasTest).toBe(true)
  expect(qualityScore).toBeGreaterThanOrEqual(6)

  // Keep files for manual inspection
  // clean()
  console.log("\n✅ E2E 全栈通过\n")
}, { timeout: 600_000 })
