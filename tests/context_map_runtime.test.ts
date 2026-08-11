import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { agentLoop } from "../src/agent/loop"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"

class ContextMapCaptureProvider implements LLMProvider {
  messages: ProviderCallOptions["messages"][] = []

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.messages.push(options.messages)
    yield { type: "text", data: "done" }
  }
}

describe("agentLoop ContextMap runtime integration", () => {
  test("injects ContextMap evidence into the stable provider context", async () => {
    const provider = new ContextMapCaptureProvider()
    const events: StreamEvent[] = []

    for await (const event of agentLoop("Say hello briefly", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 1,
      flashTriagePolicy: "off",
      contextMapPolicy: "always",
    })) {
      events.push(event)
    }

    expect(events.some(event => event.type === "status" && String(event.data).startsWith("context-map:"))).toBe(true)
    expect(JSON.stringify(provider.messages[0])).toContain("## Context Map")
  })

  test("IC01-R4: agentLoop 真实入口（production 权威注入）—— secret / symlink escape 拒绝，良性文件正常进入", async () => {
    const root = mkdtempSync(join(tmpdir(), "orcana-r4-prod-loop-"))
    const outside = mkdtempSync(join(tmpdir(), "orcana-r4-prod-out-"))
    try {
      mkdirSync(join(root, "src"), { recursive: true })
      mkdirSync(join(outside, "packages"), { recursive: true })
      writeFileSync(join(root, "package.json"), '{"name":"fixture","scripts":{"test":"bun test"}}', "utf-8")
      writeFileSync(join(root, "src", "ok.ts"), "okmarker export const ok = 1\n", "utf-8")
      writeFileSync(join(root, ".env"), "REAL_SECRET_TOKEN=xyz", "utf-8")
      writeFileSync(join(outside, "packages", "evil.ts"), "EVILMARKER export const evil = 1\n", "utf-8")
      writeFileSync(join(outside, "outside.txt"), "OUTSIDE-SECRET-CONTENT", "utf-8")
      // README -> .env（secret alias）；packages 目录 -> 根外（escape）。
      symlinkSync(join(root, ".env"), join(root, "README.md"))
      symlinkSync(join(outside, "packages"), join(root, "packages"))
      const provider = new ContextMapCaptureProvider()
      const events: StreamEvent[] = []
      for await (const event of agentLoop("fix okmarker", {
        provider,
        model: "test",
        tools: [],
        maxRounds: 1,
        flashTriagePolicy: "off",
        contextMapPolicy: "always",
        projectRoot: root,
      })) {
        events.push(event)
      }
      expect(events.some(event => event.type === "status" && String(event.data).startsWith("context-map:"))).toBe(true)
      const serialized = JSON.stringify(provider.messages[0] ?? [])
      expect(serialized).toContain("## Context Map")
      // 良性文件正常进入（权威强制下 ContextMap 仍工作）。
      expect(serialized).toContain("src/ok.ts")
      // secret / 外逃内容 / 恶意目录绝不进入 ContextMap 上下文。
      expect(serialized).not.toContain("REAL_SECRET_TOKEN")
      expect(serialized).not.toContain("OUTSIDE-SECRET-CONTENT")
      expect(serialized).not.toContain("evil.ts")
      expect(serialized).not.toContain("EVILMARKER")
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
