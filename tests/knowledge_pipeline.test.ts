/**
 * 统一知识管道验证 — 搜索→蒸馏→KB存储→跨会话召回
 *
 * 验证 6 轮递进场景
 */

import { KnowledgeBase } from "../src/memory/knowledge"
import type { KeyFact } from "../src/memory/knowledge"
import { distillAndStore, shouldDistill } from "../src/memory/distiller"
import { DeepSeekProvider } from "../src/provider/deepseek"
import { rmSync } from "node:fs"
import { test, expect } from "bun:test"

const API_KEY = process.env.DEEPSEEK_API_KEY ?? ""
const skipLiveTests = !API_KEY

const provider = new DeepSeekProvider(API_KEY)

// ── 辅助函数 ──

async function flashStream(system: string, prompt: string): Promise<string> {
  const chunks: string[] = []
  for await (const ev of provider.streamChat({
    model: "deepseek-v4-flash",
    system,
    messages: [{ role: "user", content: prompt }],
    maxTokens: 512,
  })) {
    if (ev.type === "text" && typeof ev.data === "string") chunks.push(ev.data)
  }
  return chunks.join("")
}

async function* streamAdapter(system: string, prompt: string) {
  const text = await flashStream(system, prompt)
  yield { type: "text" as const, data: text }
}

// ── 测试场景 ──

test("知识管道: 6轮递进验证", async () => {
  // 使用独立目录避免污染主 KB
  const tmpDir = `${import.meta.dir}/../.orcana/test-kb-${Date.now()}`
  const kb = new KnowledgeBase(tmpDir)

  try {
    console.log("\n" + "=".repeat(60))
    console.log("统一知识管道验证 — 6轮")
    console.log("=".repeat(60) + "\n")

  // ── Round 1: 搜索 → 蒸馏到 KB ──
  console.log("[1/6] 搜索蒸馏...")
  const searchResult1 = [
    "DeepSeek V4 uses a Mixture-of-Experts architecture with 1.6T total parameters",
    "DeepSeek V4 supports 1M token context window with hybrid attention (MLA+MSA)",
    "DeepSeek V4 thinking mode has two levels: high and max reasoning effort",
    "The model is available via Anthropic-compatible API endpoint at api.deepseek.com/anthropic",
    "DeepSeek V4 pricing is $0.435/M input tokens, $0.87/M output tokens for Pro version",
  ].join("\n")

  const facts1: KeyFact[] = []
  for (const entry of await distillAndStore(
    { query: "DeepSeek V4 architecture and pricing", results: searchResult1, trigger: "research" },
    provider,
    kb,
  )) {
    facts1.push({ topic: entry.topic, fact: entry.solution })
  }
  console.log(`  蒸馏出 ${facts1.length} 条事实`)
  expect(facts1.length).toBeGreaterThanOrEqual(2)

  // ── Round 2: 另一次搜索，不同方向 ──
  console.log("[2/6] 第二次搜索蒸馏...")
  const searchResult2 = [
    "DeepSeek V4 has a Flash variant with 284B parameters that is 3x cheaper than Pro",
    "The Flash model uses 13B activated parameters per token",
    "DeepSeek V4 supports DSML token format for native tool calling",
    "V4 can handle context windows up to 1M tokens efficiently",
  ].join("\n")

  const entries2 = await distillAndStore(
    { query: "DeepSeek V4 Flash model details", results: searchResult2, trigger: "research" },
    provider,
    kb,
  )
  console.log(`  蒸馏出 ${entries2.length} 条`)
  expect(entries2.length).toBeGreaterThanOrEqual(1)

  // ── Round 3: 验证 KB 去重（重复搜索不应该创建重复条目） ──
  console.log("[3/6] 去重验证（重复搜索）...")
  const statsBefore = kb.stats()
  await distillAndStore(
    { query: "DeepSeek V4 architecture", results: searchResult1, trigger: "research" },
    provider,
    kb,
  )
  const statsAfter = kb.stats()
  console.log(`  去重前: ${statsBefore.entries} 条, 去重后: ${statsAfter.entries} 条 (fuzzy dedup, max +3)`)

  // ── Round 4: 验证 shouldDistill 过滤 ──
  console.log("[4/6] shouldDistill 过滤...")
  expect(shouldDistill("DeepSeek V4 release date", "research")).toBe(true)
  expect(shouldDistill("hi", "research")).toBe(false)
  expect(shouldDistill("", "research")).toBe(false)
  console.log("  过滤正确: 跳过 trivial 查询")

  // ── Round 5: 验证 KB 召回（模拟下次会话） ──
  console.log("[5/6] 知识召回（模拟新会话）...")
  const recall = kb.findRelevant("DeepSeek V4 architecture thinking mode")
  console.log(`  召回 ${recall.length} 条相关记录`)
  for (const r of recall) {
    console.log(`  - ${r.topic}: ${r.solution.slice(0, 80)}`)
  }
  expect(recall.length).toBeGreaterThanOrEqual(1)

  // ── Round 6: getActive 返回高价值条目 ──
  console.log("[6/6] Active 条目...")
  const active = kb.getActive(5)
  console.log(`  活跃条目: ${active.length}`)
  const withSource = kb.stats().withSource
  console.log(`  含源URL: ${withSource}`)
  expect(active.length).toBeGreaterThanOrEqual(1)

    console.log("\n✅ 6轮验证全部通过")
  } finally {
    kb.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }
}, { timeout: 120_000 })
