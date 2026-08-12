import { describe, expect, test } from "bun:test"
import { ScriptedProvider } from "../../evals/harness/scripted-provider"
import type { ProviderScriptEvent } from "../../evals/harness/contracts"
import type { StreamEvent } from "../../src/provider/types"
import { RetryCoordinator } from "../../src/runtime/retry/coordinator"
import { createRetryLedger } from "../../src/runtime/retry-ledger"

// H12: ScriptedProvider — purpose routing, round boundaries, error variants,
// usage semantics, idle hang abort.

async function drain(provider: ScriptedProvider, purpose?: string, retryCoordinator?: RetryCoordinator): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of provider.streamChat({ purpose, retryCoordinator } as never)) {
    events.push(event)
  }
  return events
}

describe("ScriptedProvider", () => {
  test("consumes untagged events for agent_main with round_end boundary", async () => {
    const script: ProviderScriptEvent[] = [
      { type: "usage", input: 100, output: 20 },
      { type: "tool_call", name: "probe", input: { q: 1 } },
      { type: "round_end" },
      { type: "text", data: "final" },
      { type: "round_end" },
    ]
    const provider = new ScriptedProvider(script)
    const round1 = await drain(provider)
    expect(round1).toHaveLength(2)
    expect(round1[0]!.type).toBe("token_usage")
    expect((round1[0] as { data: { cacheSource: string } }).data.cacheSource).toBe("provider")
    const call = round1[1] as { data: { id: string; name: string; input: unknown } }
    expect(call.data.name).toBe("probe")
    expect(call.data.id).toMatch(/^script-call-/)
    const round2 = await drain(provider)
    expect(round2).toHaveLength(1)
    expect(round2[0]).toMatchObject({ type: "text", data: "final" })
  })

  test("purpose-tagged events route to that purpose only", async () => {
    const script: ProviderScriptEvent[] = [
      { type: "text", data: "main text" },
      { type: "round_end" },
      { type: "text", data: "{\"mode\":\"plan\"}", purpose: "flash_triage" },
      { type: "round_end", purpose: "flash_triage" },
    ]
    const provider = new ScriptedProvider(script)
    const main = await drain(provider)
    expect(main[0]).toMatchObject({ type: "text", data: "main text" })
    const triage = await drain(provider, "flash_triage")
    expect(triage[0]).toMatchObject({ type: "text", data: "{\"mode\":\"plan\"}" })
    // Main script not consumed by the triage call.
    const mainAgain = await drain(provider)
    expect(mainAgain).toEqual([])
  })

  test("unknown purposes get a trivial fallback without consuming the script", async () => {
    const script: ProviderScriptEvent[] = [{ type: "text", data: "main" }, { type: "round_end" }]
    const provider = new ScriptedProvider(script)
    const triage = await drain(provider, "completion_judge")
    expect(triage[0]).toMatchObject({ type: "text", data: "ok" })
    const main = await drain(provider)
    expect(main[0]).toMatchObject({ type: "text", data: "main" })
  })

  test("flash_triage fallback returns a simple mode decision", async () => {
    const provider = new ScriptedProvider([])
    const triage = await drain(provider, "flash_triage")
    const text = triage[0] as { data: string }
    expect(JSON.parse(text.data).mode).toBe("simple")
  })

  test("error variants map to provider error events", async () => {
    const provider = new ScriptedProvider([
      { type: "error", errorType: "non_retryable", message: "auth: invalid api key" },
      { type: "round_end" },
    ])
    const events = await drain(provider)
    expect(events[0]).toMatchObject({ type: "error" })
    expect((events[0] as { data: string }).data).toContain("auth")
  })

  test("retryable error with coordinator permit retries inside the same streamChat (IC04 §34)", async () => {
    const provider = new ScriptedProvider([
      { type: "error", errorType: "retryable", message: "stream interrupted" },
      { type: "text", data: "complete summary" },
      { type: "round_end" },
    ])
    const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 10 })
    const events = await drain(provider, undefined, coordinator)
    expect(events.map((e) => e.type)).not.toContain("error")
    expect(events.map((e) => e.type)).not.toContain("finish")
    expect(events.some((e) => e.type === "status")).toBe(true)
    expect(events.some((e) => e.type === "text" && e.data === "complete summary")).toBe(true)
    // 1 retry authorization (no wrapper here, so no initial-side authorize).
    expect(coordinator.physicalProviderRequests).toBe(1)
  })

  test("retryable error denied by coordinator terminates with structured transport_failure (IC04 §37)", async () => {
    const provider = new ScriptedProvider([
      { type: "error", errorType: "retryable", message: "stream interrupted" },
      { type: "error", errorType: "retryable", message: "stream interrupted again" },
      { type: "text", data: "never" },
      { type: "round_end" },
    ])
    const coordinator = new RetryCoordinator({ ledger: createRetryLedger(), maxPhysicalProviderRequests: 1 })
    const events = await drain(provider, undefined, coordinator)
    expect(events.some((e) => e.type === "error")).toBe(true)
    const finish = events.find((e) => e.type === "finish") as { data: { finishReason: string } } | undefined
    expect(finish?.data.finishReason).toBe("transport_failure")
    // Deny stops consumption: the later script events must not surface.
    expect(events.some((e) => e.type === "text")).toBe(false)
  })

  test("idle_timeout hangs until the iterator is closed", async () => {
    const provider = new ScriptedProvider([{ type: "idle_timeout" }, { type: "round_end" }])
    const iterator = provider.streamChat({} as never)[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value.type).toBe("status")
    // Close the generator — the hanging await is abandoned cleanly.
    await iterator.return?.(undefined)
  })
})
