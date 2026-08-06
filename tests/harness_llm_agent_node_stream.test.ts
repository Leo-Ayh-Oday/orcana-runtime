/** M21 acceptance: LLM_NODE_STREAM_AND_USAGE_COMPLETE.
 *
 *  LlmAgentNode must ACCUMULATE text chunks (append, not overwrite) and
 *  count modelCalls/toolCalls/wallTime — a multi-chunk scripted provider
 *  (3 text chunks + 2 tool calls across 3 rounds) must produce the full
 *  concatenated output.text and exact usage.
 */

import { describe, expect, test } from "bun:test"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { buildTools, Result } from "../src/tools/registry"
import { createLlmAgentNode } from "../src/harness/nodes/llm-agent-node"
import { createNodeExecutionContext } from "../src/harness/nodes/context"
import { runNodeToResult } from "../src/harness/nodes/run"
import { createCapabilityRegistry } from "../src/harness/capabilities/registry"
import { registerToolCapabilities } from "../src/harness/capabilities/tool-adapter"
import { assembleRunScope } from "../src/harness/runtime/run-scope"
import { createBudgetLedger, mergeRunBudget } from "../src/harness/runtime/budget-ledger"
import type { AgentRun } from "../src/harness/contracts/run"
import type { AgentNodeOutput, NodeEvent, NodeResult } from "../src/harness/contracts/nodes"

const SAVED_FLASH_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
process.env.ORCANA_FLASH_TRIAGE = "off"

/** 3 provider rounds: r0 tool call, r1 text+tool call, r2 two text chunks —
 *  the text stream arrives as 3 chunks that must be CONCATENATED. */
class MultiChunkProvider implements LLMProvider {
  rounds = 0
  async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    const r = this.rounds++
    yield { type: "token_usage", data: { inputTokens: 50 + r * 10, outputTokens: 5 + r * 2, cacheSource: "provider", round: r } }
    if (r === 0) {
      yield { type: "tool_call", data: { id: "p-1", name: "baseline_probe", input: { q: 1 } } }
      return
    }
    if (r === 1) {
      yield { type: "text", data: "chunk-1 " }
      yield { type: "tool_call", data: { id: "p-2", name: "baseline_probe", input: { q: 2 } } }
      return
    }
    yield { type: "text", data: "chunk-2 " }
    yield { type: "text", data: "chunk-3" }
  }
}

function probeTool() {
  return buildTools({
    name: "baseline_probe",
    description: "probe",
    isReadonly: true,
    isConcurrencySafe: true,
    inputSchema: { type: "object", properties: {}, required: [] },
    execute() {
      return Result.ok("ok")
    },
  })
}

const PROMPT = "Read only: probe and summarize. Do not edit."

async function runNode(): Promise<{ events: NodeEvent[]; result: NodeResult<AgentNodeOutput> }> {
  const projectRoot = "/tmp/h11-m21-stream"
  const runId = "run-m21"
  const controller = new AbortController()
  const scope = assembleRunScope({ runId, sessionId: "sess-m21", projectRoot, controller })
  const run: AgentRun = {
    runId,
    sessionId: "sess-m21",
    status: "running",
    input: { prompt: PROMPT, maxRounds: 3 },
    scope,
    budget: createBudgetLedger(mergeRunBudget(undefined)),
    createdAt: Date.now(),
    eventSequence: 0,
    schemaVersion: 1,
  }
  const capabilities = createCapabilityRegistry()
  registerToolCapabilities(capabilities, probeTool())
  const context = createNodeExecutionContext({ run, capabilities })
  const node = createLlmAgentNode({ id: "agent", deps: { provider: new MultiChunkProvider(), tools: probeTool() } })
  const { events, result } = await runNodeToResult(node, context, { prompt: PROMPT, maxRounds: 3 })
  return { events, result }
}

describe("M21: LlmAgentNode stream + usage complete", () => {
  test("3 text chunks are CONCATENATED into the full output.text", async () => {
    const { result } = await runNode()
    expect(result.status).toBe("succeeded")
    expect(result.output?.text).toBe("chunk-1 chunk-2 chunk-3")
  })

  test("usage counts modelCalls, toolCalls and wallTime exactly", async () => {
    const { result } = await runNode()
    const usage = result.output?.usage
    expect(usage?.modelCalls).toBe(3) // 3 provider rounds
    expect(usage?.toolCalls).toBe(2) // 2 bridged tool calls
    // kernel token_usage 是每轮累积快照（r0: 50/5, r1: 110/12, r2: 180/21）——
    // 取最后一个快照即总量
    expect(usage?.inputTokens).toBe(180)
    expect(usage?.outputTokens).toBe(21)
    expect(usage?.wallTimeMs).toBeGreaterThanOrEqual(0)
    // 事件流携带同样的 usage（node.usage 事件实时反映计数）
  })

  test("node.usage events carry the accumulated counters", async () => {
    const { events } = await runNode()
    const usageEvents = events.filter(e => e.type === "node.usage")
    expect(usageEvents.length).toBe(3)
    const last = (usageEvents[usageEvents.length - 1] as { usage: { modelCalls: number; toolCalls: number } }).usage
    expect(last.modelCalls).toBe(3)
    expect(last.toolCalls).toBe(2)
  })
})
