/** PR-10.1 — RunTrace event taxonomy: classification, canonical set,
 *  unknown-type discoverability and summaries. */

import { describe, expect, test } from "bun:test"
import {
  classifyTraceEvent,
  isKnownTraceEvent,
  summarizeTrace,
  TRACE_EVENT_CATEGORIES,
  type TraceEventCategory,
} from "../src/telemetry/taxonomy"

describe("trace event taxonomy", () => {
  test("lifecycle events classify", () => {
    expect(classifyTraceEvent("run_started")).toBe("lifecycle")
    expect(classifyTraceEvent("round_finished")).toBe("lifecycle")
    expect(classifyTraceEvent("run_aborted")).toBe("lifecycle")
  })

  test("tool / model / gate / verification events classify", () => {
    expect(classifyTraceEvent("tool_call")).toBe("tool")
    expect(classifyTraceEvent("tool_result")).toBe("tool")
    expect(classifyTraceEvent("token_usage")).toBe("model")
    expect(classifyTraceEvent("model_selected")).toBe("model")
    expect(classifyTraceEvent("gate_decision")).toBe("gate")
    expect(classifyTraceEvent("permission_decision")).toBe("gate")
    expect(classifyTraceEvent("verification_result")).toBe("verification")
    expect(classifyTraceEvent("evidence_ingested")).toBe("evidence")
    expect(classifyTraceEvent("workflow_node_finished")).toBe("workflow")
    expect(classifyTraceEvent("error")).toBe("error")
    expect(classifyTraceEvent("quota_blocked")).toBe("error")
  })

  test("unknown types land in internal (discoverability)", () => {
    expect(classifyTraceEvent("mystery_event_42")).toBe("internal")
    expect(isKnownTraceEvent("tool_call")).toBe(true)
    expect(isKnownTraceEvent("mystery_event_42")).toBe(false)
  })

  test("summarize counts categories and lists unknown types", () => {
    const summary = summarizeTrace([
      { type: "run_started" },
      { type: "tool_call" },
      { type: "tool_result" },
      { type: "token_usage" },
      { type: "totally_new_event" },
      { type: "totally_new_event" },
    ])
    expect(summary.total).toBe(6)
    expect(summary.byCategory.lifecycle).toBe(1)
    expect(summary.byCategory.tool).toBe(2)
    expect(summary.byCategory.model).toBe(1)
    expect(summary.byCategory.internal).toBe(2)
    expect(summary.unknownTypes).toEqual(["totally_new_event"])
  })

  test("category set is finite and labels exist for all", () => {
    expect(TRACE_EVENT_CATEGORIES).toHaveLength(9)
    for (const category of TRACE_EVENT_CATEGORIES) {
      expect((classifyTraceEvent(category) as TraceEventCategory).length).toBeGreaterThan(0)
    }
  })

  test("canonical event table covers all categories", () => {
    const { CANONICAL_TRACE_EVENTS } = require("../src/telemetry/taxonomy") as typeof import("../src/telemetry/taxonomy")
    for (const category of TRACE_EVENT_CATEGORIES) {
      expect(CANONICAL_TRACE_EVENTS[category].length).toBeGreaterThan(0)
      for (const type of CANONICAL_TRACE_EVENTS[category]) {
        expect(classifyTraceEvent(type)).toBe(category)
      }
    }
  })
})
