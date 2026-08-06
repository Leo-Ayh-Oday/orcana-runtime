/** RC-05：B4 ripple gate 独立于 cache / B5 MCP 能力默认不安全。 */

import { describe, expect, test } from "bun:test"
import { RippleToolFilterGate } from "../src/agent/gates/pre-round"

function rippleCtx(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    cacheStableTools: true,
    rippleBlockActive: false,
    rippleReports: [],
    pendingRippleObligations: [],
    tools: [
      { defn: { isReadonly: false, name: "write_file" } },
      { defn: { isReadonly: true, name: "read_file" } },
    ],
    activeTools: [],
    ...overrides,
  } as never
}

describe("RC-05 B4 ripple gate independent of cache", () => {
  test("cacheStableTools=true does not disable ripple block", () => {
    const gate = new RippleToolFilterGate()
    const ctx = rippleCtx({
      rippleReports: [{ decision: "block", targetFile: "a.ts" }],
    })
    const result = gate.evaluate(ctx as never)
    expect(result.pass).toBe(true)
    expect((ctx as Record<string, unknown>).rippleBlockActive).toBe(true)
    const tools = (ctx as Record<string, unknown>).tools as Array<{ defn: { isReadonly: boolean } }>
    expect(tools.every(t => t.defn.isReadonly)).toBe(true)
  })

  test("no ripple block with cache on → tools untouched", () => {
    const gate = new RippleToolFilterGate()
    const ctx = rippleCtx()
    gate.evaluate(ctx as never)
    expect((ctx as Record<string, unknown>).rippleBlockActive).toBe(false)
    const tools = (ctx as Record<string, unknown>).tools as unknown[]
    expect(tools.length).toBe(2)
  })
})
