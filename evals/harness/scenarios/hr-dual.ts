/** H12 dual-run scenarios (HR-021/022/024) — isolation & cancellation.
 *
 *  Each side gets its OWN ScriptedProvider instance (no cursor sharing) and
 *  its own temp workspace; isolation is asserted via the tool scripts.
 */

import type { RunReplayCase } from "../contracts"
import type { ToolScriptResult } from "../contracts"

// The isolation probe tool captures per-run facts through the runtime
// execution context and returns them in its output.
const ISOLATION_TOOL: ToolScriptResult[] = [{
  toolName: "isolation_probe",
  steps: [
    {
      content: "probe",
      success: true,
      metadata: { isolation: "{{RUN_SCOPE}}" },
    },
  ],
}]

export const HR_DUAL_CASES: RunReplayCase[] = [
  {
    caseId: "HR-021",
    title: "两个 Run 的 Plan 不串扰",
    description: "run A activates a plan in its tool; run B's plan state stays untouched (dual-run via runReplayPair)",
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
    title: "两个 Run 的 Mode 不串扰",
    description: "run A switches mode inside its tool; run B stays in the default mode",
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
    title: "取消 Run A 不影响 Run B",
    description: "run A hangs (idle_timeout) and gets cancelled; run B completes normally (dual-run via runReplayPair)",
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
