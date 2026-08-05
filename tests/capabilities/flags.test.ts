import { afterEach, describe, expect, test } from "bun:test"
import {
  CAPABILITY_MODE_DEFAULT,
  getCapabilityMode,
  isEnabledMode,
  isShadowMode,
} from "../../src/harness/capabilities/flags"
import { createCapabilityRegistry } from "../../src/harness/capabilities/registry"
import { executeCapability } from "../../src/harness/capabilities/executor"
import { createCapabilityDescriptor, TOOL_OUTPUT_SCHEMA } from "../../src/harness/capabilities/descriptor"
import { projectCapabilityDescriptor, toolCapabilityHandler } from "../../src/harness/capabilities/tool-adapter"
import { buildTools, Result } from "../../src/tools/registry"
import type { HarnessEventType } from "../../src/harness/contracts/events"

// RT-2: capability mode flag + shadow divergence observation.

const SAVED_MODE = process.env.ORCANA_CAPABILITIES_MODE
afterEach(() => {
  if (SAVED_MODE === undefined) delete process.env.ORCANA_CAPABILITIES_MODE
  else process.env.ORCANA_CAPABILITIES_MODE = SAVED_MODE
})

describe("RT-2 capability mode flag", () => {
  test("defaults to legacy", () => {
    delete process.env.ORCANA_CAPABILITIES_MODE
    expect(getCapabilityMode({})).toBe("legacy")
    expect(CAPABILITY_MODE_DEFAULT).toBe("legacy")
  })

  test("accepts the three ladder modes", () => {
    for (const mode of ["legacy", "shadow", "enabled"] as const) {
      expect(getCapabilityMode({ ORCANA_CAPABILITIES_MODE: mode })).toBe(mode)
    }
  })

  test("unknown values fall back to legacy (fail closed, never silently enabled)", () => {
    for (const bogus of ["", "on", "true", "ENABLED", "production"]) {
      expect(getCapabilityMode({ ORCANA_CAPABILITIES_MODE: bogus })).toBe("legacy")
    }
  })

  test("shadow helpers", () => {
    // shadow AND enabled both record divergence observations.
    expect(isShadowMode("shadow")).toBe(true)
    expect(isShadowMode("enabled")).toBe(true)
    expect(isShadowMode("legacy")).toBe(false)
    expect(isEnabledMode("enabled")).toBe(true)
    expect(isEnabledMode("shadow")).toBe(false)
    expect(isEnabledMode("legacy")).toBe(false)
  })
})

describe("RT-2 shadow mismatch observation", () => {
  /** A tool whose result violates the shared TOOL_OUTPUT_SCHEMA shape. */
  function schemaViolatingTool() {
    return buildTools({
      name: "schema_bad",
      description: "returns a result that fails output schema",
      isReadonly: true,
      inputSchema: { type: "object", properties: {}, required: [] },
      execute() {
        // { ok, output } shape — missing success/content.
        return { ok: true, output: "shaped wrong" } as never
      },
    })[0]!
  }

  async function runWithMode(mode: string | undefined): Promise<{ events: Array<{ type: HarnessEventType; payload: unknown }>; content: string }> {
    const tool = schemaViolatingTool()
    const registry = createCapabilityRegistry()
    registry.register(
      projectCapabilityDescriptor(tool),
      toolCapabilityHandler(tool),
    )
    const events: Array<{ type: HarnessEventType; payload: unknown }> = []
    const policyDecision = { allowed: true, reason: "", source: "test", priority: 0, blockMessage: "" } as never
    const result = await executeCapability(registry, {
      capabilityId: "schema_bad",
      params: {},
      tool,
      policyDecision,
      emit: (type, payload) => events.push({ type, payload }),
    })
    return { events, content: result.result.content }
  }

  test("legacy (default): schema violation blocks the result, no mismatch event", async () => {
    process.env.ORCANA_CAPABILITIES_MODE = "legacy"
    const { events, content } = await runWithMode("legacy")
    expect(content).toContain("failed schema validation")
    expect(events.some((e) => e.type === "capability.shadow_mismatch")).toBe(false)
  })

  test("enabled: schema violation blocks (authoritative)", async () => {
    process.env.ORCANA_CAPABILITIES_MODE = "enabled"
    const { content } = await runWithMode("enabled")
    expect(content).toContain("failed schema validation")
  })

  test("shadow: mismatch recorded, result left as produced (observe only)", async () => {
    process.env.ORCANA_CAPABILITIES_MODE = "shadow"
    const { events, content } = await runWithMode("shadow")
    const mismatch = events.find((e) => e.type === "capability.shadow_mismatch")
    expect(mismatch).toBeDefined()
    const payload = mismatch!.payload as { capabilityId: string; check: string; errors: string[] }
    expect(payload.capabilityId).toBe("schema_bad")
    expect(payload.check).toBe("output_schema")
    expect(payload.errors.length).toBeGreaterThan(0)
    // The shadow never disturbs: the raw tool output is untouched.
    expect(String(content ?? "")).not.toContain("failed schema validation")
  })

  test("ToolDef-projected capabilities are marked legacy source", () => {
    const tool = buildTools({
      name: "marker",
      description: "x",
      isReadonly: true,
      inputSchema: { type: "object", properties: {}, required: [] },
      execute: () => Result.ok("ok"),
    })[0]!
    expect(projectCapabilityDescriptor(tool).source).toBe("legacy")
  })
})
