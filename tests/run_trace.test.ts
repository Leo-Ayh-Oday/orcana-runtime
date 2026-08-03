import { mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { agentLoop } from "../src/agent/loop"
import { AgentRunTrace } from "../src/agent/run-trace"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { buildTools, Result } from "../src/tools/registry"

class TraceToolProvider implements LLMProvider {
  rounds = 0

  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    if (this.rounds++ === 0) {
      yield { type: "tool_call", data: { id: "read", name: "read_file", input: { path: "README.md" } } }
      return
    }
    yield { type: "text", data: "done" }
  }
}

class TraceUsageProvider implements LLMProvider {
  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    yield {
      type: "token_usage",
      data: {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 900,
        cacheMissInputTokens: 100,
        cacheHitRate: 90,
        source: "provider",
      },
    }
    yield { type: "text", data: "done" }
  }
}

function readTraceTypes(file: string): string[] {
  return readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line).type as string)
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

describe("AgentRunTrace", () => {
  test("writes append-only jsonl events", () => {
    const cwd = mkdtempSync(join(tmpdir(), "dscode-trace-"))
    const trace = AgentRunTrace.start(cwd, "hello")
    trace.record("custom", { token: "secret", value: 1 })

    const lines = readFileSync(trace.file, "utf-8").trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).type).toBe("run_started")
    expect(JSON.parse(lines[1]!).data.token).toBe("[redacted]")
  })

  test("agent loop records rounds and tool results", async () => {
    const oldCostMode = process.env.ORCANA_COST_MODE
    process.env.ORCANA_COST_MODE = "strict"
    const cwd = mkdtempSync(join(tmpdir(), "dscode-trace-"))
    const trace = AgentRunTrace.start(cwd, "read file")
    const tools = buildTools({
      name: "read_file",
      description: "fake read",
      isReadonly: true,
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      async execute() {
        return Result.ok("hello", { path: "README.md" })
      },
    })

    try {
      for await (const _event of agentLoop("read file", {
        provider: new TraceToolProvider(),
        model: "test",
        tools,
        maxRounds: 2,
        runTrace: trace,
      })) {
        // drain
      }
    } finally {
      restoreEnv("ORCANA_COST_MODE", oldCostMode)
    }

    const types = readTraceTypes(trace.file)
    expect(types).toContain("agent_loop_started")
    expect(types).toContain("round_started")
    expect(types).toContain("model_selected")
    expect(types).toContain("tool_call")
    expect(types).toContain("agent_loop_finished")
  })

  test("agent loop records token usage events", async () => {
    const oldCostMode = process.env.ORCANA_COST_MODE
    process.env.ORCANA_COST_MODE = "strict"
    const cwd = mkdtempSync(join(tmpdir(), "dscode-trace-"))
    const trace = AgentRunTrace.start(cwd, "cache")

    try {
      for await (const _event of agentLoop("cache", {
        provider: new TraceUsageProvider(),
        model: "test",
        tools: [],
        maxRounds: 1,
        runTrace: trace,
      })) {
        // drain
      }
    } finally {
      restoreEnv("ORCANA_COST_MODE", oldCostMode)
    }

    const lines = readFileSync(trace.file, "utf-8").trim().split("\n").map(line => JSON.parse(line))
    const modelEvents = lines.filter(line => line.type === "model_selected")
    expect(modelEvents.length).toBeGreaterThanOrEqual(1)
    expect(modelEvents[0].data.requestedModel).toBe("test")
    expect(modelEvents[0].data.route).toBe("configured_model")
    const cacheShapeEvents = lines.filter(line => line.type === "cache_prefix_shape")
    expect(cacheShapeEvents.length).toBeGreaterThanOrEqual(1)
    expect(cacheShapeEvents[0].data.sections.some((section: { kind: string }) => section.kind === "messages")).toBe(true)
    const tokenEvents = lines.filter(line => line.type === "token_usage")
    expect(tokenEvents.length).toBeGreaterThanOrEqual(2)
    expect(tokenEvents.some(event => event.data.cacheSource === "provider" && event.data.cacheHitRate === 90)).toBe(true)
  })
})
