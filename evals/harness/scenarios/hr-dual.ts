/** H12 dual-run scenarios (HR-021/022/024) — independent-harness sanity.
 *
 *  R1 (Harness Closure): these are INDEPENDENT-harness sanity checks, NOT
 *  shared-process isolation tests: each side gets its OWN ScriptedProvider,
 *  its own temp workspace and its own AgentHarness; the probe result is
 *  static. Real shared-process isolation (shared permission config, one
 *  process, two runs) is covered by tests/harness_run_isolation.test.ts (H3)
 *  and tests/harness-replay/shared-process-isolation.test.ts (R1).
 */

import type { RunReplayCase } from "../contracts"
import type { ToolScriptResult } from "../contracts"

// The isolation probe returns a STATIC marker — the probe does not read
// plan/mode stores (that is H3's real shared-process coverage).
const ISOLATION_TOOL: ToolScriptResult[] = [{
  toolName: "isolation_probe",
  steps: [
    {
      content: "probe",
      success: true,
      metadata: { isolation: "probe-static" },
    },
  ],
}]

export const HR_DUAL_CASES: RunReplayCase[] = [
  {
    caseId: "HR-021",
    title: "独立 Harness 并行 sanity：两个 Run 均可完成",
    description: "INDEPENDENT-harness sanity (not shared-process isolation): two harnesses, two providers, two workspaces run concurrently via runReplayPair and both complete. Real plan-state isolation: tests/harness_run_isolation.test.ts (H3).",
    input: { prompt: "isolate", maxRounds: 2 },
    initialWorkspace: {},
    providerScript: [
      { type: "usage", input: 100, output: 20 },
      { type: "tool_call", name: "isolation_probe", input: { op: "set_plan" } },
      { type: "round_end" },
      { type: "text", data: "done" },
      { type: "round_end" },
    ],
    toolScript: ISOLATION_TOOL,
    expected: {
      outcome: { kind: "completed" },
      events: [{ type: "tool.call.completed", count: 1 }],
      artifacts: { minCount: 0 },
      workspace: {},
    },
  },
  {
    caseId: "HR-022",
    title: "独立 Harness 并行 sanity：Mode 各自独立",
    description: "INDEPENDENT-harness sanity: run A activates a mode in its tool; run B's mode store stays untouched. Real mode isolation: tests/harness_run_isolation.test.ts (H3).",
    input: { prompt: "isolate", maxRounds: 2 },
    initialWorkspace: {},
    providerScript: [
      { type: "usage", input: 100, output: 20 },
      { type: "tool_call", name: "isolation_probe", input: { op: "set_mode" } },
      { type: "round_end" },
      { type: "text", data: "done" },
      { type: "round_end" },
    ],
    toolScript: ISOLATION_TOOL,
    expected: {
      outcome: { kind: "completed" },
      events: [{ type: "tool.call.completed", count: 1 }],
      artifacts: { minCount: 0 },
      workspace: {},
    },
  },
  {
    caseId: "HR-024",
    title: "独立 Harness：取消 Run A 不影响 Run B",
    description: "INDEPENDENT-harness sanity: run A hangs (idle_timeout) and gets cancelled; run B completes normally. Real shared-process cancellation: tests/harness_run_isolation.test.ts (H3).",
    input: { prompt: "hang or finish", maxRounds: 3 },
    initialWorkspace: {},
    providerScript: [
      { type: "usage", input: 100, output: 20 },
      { type: "tool_call", name: "baseline_probe", input: {} },
      { type: "round_end" },
      { type: "text", data: "finished" },
      { type: "round_end" },
    ],
    expected: {
      outcome: { kind: "completed" },
      events: [{ type: "tool.call.completed", count: 1 }],
      artifacts: { minCount: 0 },
      workspace: {},
    },
  },
]
